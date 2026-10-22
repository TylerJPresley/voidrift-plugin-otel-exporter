/**
 * The OpenTelemetry `ObsExporter` (otel-exporter-blueprint §2, §5, §7).
 *
 * Owns a `BatchSpanProcessor` wrapping an `OTLPTraceExporter` and an OTel `Resource`.
 * `export` maps a masked `ObsRecord` to a span (§3, §4) and enqueues it on the
 * processor, then returns immediately — export is best-effort and non-blocking
 * (§5, invariant §9.1#6). `flush` drains the batch via `forceFlush`; `shutdown`
 * releases the transport. A throwing map or enqueue is swallowed and logged, so a
 * bad record never crashes the session (the core also isolates it, §7, core §10.8).
 */
import { diag } from "@opentelemetry/api";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ObsExporter, ObsRecord } from "./obs-record.js";
import { recordToSpan } from "./mapping.js";

const SCOPE_NAME = "@voidrift/plugin-otel-exporter";

/** Resolved exporter configuration (otel-exporter-blueprint §6). */
export interface OtelExporterConfig {
  endpoint: string;
  protocol: "http" | "grpc";
  headers: Record<string, string>;
  serviceName: string;
  resourceAttributes: Record<string, string>;
}

/** The host-supplied config shape (§6; FX-C2). `headerEnv` names, per header, the
 * env var holding a SECRET header value (e.g. `{ "Authorization": "OTEL_AUTH_HEADER" }`),
 * resolved from `process.env` at use time — so a credential never lives in config.
 * A literal in `headers` that names a secret header is flagged by doctor. */
export interface OtelExporterOptionsConfig extends Partial<OtelExporterConfig> {
  headerEnv?: Record<string, string>;
}

/** The blueprint §6 defaults, applied over partial config. */
export const DEFAULT_CONFIG: OtelExporterConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  headers: {},
  serviceName: "voidrift",
  resourceAttributes: {},
};

/**
 * Merge partial config over the §6 defaults, resolving `headerEnv` from `env` at
 * use time (FX-C2). A `headerEnv` entry whose env var is absent is skipped (the
 * header is simply not sent) rather than throwing. Resolved `headerEnv` values
 * override any literal `headers` entry of the same name.
 */
export function resolveConfig(
  partial?: OtelExporterOptionsConfig,
  env: Record<string, string | undefined> = process.env,
  isMetadataHost: (host: string) => boolean = () => false,
): OtelExporterConfig {
  const endpoint = partial?.endpoint ?? DEFAULT_CONFIG.endpoint;
  validateEndpoint(endpoint, "otelExporter.endpoint", isMetadataHost);
  const headers: Record<string, string> = { ...(partial?.headers ?? DEFAULT_CONFIG.headers) };
  for (const [name, envVar] of Object.entries(partial?.headerEnv ?? {})) {
    const value = env[envVar];
    if (value) headers[name] = value;
    else delete headers[name];
  }
  return {
    endpoint,
    protocol: partial?.protocol ?? DEFAULT_CONFIG.protocol,
    headers,
    serviceName: partial?.serviceName ?? DEFAULT_CONFIG.serviceName,
    resourceAttributes: partial?.resourceAttributes ?? DEFAULT_CONFIG.resourceAttributes,
  };
}

/** Loopback hosts for which plaintext `http:` is allowed (§5, security). */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Validate a collector endpoint before any span leaves the process (audit C4).
 * GenAI spans carry pre-masked model input/output, so they must not travel in
 * plaintext to a remote host: `http:` is allowed only for a loopback host, and
 * every non-loopback endpoint must be `https:`. Credentials embedded in the URL
 * (`user:pass@host`) are rejected — credentials belong in `headers`, never the
 * URL. The error names the config `key` but NEVER echoes the URL or its
 * userinfo, so a secret in a misconfigured endpoint is not leaked into logs or
 * notifications.
 */
export function validateEndpoint(
  endpoint: string,
  key: string,
  isMetadataHost: (host: string) => boolean = () => false,
): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`${key} is not a valid URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${key} must not contain credentials in the URL; put them in headers`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isMetadataHost(host)) {
    // Naming the metadata host is safe (it is not a secret) and makes the refusal
    // actionable; the URL path/userinfo is never echoed (audit C4).
    throw new Error(`${key} ${host} is a cloud instance-metadata address; refusing to send telemetry there`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return;
    throw new Error(`${key} must use https for a non-loopback collector (plaintext http is allowed only on loopback)`);
  }
  throw new Error(`${key} must use http (loopback only) or https`);
}

/** Build the OTel `Resource` from `serviceName` + extra attributes (§6). */
function buildResource(config: OtelExporterConfig): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...config.resourceAttributes,
  });
}

/**
 * Build the default `BatchSpanProcessor` over an `OTLPTraceExporter`. The HTTP
 * transport is used for `protocol: http`; `protocol: grpc` selects the gRPC
 * transport, kept behind the same `SpanProcessor` seam so the exporter body is
 * transport-agnostic (§5, §6). Only the HTTP transport is wired here; a gRPC
 * deployment injects its processor through the test/host seam.
 *
 * The underlying OTLP exporter is returned ALONGSIDE the processor so `flush`
 * can await it directly: `BatchSpanProcessor.forceFlush()` hands the batch to the
 * exporter's `export()` but resolves before the HTTP request has drained, so a
 * short-lived process can exit with the request still in flight (FX-C). Awaiting
 * the OTLP exporter's own `forceFlush()` after the processor's blocks until the
 * pending request completes (or the exporter's own timeout fires).
 */
function buildProcessor(config: OtelExporterConfig): { processor: SpanProcessor; flushTransport?: () => Promise<void> } {
  const otlp = new OTLPTraceExporter({
    url: config.endpoint,
    headers: config.headers,
  });
  // Track the OTLP exporter's in-flight sends. `SpanExporter.export(spans, cb)`
  // invokes `cb` only once the HTTP request has COMPLETED (or failed), while
  // `BatchSpanProcessor.forceFlush()` and `OTLPTraceExporter.forceFlush()` both
  // resolve BEFORE that — the FX-C root cause (a short process exits with the
  // request still in flight). We wrap `export` so every send's completion is a
  // tracked promise, and `flushTransport` awaits all of them — so `flush` blocks
  // until the body has actually drained to the collector.
  const inflight = new Set<Promise<void>>();
  const realExport = otlp.export.bind(otlp);
  (otlp as unknown as { export: typeof realExport }).export = (spans, resultCallback) => {
    let settle: () => void = () => {};
    const done = new Promise<void>((r) => (settle = r));
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
    realExport(spans, (result) => {
      try {
        resultCallback(result);
      } finally {
        settle();
      }
    });
  };
  return {
    processor: new BatchSpanProcessor(otlp),
    flushTransport: async () => {
      await otlp.forceFlush();
      await Promise.allSettled([...inflight]);
    },
  };
}

/** Upper bound on an exporter flush/shutdown so a stalled receiver cannot hang
 * the process teardown (FX-C, core §10.8). */
const FLUSH_CAP_MS = 5_000;

/** Resolve `p` or, after `ms`, resolve anyway — so an in-flight send that never
 * answers delays exit by at most the cap, never indefinitely. Never rejects. */
async function withCap<T>(p: Promise<T>, ms: number): Promise<void> {
  await Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((r) => setTimeout(r, ms)),
  ]);
}

export interface OtelObsExporterDeps {
  /** The span processor; defaults to a BatchSpanProcessor over OTLP/HTTP (§5). */
  processor?: SpanProcessor;
  /** The OTel resource; defaults to one built from config (§6). */
  resource?: Resource;
  /** An extra drain awaited after `processor.forceFlush()` — the OTLP transport's
   * own `forceFlush()`, so `flush` blocks until the HTTP request completes (FX-C).
   * Defaults to the real transport's flush; a test injecting a `processor` whose
   * own flush already awaits the send leaves this undefined. */
  flushTransport?: () => Promise<void>;
}

/** The exporter the plugin registers through `core.register.exporter` (§2). */
export class OtelObsExporter implements ObsExporter {
  private readonly processor: SpanProcessor;
  private readonly resource: Resource;
  private readonly flushTransport: (() => Promise<void>) | undefined;

  constructor(config: OtelExporterConfig, deps: OtelObsExporterDeps = {}) {
    this.resource = deps.resource ?? buildResource(config);
    if (deps.processor) {
      this.processor = deps.processor;
      this.flushTransport = deps.flushTransport;
    } else {
      const built = buildProcessor(config);
      this.processor = built.processor;
      this.flushTransport = deps.flushTransport ?? built.flushTransport;
    }
  }

  /** Map a masked record to a span and enqueue it; never throws (§5, §7). */
  export(record: ObsRecord): void {
    try {
      const span = recordToSpan(record, this.resource, SCOPE_NAME);
      this.processor.onEnd(span);
    } catch (e) {
      // Isolate a bad record: log and continue. The local trail is the core's and
      // is written regardless (§7, invariant §9.1#5).
      diag.warn(`@voidrift/plugin-otel-exporter: dropped a record on export: ${String(e)}`);
    }
  }

  /**
   * Drain the batch to the collector before shutdown (§5, core §10.8). First
   * flush the batch processor (which hands the batch to the OTLP transport), then
   * await the transport's own `forceFlush()` so this resolves only after the HTTP
   * request has actually completed — never while it is still in flight (FX-C). A
   * stalled receiver is bounded by the 5 s cap; a dead receiver fails fast. Never
   * throws.
   */
  async flush(): Promise<void> {
    try {
      await withCap(this.processor.forceFlush(), FLUSH_CAP_MS);
      if (this.flushTransport) await withCap(this.flushTransport(), FLUSH_CAP_MS);
    } catch (e) {
      diag.warn(`@voidrift/plugin-otel-exporter: flush failed: ${String(e)}`);
    }
  }

  /** Release the transport on process teardown (§5). Bounded by the 5 s cap. */
  async shutdown(): Promise<void> {
    try {
      await withCap(this.processor.shutdown(), FLUSH_CAP_MS);
    } catch (e) {
      diag.warn(`@voidrift/plugin-otel-exporter: shutdown failed: ${String(e)}`);
    }
  }
}
