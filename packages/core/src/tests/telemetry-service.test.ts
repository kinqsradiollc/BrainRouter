import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryService, TelemetryService } from '../telemetry/service.js';
import { isTelemetryEnabled } from '../telemetry/telemetry.js';
import type { TelemetryEvent } from '../telemetry/contracts.js';
import type { TelemetrySink } from '../telemetry/telemetryPort.js';

test('TelemetryService is a stateless facade — delegates to the telemetry recorder', () => {
  const svc = createTelemetryService();
  assert.ok(svc instanceof TelemetryService);
  assert.equal(svc.isEnabled(), isTelemetryEnabled());

  // setSink + export route through the installed sink — prove the delegation.
  const events = [{ id: 'e1', name: 'unit', at: '2020-01-01T00:00:00.000Z' }] as unknown as TelemetryEvent[];
  const captured: TelemetryEvent[] = [];
  const sink: TelemetrySink = {
    record: (e) => { captured.push(e); },
    list: () => events,
    clear: () => { captured.length = 0; },
  };
  try {
    svc.setSink(sink);
    assert.deepEqual(svc.export(), events);
    // record is best-effort (no-op when telemetry is disabled) — must not throw.
    svc.record({ name: 'svc-test' });
  } finally {
    svc.setSink(null);
  }
});
