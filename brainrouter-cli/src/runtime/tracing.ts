import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCliKnobs } from '../config/config.js';

/**
 * Lightweight tracing in OTEL-flavored JSONL.
 *
 * Activated by setting `BRAINROUTER_TRACE_LOG=<path>`. Each span becomes one
 * JSON object per line:
 *
 *   {
 *     "ts":"2026-05-21T09:30:12.345Z",
 *     "trace_id":"…", "span_id":"…", "parent_span_id":"…",
 *     "name":"turn|tool|llm_call|child_agent",
 *     "duration_ms":123,
 *     "attributes":{ "agent_id":"…", "parent_agent_id":"…", "tool":"read_file", ... }
 *   }
 *
 * The shape is intentionally close to OTLP/JSON so a downstream collector
 * (vector, fluent-bit, otel-collector with the file receiver) can ingest it
 * directly without us needing to depend on the `@opentelemetry/*` packages.
 */

interface TraceEvent {
  ts: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  duration_ms?: number;
  attributes: Record<string, unknown>;
}

let cachedLogPath: string | null | undefined;
function resolveLogPath(): string | null {
  if (cachedLogPath !== undefined) return cachedLogPath;
  const raw = getCliKnobs().traceLog?.trim();
  cachedLogPath = raw ? path.resolve(raw) : null;
  if (cachedLogPath) {
    try { fs.mkdirSync(path.dirname(cachedLogPath), { recursive: true }); } catch { /* noop */ }
  }
  return cachedLogPath;
}

export function traceEnabled(): boolean {
  return resolveLogPath() !== null;
}

export function newTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32);
}
export function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Emit a one-shot event (no duration). Cheap; the file is opened+appended
 * synchronously then closed. For higher throughput, swap to a buffered writer
 * later — this is intentionally simple.
 */
export function traceEvent(
  name: string,
  attributes: Record<string, unknown> = {},
  options?: { traceId?: string; spanId?: string; parentSpanId?: string },
): void {
  const logPath = resolveLogPath();
  if (!logPath) return;
  const evt: TraceEvent = {
    ts: new Date().toISOString(),
    trace_id: options?.traceId ?? newTraceId(),
    span_id: options?.spanId ?? newSpanId(),
    parent_span_id: options?.parentSpanId,
    name,
    attributes,
  };
  try {
    fs.appendFileSync(logPath, JSON.stringify(evt) + '\n', 'utf8');
  } catch { /* tracing must never break the CLI */ }
}

/**
 * Open a span. Call `end(extraAttrs?)` on the returned handle when finished.
 * Returns a no-op handle when tracing is disabled.
 */
export function startSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  options?: { traceId?: string; parentSpanId?: string },
): { end: (extra?: Record<string, unknown>) => void; traceId: string; spanId: string } {
  if (!traceEnabled()) {
    return { end: () => {}, traceId: '', spanId: '' };
  }
  const traceId = options?.traceId ?? newTraceId();
  const spanId = newSpanId();
  const startedAt = Date.now();
  return {
    traceId,
    spanId,
    end: (extra) => {
      traceEvent(name, { ...attributes, ...(extra ?? {}) }, {
        traceId,
        spanId,
        parentSpanId: options?.parentSpanId,
      });
      // Overwrite ts with start time? — keep ts as end-of-span for simplicity;
      // duration_ms gives the start. Some collectors prefer this shape.
      const logPath = resolveLogPath();
      if (logPath) {
        try {
          // Best-effort patch: write a second line with duration_ms so the
          // duration is queryable without re-deriving from start/end events.
          const dur = Date.now() - startedAt;
          fs.appendFileSync(logPath, JSON.stringify({
            ts: new Date().toISOString(),
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: options?.parentSpanId,
            name: `${name}.end`,
            duration_ms: dur,
            attributes: { ...attributes, ...(extra ?? {}) },
          }) + '\n', 'utf8');
        } catch { /* noop */ }
      }
    },
  };
}
