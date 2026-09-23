/**
 * ADR-054 D2 — install the CLI-side usage-telemetry transport. Core stays
 * network-free; this wires `setUsageTelemetryTransport` to POST a per-automation
 * delta to the brain server (`/api/usage/automation`) using the signed-in
 * account target. Best-effort by contract: gated by `cli.usageTelemetry` inside
 * core's `pushUsageTelemetry`, and any failure here is swallowed so a turn is
 * never affected. Idempotent — safe to call at every session start.
 */
import { setUsageTelemetryTransport } from '@kinqs/brainrouter-core/usage';
import { resolveAccountApiTarget, accountApiRequest } from '../account/accountClient.js';

export function installUsageTelemetryPush(): void {
  setUsageTelemetryTransport((delta) => {
    const target = resolveAccountApiTarget();
    if ('error' in target) return; // not signed in to a hosted profile — nothing to push to
    // Fire-and-forget; core already gates on the knob and swallows rejections.
    void accountApiRequest(target, 'POST', '/api/usage/automation', { delta }).catch(() => {});
  });
}
