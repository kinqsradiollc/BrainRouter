import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTraceForBackend } from '../runtime/tracing.js';

const EVT = {
  ts: '2026-05-29T00:00:00.000Z',
  trace_id: 'trace-1',
  span_id: 'span-1',
  parent_span_id: 'parent-1',
  name: 'tool',
  duration_ms: 42,
  attributes: { tool: 'read_file', ok: true },
};

test('stdout-jsonl returns the event unchanged', () => {
  assert.deepEqual(formatTraceForBackend(EVT, 'stdout-jsonl'), EVT);
});

test('otel maps to an OTLP-shaped span with key/value attributes', () => {
  const out = formatTraceForBackend(EVT, 'otel') as any;
  const span = out.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, 'trace-1');
  assert.equal(span.spanId, 'span-1');
  assert.equal(span.parentSpanId, 'parent-1');
  assert.equal(span.name, 'tool');
  const toolAttr = span.attributes.find((a: any) => a.key === 'tool');
  assert.equal(toolAttr.value.stringValue, 'read_file');
});

test('langsmith maps to a run with metadata + ids', () => {
  const out = formatTraceForBackend(EVT, 'langsmith') as any;
  assert.equal(out.name, 'tool');
  assert.equal(out.id, 'span-1');
  assert.equal(out.trace_id, 'trace-1');
  assert.equal(out.parent_run_id, 'parent-1');
  assert.equal(out.extra.metadata.tool, 'read_file');
  assert.equal(out.extra.duration_ms, 42);
});

test('langfuse maps to a span-create ingestion batch', () => {
  const out = formatTraceForBackend(EVT, 'langfuse') as any;
  assert.equal(out.batch.length, 1);
  assert.equal(out.batch[0].type, 'span-create');
  assert.equal(out.batch[0].body.traceId, 'trace-1');
  assert.equal(out.batch[0].body.parentObservationId, 'parent-1');
  assert.equal(out.batch[0].body.name, 'tool');
});
