import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCliKnobs } from '../config/config.js';
import { redactText } from '../state/sessionStore.js';

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

export type TracingBackend = 'stdout-jsonl' | 'otel' | 'langsmith' | 'langfuse';

function tracingBackend(): TracingBackend {
  return getCliKnobs().tracingBackend ?? 'stdout-jsonl';
}

export function traceEnabled(): boolean {
  const backend = tracingBackend();
  // jsonl needs a file path; remote backends need an ingest endpoint.
  if (backend === 'stdout-jsonl') return resolveLogPath() !== null;
  return Boolean(getCliKnobs().tracingEndpoint?.trim());
}

/**
 * AUG-A4 — map an OTEL-flavoured event to the wire shape a given backend
 * expects. Pure (no I/O) so the per-backend shapes unit-test cleanly. The
 * `stdout-jsonl` case returns the event unchanged (one JSONL line). Remote
 * shapes are intentionally minimal-but-valid approximations of each
 * vendor's ingest contract.
 */
export function formatTraceForBackend(evt: TraceEvent, backend: TracingBackend): unknown {
  switch (backend) {
    case 'otel':
      // OTLP/JSON-ish span: a single ScopeSpan with the event as a span.
      return {
        resourceSpans: [
          {
            scopeSpans: [
              {
                scope: { name: 'brainrouter-cli' },
                spans: [
                  {
                    traceId: evt.trace_id,
                    spanId: evt.span_id,
                    parentSpanId: evt.parent_span_id,
                    name: evt.name,
                    attributes: Object.entries(evt.attributes).map(([key, value]) => ({
                      key,
                      value: { stringValue: String(value) },
                    })),
                  },
                ],
              },
            ],
          },
        ],
      };
    case 'langsmith':
      // LangSmith run ingest (simplified): one run per event.
      return {
        name: evt.name,
        run_type: 'chain',
        start_time: evt.ts,
        id: evt.span_id,
        trace_id: evt.trace_id,
        parent_run_id: evt.parent_span_id,
        extra: { metadata: evt.attributes, duration_ms: evt.duration_ms },
      };
    case 'langfuse':
      // Langfuse ingestion batch (simplified): one span-create event.
      return {
        batch: [
          {
            type: 'span-create',
            id: evt.span_id,
            timestamp: evt.ts,
            body: {
              traceId: evt.trace_id,
              parentObservationId: evt.parent_span_id,
              name: evt.name,
              metadata: evt.attributes,
            },
          },
        ],
      };
    case 'stdout-jsonl':
    default:
      return evt;
  }
}

/**
 * Route one event to the active backend. jsonl appends a line; remote
 * backends fire a best-effort POST (fire-and-forget, time-bounded, never
 * throws — tracing must never break the CLI).
 */
function emit(evt: TraceEvent): void {
  const backend = tracingBackend();
  if (backend === 'stdout-jsonl') {
    const logPath = resolveLogPath();
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, JSON.stringify(evt) + '\n', 'utf8');
    } catch { /* tracing must never break the CLI */ }
    return;
  }
  const endpoint = getCliKnobs().tracingEndpoint?.trim();
  if (!endpoint) return;
  const apiKey = getCliKnobs().tracingApiKey?.trim();
  try {
    void fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      // MEM-36 — scrub secret-shaped values from span attributes (tool args,
      // prompts, env-like strings) before they leave the process for an
      // external tracing backend. Reuses the transcript redactor.
      body: redactText(JSON.stringify(formatTraceForBackend(evt, backend))),
      signal: AbortSignal.timeout(3000),
    }).catch(() => { /* best-effort */ });
  } catch { /* never throw */ }
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
  if (!traceEnabled()) return;
  const evt: TraceEvent = {
    ts: new Date().toISOString(),
    trace_id: options?.traceId ?? newTraceId(),
    span_id: options?.spanId ?? newSpanId(),
    parent_span_id: options?.parentSpanId,
    name,
    attributes,
  };
  emit(evt);
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
      // Second event carrying duration_ms so the span length is queryable
      // without re-deriving from start/end. Routes through the same backend.
      emit({
        ts: new Date().toISOString(),
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: options?.parentSpanId,
        name: `${name}.end`,
        duration_ms: Date.now() - startedAt,
        attributes: { ...attributes, ...(extra ?? {}) },
      });
    },
  };
}
