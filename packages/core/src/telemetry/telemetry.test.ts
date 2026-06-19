import test from 'node:test';
import assert from 'node:assert/strict';
import { isTelemetryEvent, type TelemetryEvent } from './contracts.js';
import type { TelemetrySink } from './telemetryPort.js';
import {
  clearTelemetry,
  exportTelemetry,
  recordTelemetry,
  setTelemetrySink,
} from './telemetry.js';

/** Tiny array-backed sink so tests never touch the filesystem. */
function createMemorySink(): TelemetrySink & { events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
    list(limit) {
      return limit === undefined ? [...events] : events.slice(-limit);
    },
    clear() {
      events.length = 0;
    },
  };
}

test('recordTelemetry stamps id + at and forwards to the sink', () => {
  const sink = createMemorySink();
  setTelemetrySink(sink);
  try {
    const before = Date.now();
    recordTelemetry({ name: 'task_started', taskKind: 'build', props: { files: 3 } });
    assert.equal(sink.events.length, 1);
    const ev = sink.events[0];
    assert.equal(ev.name, 'task_started');
    assert.equal(ev.taskKind, 'build');
    assert.deepEqual(ev.props, { files: 3 });
    assert.match(ev.id, /^tel_[0-9a-f]{8}$/);
    assert.equal(typeof ev.at, 'string');
    // `at` is a real ISO timestamp at/after the moment we recorded.
    assert.ok(Date.parse(ev.at) >= before - 1000);
  } finally {
    setTelemetrySink(null);
  }
});

test('recordTelemetry honors an explicit `at` override', () => {
  const sink = createMemorySink();
  setTelemetrySink(sink);
  try {
    recordTelemetry({ name: 'review_started', at: '2020-01-01T00:00:00.000Z' });
    assert.equal(sink.events[0].at, '2020-01-01T00:00:00.000Z');
  } finally {
    setTelemetrySink(null);
  }
});

test('an in-memory sink list/clear round-trips', () => {
  const sink = createMemorySink();
  setTelemetrySink(sink);
  try {
    recordTelemetry({ name: 'task_created' });
    recordTelemetry({ name: 'task_completed', ok: true, durationMs: 12 });
    assert.equal(exportTelemetry().length, 2);
    // limit returns the most-recent N.
    const last = exportTelemetry(1);
    assert.equal(last.length, 1);
    assert.equal(last[0].name, 'task_completed');
    clearTelemetry();
    assert.equal(exportTelemetry().length, 0);
    assert.equal(sink.events.length, 0);
  } finally {
    setTelemetrySink(null);
  }
});

test('isTelemetryEvent accepts a good event and rejects junk', () => {
  const good: TelemetryEvent = {
    id: 'tel_abc12345',
    name: 'git_refresh',
    at: new Date().toISOString(),
    ok: true,
    durationMs: 5,
    props: { changed: 2, dirty: false, branch: 'main' },
  };
  assert.equal(isTelemetryEvent(good), true);

  // Junk / malformed shapes.
  assert.equal(isTelemetryEvent(null), false);
  assert.equal(isTelemetryEvent('nope'), false);
  assert.equal(isTelemetryEvent({}), false);
  assert.equal(isTelemetryEvent({ id: 'x', name: 'y' }), false); // missing `at`
  assert.equal(isTelemetryEvent({ id: 1, name: 'y', at: 'z' }), false); // id not string
  assert.equal(isTelemetryEvent({ id: 'x', name: 'y', at: 'z', durationMs: '5' }), false); // wrong type
  assert.equal(isTelemetryEvent({ id: 'x', name: 'y', at: 'z', props: [] }), false); // props not object
  assert.equal(
    isTelemetryEvent({ id: 'x', name: 'y', at: 'z', props: { nested: { a: 1 } } }),
    false,
  ); // non-primitive prop value
});

test('exportTelemetry returns recorded events', () => {
  const sink = createMemorySink();
  setTelemetrySink(sink);
  try {
    recordTelemetry({ name: 'attachment_ingested', props: { bytes: 1200 } });
    recordTelemetry({ name: 'memory_captured' });
    const exported = exportTelemetry();
    assert.deepEqual(
      exported.map((e) => e.name),
      ['attachment_ingested', 'memory_captured'],
    );
  } finally {
    setTelemetrySink(null);
  }
});

test('recordTelemetry never throws even when the sink throws', () => {
  const throwingSink: TelemetrySink = {
    record() {
      throw new Error('sink boom');
    },
    list() {
      return [];
    },
    clear() {},
  };
  setTelemetrySink(throwingSink);
  try {
    assert.doesNotThrow(() => recordTelemetry({ name: 'error', error: 'whatever' }));
  } finally {
    setTelemetrySink(null);
  }
});
