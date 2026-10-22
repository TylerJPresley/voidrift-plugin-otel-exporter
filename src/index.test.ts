/**
 * Offline integration tests (otel-exporter-blueprint §9). An `InMemorySpanExporter`
 * is the OTLP target, so no network is touched — a `BatchSpanProcessor` over it
 * holds spans until `forceFlush`, exactly as the real transport batches (§5). The
 * tests assert the §3 mapping, §4 nesting/determinism, flush draining, failure
 * isolation, and the §2 registration.
 */
import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OtelObsExporter, resolveConfig } from "./exporter.js";
import { deriveOtelId } from "./mapping.js";
import { register } from "./index.js";
import type { ObsRecord } from "./obs-record.js";

function harness(): { exporter: OtelObsExporter; mem: InMemorySpanExporter } {
  const mem = new InMemorySpanExporter();
  const processor = new BatchSpanProcessor(mem);
  const exporter = new OtelObsExporter(resolveConfig({ serviceName: "voidrift-test" }), {
    processor,
    resource: resourceFromAttributes({ "service.name": "voidrift-test" }),
  });
  return { exporter, mem };
}

const modelRecord: ObsRecord = {
  traceId: "sess-1",
  spanId: "run-model",
  timestamp: "2026-01-01T00:00:00.000Z",
  durationMs: 120,
  status: "ok",
  source: "model",
  name: "model.call",
  severity: "info",
  attributes: { cost: 0.0042, temperature: 0.2 },
  model: { name: "gpt-4o", protocol: "openai" },
  usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, cacheReadTokens: 10 },
  input: "hello",
  output: "hi there",
};

describe("record → span mapping (§3)", () => {
  it("maps name, kind, status, timing, and voidrift.* attributes", async () => {
    const { exporter, mem } = harness();
    exporter.export(modelRecord);
    await exporter.flush();

    const spans = mem.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0] as ReadableSpan;
    expect(s.name).toBe("model.call");
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.status.code).toBe(SpanStatusCode.OK);
    expect(s.attributes["voidrift.source"]).toBe("model");
    expect(s.attributes["voidrift.severity"]).toBe("info");
    expect(s.attributes["voidrift.temperature"]).toBe(0.2);
    // startTime seconds = Unix seconds for the ISO timestamp; duration honored.
    expect(s.startTime[0]).toBe(Math.floor(Date.parse(modelRecord.timestamp) / 1000));
    expect(s.duration[0] * 1000 + s.duration[1] / 1e6).toBeCloseTo(120, 3);
  });

  it("emits already-masked prompt/completion events", async () => {
    const { exporter, mem } = harness();
    exporter.export(modelRecord);
    await exporter.flush();
    const s = mem.getFinishedSpans()[0] as ReadableSpan;
    const names = s.events.map((e) => e.name);
    expect(names).toContain("gen_ai.content.prompt");
    expect(names).toContain("gen_ai.content.completion");
  });
});

describe("GenAI semantics (§3, §9.1#3)", () => {
  it("sets model/usage/cost attributes on a model record", async () => {
    const { exporter, mem } = harness();
    exporter.export(modelRecord);
    await exporter.flush();
    const a = (mem.getFinishedSpans()[0] as ReadableSpan).attributes;
    expect(a["gen_ai.request.model"]).toBe("gpt-4o");
    expect(a["gen_ai.response.model"]).toBe("gpt-4o");
    expect(a["gen_ai.system"]).toBe("openai");
    expect(a["gen_ai.usage.input_tokens"]).toBe(100);
    expect(a["gen_ai.usage.output_tokens"]).toBe(40);
    expect(a["gen_ai.usage.total_tokens"]).toBe(140);
    expect(a["gen_ai.usage.cache_read.input_tokens"]).toBe(10);
    expect(a["gen_ai.usage.cost"]).toBe(0.0042);
    // cost is lifted onto its GenAI key, not duplicated under voidrift.*
    expect(a["voidrift.cost"]).toBeUndefined();
  });

  it("carries no gen_ai.* keys on a tool record", async () => {
    const { exporter, mem } = harness();
    const toolRecord: ObsRecord = {
      traceId: "sess-1",
      spanId: "run-tool",
      timestamp: "2026-01-01T00:00:01.000Z",
      status: "ok",
      source: "tool",
      name: "fs.read",
      severity: "info",
      attributes: { path: "/tmp/x" },
    };
    exporter.export(toolRecord);
    await exporter.flush();
    const a = (mem.getFinishedSpans()[0] as ReadableSpan).attributes;
    expect(Object.keys(a).some((k) => k.startsWith("gen_ai."))).toBe(false);
    expect(a["voidrift.path"]).toBe("/tmp/x");
  });

  it("omits total/cost when the record carries usage but no cost", async () => {
    const { exporter, mem } = harness();
    const unpriced: ObsRecord = {
      ...modelRecord,
      spanId: "run-unpriced",
      attributes: {},
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    };
    exporter.export(unpriced);
    await exporter.flush();
    const a = (mem.getFinishedSpans()[0] as ReadableSpan).attributes;
    expect(a["gen_ai.usage.total_tokens"]).toBe(7);
    expect(a["gen_ai.usage.cost"]).toBeUndefined();
    expect(a["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
  });
});

describe("trace- and span-context reconstruction (§4, §9.1#2)", () => {
  it("reproduces nesting across two records sharing a trace", async () => {
    const { exporter, mem } = harness();
    const tool: ObsRecord = {
      traceId: "sess-1",
      spanId: "run-tool",
      parentSpanId: "run-model",
      timestamp: "2026-01-01T00:00:01.000Z",
      durationMs: 5,
      status: "ok",
      source: "tool",
      name: "fs.read",
      severity: "info",
      attributes: {},
    };
    exporter.export(modelRecord);
    exporter.export(tool);
    await exporter.flush();

    const spans = mem.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const model = spans.find((s) => s.name === "model.call")!;
    const read = spans.find((s) => s.name === "fs.read")!;
    // Same session → same OTel trace id.
    expect(read.spanContext().traceId).toBe(model.spanContext().traceId);
    // The tool span's parent is the model span.
    expect(read.parentSpanContext?.spanId).toBe(model.spanContext().spanId);
    // A root record has no parent.
    expect(model.parentSpanContext).toBeUndefined();
  });

  it("derives the same OTel id for the same VoidRift id (deterministic)", () => {
    expect(deriveOtelId("sess-1", 16)).toBe(deriveOtelId("sess-1", 16));
    expect(deriveOtelId("sess-1", 16)).toHaveLength(32);
    expect(deriveOtelId("run-model", 8)).toHaveLength(16);
    expect(deriveOtelId("a", 16)).not.toBe(deriveOtelId("b", 16));
  });
});

describe("flush (§5, §9.1#6)", () => {
  it("drains only after forceFlush", async () => {
    const { exporter, mem } = harness();
    exporter.export(modelRecord);
    // BatchSpanProcessor holds the span until flush.
    expect(mem.getFinishedSpans()).toHaveLength(0);
    await exporter.flush();
    expect(mem.getFinishedSpans()).toHaveLength(1);
    await exporter.shutdown();
  });
});

describe("FX-C — flush awaits the underlying transport, not just the processor", () => {
  it("flush awaits the injected transport flush (the HTTP send completes before flush resolves)", async () => {
    const mem = new InMemorySpanExporter();
    const processor = new BatchSpanProcessor(mem);
    let transportDrained = false;
    const exporter = new OtelObsExporter(resolveConfig({ serviceName: "svc" }), {
      processor,
      resource: resourceFromAttributes({ "service.name": "svc" }),
      // Simulate the OTLP transport's own forceFlush: resolves only after a tick,
      // mirroring an in-flight HTTP send that drains after the processor flush.
      flushTransport: async () => {
        await new Promise((r) => setTimeout(r, 20));
        transportDrained = true;
      },
    });
    exporter.export(modelRecord);
    await exporter.flush();
    expect(mem.getFinishedSpans()).toHaveLength(1);
    expect(transportDrained).toBe(true);
  });

  it("a transport flush that never resolves is bounded by the 5 s cap (never hangs)", async () => {
    const mem = new InMemorySpanExporter();
    const processor = new BatchSpanProcessor(mem);
    const exporter = new OtelObsExporter(resolveConfig({ serviceName: "svc" }), {
      processor,
      resource: resourceFromAttributes({ "service.name": "svc" }),
      flushTransport: () => new Promise<void>(() => {}),
    });
    exporter.export(modelRecord);
    const start = Date.now();
    await exporter.flush();
    expect(Date.now() - start).toBeLessThan(5_500);
  }, 7_000);
});

describe("FX-C2 — headerEnv resolves secret header values from the environment", () => {
  it("resolves a headerEnv entry from env and omits it when the env var is absent", () => {
    const withEnv = resolveConfig(
      { headerEnv: { Authorization: "OTEL_AUTH_HEADER" } },
      { OTEL_AUTH_HEADER: "Bearer tok" },
    );
    expect(withEnv.headers["Authorization"]).toBe("Bearer tok");
    const missing = resolveConfig({ headerEnv: { Authorization: "OTEL_AUTH_HEADER" } }, {});
    expect(missing.headers["Authorization"]).toBeUndefined();
  });

  it("a headerEnv value overrides a literal header of the same name", () => {
    const resolved = resolveConfig(
      { headers: { Authorization: "literal" }, headerEnv: { Authorization: "OTEL_AUTH_HEADER" } },
      { OTEL_AUTH_HEADER: "Bearer env" },
    );
    expect(resolved.headers["Authorization"]).toBe("Bearer env");
  });
});

describe("masking + failure isolation (§7, §9.1#4/#5)", () => {
  it("maps a stable secret marker verbatim and runs no detector", async () => {
    const { exporter, mem } = harness();
    const masked: ObsRecord = {
      ...modelRecord,
      spanId: "run-masked",
      attributes: { token: "‹redacted:api_key›" },
    };
    exporter.export(masked);
    await exporter.flush();
    const a = (mem.getFinishedSpans()[0] as ReadableSpan).attributes;
    expect(a["voidrift.token"]).toBe("‹redacted:api_key›");
  });

  it("swallows a bad record without throwing", async () => {
    const { exporter, mem } = harness();
    // A timestamp that cannot parse falls back to now(); a thrower is isolated.
    const bad = { ...modelRecord, spanId: "run-bad", timestamp: "not-a-date" };
    expect(() => exporter.export(bad)).not.toThrow();
    await exporter.flush();
    expect(mem.getFinishedSpans()).toHaveLength(1);
  });
});

describe("registration (§2)", () => {
  it("registers exactly one exporter through core.register.exporter", () => {
    const registered: unknown[] = [];
    const core = { register: { exporter: (e: unknown) => registered.push(e) } };
    register(core, { config: { serviceName: "svc" } });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBeInstanceOf(OtelObsExporter);
  });

  it("DEFAULT deps send a real OTLP/HTTP POST to a loopback collector (§5, §9.2)", async () => {
    // No processor injected: this exercises the plugin's default transport
    // (BatchSpanProcessor over OTLPTraceExporter) — the path the loader now
    // reaches by passing options.config through register(core, options). Proves
    // the default really sends real HTTP rather than being a no-op.
    const http = await import("node:http");
    const bodies: Buffer[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const exporters: { export: (r: ObsRecord) => void; flush: () => Promise<void> }[] = [];
      const core = { register: { exporter: (e: unknown) => exporters.push(e as never) } };
      register(core, { config: { endpoint: `http://127.0.0.1:${port}/v1/traces`, serviceName: "svc" } });
      expect(exporters).toHaveLength(1);
      exporters[0]!.export(modelRecord);
      await exporters[0]!.flush();
      // Give the batch exporter's HTTP request a moment to land.
      await new Promise((r) => setTimeout(r, 200));
      expect(bodies.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("FX-C: flush AWAITS the real OTLP send — the body has landed with no post-flush sleep", async () => {
    // The receiver records the body the instant the request END fires (the body
    // is fully received), but DELAYS its response 300 ms. If flush resolves
    // before the send drains (the FX-C bug) the body would NOT yet be recorded
    // right after `await flush()`. With the fix, flush awaits the in-flight send,
    // so the body is already present with NO sleep.
    const http = await import("node:http");
    const bodies: Buffer[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }, 300);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const exporters: { export: (r: ObsRecord) => void; flush: () => Promise<void> }[] = [];
      const core = { register: { exporter: (e: unknown) => exporters.push(e as never) } };
      register(core, { config: { endpoint: `http://127.0.0.1:${port}/v1/traces`, serviceName: "svc" } });
      exporters[0]!.export(modelRecord);
      await exporters[0]!.flush();
      // NO sleep: the body must already be present because flush awaited the send.
      expect(bodies.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
