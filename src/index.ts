/**
 * @voidrift/plugin-otel-exporter — a first-party plugin (otel-exporter-blueprint.md).
 *
 * Teaches VoidRift's observability to reach any OpenTelemetry backend. The core
 * writes one neutral `ObsRecord` per span and holds no telemetry dependency (core
 * §10.1, §10.8); this plugin registers a single `ObsExporter` that maps each masked
 * record onto an OTel GenAI span and ships it to an OTLP collector (§1, §2). All
 * OpenTelemetry knowledge lives here — the neutral record is the whole contract.
 *
 * The plugin reaches the SDK only through the scoped CoreAPI (`core.register.exporter`,
 * AGENTS.md); it owns no loop, no session state, no capture, and no masking (§1).
 *
 * ── Config binding (§6) ─────────────────────────────────────────────────────
 * The exporter reads its `otelExporter` config. The scoped CoreAPI exposes
 * registration seams but not the config read, so a host supplies the resolved
 * config via `options.config` (mirroring the plan plugin's injected seam); absent,
 * the blueprint §6 defaults apply. A host or test may also inject a span processor
 * through `options.deps` to target an in-memory exporter offline (§9.2).
 */
import type { OtelObsExporterDeps, OtelExporterOptionsConfig } from "./exporter.js";
import { OtelObsExporter, resolveConfig } from "./exporter.js";
import { diag } from "@opentelemetry/api";

export type { ObsExporter, ObsRecord, ObsSource, ObsStatus, ObsSeverity, TokenUsage } from "./obs-record.js";
export { OtelObsExporter, resolveConfig, DEFAULT_CONFIG, validateEndpoint } from "./exporter.js";
export type { OtelExporterConfig, OtelObsExporterDeps, OtelExporterOptionsConfig } from "./exporter.js";
export {
  recordToSpan,
  deriveOtelId,
  ATTR_GEN_AI_USAGE_TOTAL_TOKENS,
  ATTR_GEN_AI_USAGE_COST,
} from "./mapping.js";

/** The minimal scoped-CoreAPI surface this plugin uses (core §12.4). */
interface ExporterRegistrar {
  register: { exporter(exporter: unknown): void };
  /** The read-only network-safety surface (§9.3): refuse a metadata endpoint
   * without importing core internals. Optional for older cores/tests. */
  network?: { isMetadataHost(host: string): boolean };
}

/** Options for configuring and wiring the exporter (§6, §9.2). */
export interface OtelExporterPluginOptions {
  /** `otelExporter` config; absent, the §6 defaults apply. `headerEnv` resolves
   * secret header values from the environment at use time (FX-C2). */
  config?: OtelExporterOptionsConfig;
  /** Processor/resource injection for tests and gRPC hosts (§5, §9.2). */
  deps?: OtelObsExporterDeps;
}

/**
 * The plugin's `register`. Constructs the OTLP transport and span processor once
 * and registers a single exporter through the real `core.register.exporter` seam
 * (§2). A construction failure logs and registers nothing rather than crashing (§7).
 */
export function register(core: ExporterRegistrar, options: OtelExporterPluginOptions = {}): void {
  try {
    const isMetadataHost = (host: string): boolean => {
      try {
        return core.network?.isMetadataHost(host) ?? false;
      } catch {
        return false;
      }
    };
    const config = resolveConfig(options.config, process.env, isMetadataHost);
    const exporter = new OtelObsExporter(config, options.deps ?? {});
    core.register.exporter(exporter);
  } catch (e) {
    // A construction/config failure logs and registers nothing rather than
    // crashing the session (§7). The message names the config key but never
    // echoes the endpoint URL, so a secret in a misconfigured endpoint is not
    // leaked (audit C4).
    diag.warn(`@voidrift/plugin-otel-exporter: not registered — ${(e as Error).message}`);
  }
}
