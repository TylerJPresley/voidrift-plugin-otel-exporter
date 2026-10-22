/**
 * The record-to-span mapping (otel-exporter-blueprint §3, §4).
 *
 * Each neutral `ObsRecord` becomes one OTel `ReadableSpan`, built against a context
 * reconstructed from the record's own ids — the exporter never runs inside a live
 * OTel context, so it derives a stable 16-byte TraceId and 8-byte SpanId from the
 * VoidRift string ids by a deterministic hash (§4). The same VoidRift id always
 * yields the same OTel id, so one session is one trace and every `parentSpanId`
 * edge reproduces as an OTel parent/child edge (invariant §9.1#2).
 *
 * `gen_ai.*` GenAI-semantic-convention attributes appear only when the record
 * carries the field (§3, invariant §9.1#3): `model`/`usage` ride model spans, so a
 * tool or guardian span carries no `gen_ai.*` key. Derived `cost` is attributed
 * only when the core set it (`attributes.cost`, core §10.7).
 */
import { createHash } from "node:crypto";
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type HrTime,
  type SpanContext,
  type SpanStatus,
} from "@opentelemetry/api";
import { addHrTimes, millisToHrTime } from "@opentelemetry/core";
import { type Resource } from "@opentelemetry/resources";
import { type ReadableSpan, type TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROMPT,
  ATTR_GEN_AI_COMPLETION,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { ObsRecord, ObsSource, ObsStatus } from "./obs-record.js";

/**
 * Total-token and derived-cost attributes (otel-exporter-blueprint §3; core §10.7).
 * `@opentelemetry/semantic-conventions` ships no constant for these two GenAI keys
 * in this version, so the blueprint's attribute names are pinned here as literals.
 */
export const ATTR_GEN_AI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens";
export const ATTR_GEN_AI_USAGE_COST = "gen_ai.usage.cost";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

/**
 * Derive a stable, fixed-width hex OTel id from a VoidRift string id. A SHA-256
 * digest truncated to the required width is deterministic — the same input always
 * yields the same id — so correlation survives the mapping (§4). An empty id would
 * hash to a constant; the caller guards against empty ids by construction.
 */
export function deriveOtelId(voidriftId: string, bytes: number): string {
  return createHash("sha256").update(voidriftId).digest("hex").slice(0, bytes * 2);
}

/** `ok → OK`, `error → ERROR`, `pending → UNSET` (§3). */
function toSpanStatus(status: ObsStatus): SpanStatus {
  if (status === "ok") return { code: SpanStatusCode.OK };
  if (status === "error") return { code: SpanStatusCode.ERROR };
  return { code: SpanStatusCode.UNSET };
}

/**
 * `model`/`tool`/`mcp` → `CLIENT` (an outbound call), `user` → `SERVER` (an inbound
 * request), everything else → `INTERNAL` (§3).
 */
function toSpanKind(source: ObsSource): SpanKind {
  if (source === "model" || source === "tool" || source === "mcp") return SpanKind.CLIENT;
  if (source === "user") return SpanKind.SERVER;
  return SpanKind.INTERNAL;
}

/** A JSON-safe attribute value; nested structures are JSON-encoded (§3). */
function toAttributeValue(value: unknown): AttributeValue {
  if (value === null || value === undefined) return "";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value as AttributeValue;
  return JSON.stringify(value);
}

/**
 * Flatten the record's attribute bag under a `voidrift.*` prefix, excluding the
 * derived `cost` which maps onto its GenAI attribute instead (§3).
 */
function voidriftAttributes(record: ObsRecord): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(record.attributes)) {
    if (key === "cost") continue;
    attrs[`voidrift.${key}`] = toAttributeValue(value);
  }
  return attrs;
}

/** GenAI attributes, set only for the fields the record carries (§3, §9.1#3). */
function genAiAttributes(record: ObsRecord): Attributes {
  const attrs: Attributes = {};
  if (record.model) {
    attrs[ATTR_GEN_AI_REQUEST_MODEL] = record.model.name;
    attrs[ATTR_GEN_AI_RESPONSE_MODEL] = record.model.name;
    attrs[ATTR_GEN_AI_SYSTEM] = record.model.protocol;
    attrs[ATTR_GEN_AI_OPERATION_NAME] = record.source;
  }
  if (record.usage) {
    attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS] = record.usage.inputTokens;
    attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = record.usage.outputTokens;
    attrs[ATTR_GEN_AI_USAGE_TOTAL_TOKENS] = record.usage.totalTokens;
    if (typeof record.usage.cacheReadTokens === "number") {
      attrs[ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = record.usage.cacheReadTokens;
    }
  }
  const cost = record.attributes["cost"];
  if (typeof cost === "number") attrs[ATTR_GEN_AI_USAGE_COST] = cost;
  return attrs;
}

/** The already-masked prompt/completion content events (§3; masked by core §10.10). */
function contentEvents(record: ObsRecord, startTime: HrTime): TimedEvent[] {
  const events: TimedEvent[] = [];
  if (record.input !== undefined) {
    events.push({
      name: "gen_ai.content.prompt",
      time: startTime,
      attributes: { [ATTR_GEN_AI_PROMPT]: toAttributeValue(record.input) },
      droppedAttributesCount: 0,
    });
  }
  if (record.output !== undefined) {
    events.push({
      name: "gen_ai.content.completion",
      time: startTime,
      attributes: { [ATTR_GEN_AI_COMPLETION]: toAttributeValue(record.output) },
      droppedAttributesCount: 0,
    });
  }
  return events;
}

/**
 * Build a `ReadableSpan` from a masked `ObsRecord` against a context reconstructed
 * from the record's ids (§3, §4). An open span (no `durationMs`) ends at receipt.
 */
export function recordToSpan(
  record: ObsRecord,
  resource: Resource,
  scopeName: string,
): ReadableSpan {
  const traceId = deriveOtelId(record.traceId, TRACE_ID_BYTES);
  const spanId = deriveOtelId(record.spanId, SPAN_ID_BYTES);
  const spanContext: SpanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED };

  // The parent edge: a remote SpanContext carrying the derived parent SpanId, so
  // the OTel parent/child edge matches VoidRift's `parentSpanId` edge exactly (§4).
  const parentSpanContext: SpanContext | undefined =
    record.parentSpanId != null
      ? {
          traceId,
          spanId: deriveOtelId(record.parentSpanId, SPAN_ID_BYTES),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        }
      : undefined;

  const parsed = Date.parse(record.timestamp);
  const startTime: HrTime = millisToHrTime(Number.isNaN(parsed) ? Date.now() : parsed);
  const durationHr: HrTime = millisToHrTime(record.durationMs ?? 0);
  const endTime: HrTime = addHrTimes(startTime, durationHr);

  const attributes: Attributes = {
    "voidrift.source": record.source,
    "voidrift.severity": record.severity,
    ...voidriftAttributes(record),
    ...genAiAttributes(record),
  };

  const span: ReadableSpan = {
    name: record.name,
    kind: toSpanKind(record.source),
    spanContext: () => spanContext,
    startTime,
    endTime,
    status: toSpanStatus(record.status),
    attributes,
    links: [],
    events: contentEvents(record, startTime),
    duration: durationHr,
    ended: true,
    resource,
    instrumentationScope: { name: scopeName },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  if (parentSpanContext) {
    (span as { parentSpanContext?: SpanContext }).parentSpanContext = parentSpanContext;
  }
  return span;
}
