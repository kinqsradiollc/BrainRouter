/**
 * ADR-054 D2 — the best-effort usage-telemetry push: opt-in, transport-injected,
 * failure-swallowing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { pushUsageTelemetry, setUsageTelemetryTransport, type UsageTelemetryDelta } from '../usage/telemetry.js';

test('pushes only when cli.usageTelemetry is on and a transport is installed', () => {
  const seen: UsageTelemetryDelta[] = [];
  setUsageTelemetryTransport((d) => { seen.push(d); });
  try {
    _resetCliKnobsCache(); setCliKnobOverride({ usageTelemetry: false } as never);
    pushUsageTelemetry({ automation: 'loop:x', promptTokens: 10, completionTokens: 2 });
    assert.equal(seen.length, 0, 'off ⇒ no push');

    _resetCliKnobsCache(); setCliKnobOverride({ usageTelemetry: true } as never);
    pushUsageTelemetry({ automation: 'loop:x', promptTokens: 10, completionTokens: 2 });
    assert.equal(seen.length, 1, 'on ⇒ pushed');
    assert.equal(seen[0]!.automation, 'loop:x');
  } finally {
    setUsageTelemetryTransport(null); _resetCliKnobsCache();
  }
});

test('an unattributed delta is not pushed', () => {
  const seen: UsageTelemetryDelta[] = [];
  setUsageTelemetryTransport((d) => { seen.push(d); });
  try {
    _resetCliKnobsCache(); setCliKnobOverride({ usageTelemetry: true } as never);
    pushUsageTelemetry({ automation: '  ', promptTokens: 5, completionTokens: 1 });
    assert.equal(seen.length, 0);
  } finally {
    setUsageTelemetryTransport(null); _resetCliKnobsCache();
  }
});

test('a throwing transport never escapes (advisory push)', () => {
  setUsageTelemetryTransport(() => { throw new Error('server down'); });
  try {
    _resetCliKnobsCache(); setCliKnobOverride({ usageTelemetry: true } as never);
    assert.doesNotThrow(() => pushUsageTelemetry({ automation: 'loop:x', promptTokens: 1, completionTokens: 1 }));
  } finally {
    setUsageTelemetryTransport(null); _resetCliKnobsCache();
  }
});

test('no transport installed ⇒ silent no-op even when on', () => {
  setUsageTelemetryTransport(null);
  _resetCliKnobsCache(); setCliKnobOverride({ usageTelemetry: true } as never);
  try {
    assert.doesNotThrow(() => pushUsageTelemetry({ automation: 'x', promptTokens: 1, completionTokens: 0 }));
  } finally {
    _resetCliKnobsCache();
  }
});
