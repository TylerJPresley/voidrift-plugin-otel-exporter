/**
 * The neutral observability contract this plugin consumes (otel-exporter-blueprint
 * §1, §2; core-blueprint.md §10.1, §10.8). The core owns these shapes; the plugin
 * depends on `@voidrift/core` only as a peer and never imports core internals
 * (AGENTS.md). The record arrives ALREADY MASKED (§7, core §10.10) — the exporter
 * maps it verbatim and runs no detector of its own.
 *
 * These declarations mirror `@voidrift/core`'s `ObsRecord`/`ObsExporter`/`TokenUsage`
 * structurally so the plugin stays decoupled from the core's module layout; the
 * neutral record is the entire contract between the core and this plugin (§1).
 */

/** Token accounting carried on a model span (core §10.1, §10.7). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
}

/** The source capability that produced a span (core §10.1). */
export type ObsSource =
  | "user"
  | "model"
  | "tool"
  | "guardian"
  | "warden"
  | "session"
  | "worker"
  | "memory"
  | "skill"
  | "workspace"
  | "mcp"
  | "reflection"
  | "error";

/** The detail band a record was recorded at (core §10.2). */
export type ObsSeverity = "info" | "verbose" | "debug";

/** The lifecycle status of a span (core §10.1). */
export type ObsStatus = "ok" | "error" | "pending";

/** The neutral observability record (core §10.1). No telemetry-vendor type here. */
export interface ObsRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  durationMs?: number;
  status: ObsStatus;
  source: ObsSource;
  name: string;
  severity: ObsSeverity;
  attributes: Record<string, unknown>;
  model?: { name: string; protocol: string };
  input?: unknown;
  output?: unknown;
  usage?: TokenUsage;
}

/** The exporter contract (core §10.8). A throwing exporter is isolated by the core. */
export interface ObsExporter {
  export(record: ObsRecord): void | Promise<void>;
  flush?(): Promise<void>;
}
