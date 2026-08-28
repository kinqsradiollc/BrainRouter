/**
 * ADR-050 P3 — the approval bridge.
 *
 * Adapts the host's `InteractionPort` (the same seam that renders every other
 * human decision on Desktop/CLI/mobile) into a session `onPermission` callback,
 * so an agent-side permission request surfaces exactly like any interaction —
 * and no code path ever auto-types `y`.
 *
 * Fail-closed (ADR-050 D3): prefer `confirmExplicit` (lossless — a dismissed or
 * timed-out prompt is NOT an approval); with only `confirm()`, anything but an
 * approval maps to `declined`. A command request is flagged dangerous.
 */
import type { InteractionPort } from '@kinqs/brainrouter-agent-protocol';
import type { SessionPermissionDecision, SessionPermissionRequest } from './types.js';

export function bridgeInteractionToPermission(
  port: InteractionPort,
): (request: SessionPermissionRequest) => Promise<SessionPermissionDecision> {
  return async (request) => {
    const prompt = {
      title: request.title,
      ...(request.detail ? { detail: request.detail } : {}),
      dangerous: request.kind === 'command',
      tool: request.kind,
    };
    if (port.confirmExplicit) {
      const decision = await port.confirmExplicit(prompt);
      // approved → approved; declined/dismissed → declined (fail-closed).
      return decision === 'approved' ? 'approved' : 'declined';
    }
    return (await port.confirm(prompt)) ? 'approved' : 'declined';
  };
}
