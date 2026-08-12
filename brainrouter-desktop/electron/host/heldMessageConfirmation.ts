/**
 * ADR-034 production adapter from durable held rows to InteractionBroker.
 * It is separate so the modal and Peers panel share one broker request: only
 * an explicit boolean is terminal, dismissal stays held, and every resolution
 * emits cleanup for the exact participant/request pair.
 */
import {
  type InteractionBroker,
  type InteractionRequest,
  toExplicitConfirmDecision,
} from '@kinqs/brainrouter-agent-protocol';
import {
  sanitizePeerTextForTerminal,
  type HeldSessionMessageRecord,
} from '@kinqs/brainrouter-core/session';
import type { DesktopHeldConfirmation } from './sessionMessaging.js';

export interface HeldMessageConfirmationEvents {
  emitRequest(sessionKey: string, event: {
    kind: 'interaction-request';
    request: InteractionRequest;
  }): void;
  emitResolved(sessionKey: string, interactionId: string): void;
}

export function requestDesktopHeldConfirmation(
  broker: InteractionBroker,
  record: HeldSessionMessageRecord,
  events: HeldMessageConfirmationEvents,
  timeoutMs = 300_000,
): DesktopHeldConfirmation {
  const { request, response } = broker.request({
    type: 'confirm',
    title: `Message from ${sanitizePeerTextForTerminal(record.senderSessionKey)}`,
    detail: [
      'Another session sent untrusted peer content. This recipient can mutate without a guaranteed second confirmation.',
      '',
      sanitizePeerTextForTerminal(record.text),
      '',
      `Sender device: ${sanitizePeerTextForTerminal(record.senderDeviceId)}`,
      ...(record.senderDetails?.clientKind
        ? [`Sender client: ${sanitizePeerTextForTerminal(record.senderDetails.clientKind)}`]
        : []),
      ...(record.senderDetails?.title
        ? [`Sender title: ${sanitizePeerTextForTerminal(record.senderDetails.title)}`]
        : []),
      ...(record.senderDetails?.workspaceRoot
        ? [`Sender workspace: ${sanitizePeerTextForTerminal(record.senderDetails.workspaceRoot)}`]
        : []),
      ...(record.senderDetails?.transport
        ? [`Transport: ${sanitizePeerTextForTerminal(record.senderDetails.transport)}`]
        : []),
      `Expires: ${new Date(record.expiresAt).toLocaleString()}`,
    ].join('\n'),
    dangerous: true,
    tool: 'session-message',
  }, { timeoutMs });
  events.emitRequest(record.targetSessionKey, { kind: 'interaction-request', request });
  return {
    interactionId: request.id,
    response: response.then((answer) => {
      events.emitResolved(record.targetSessionKey, request.id);
      const decision = toExplicitConfirmDecision(answer);
      return decision === 'approved' ? true : decision === 'declined' ? false : null;
    }),
    resolve: (approved: boolean) => broker.resolve(request.id, { type: 'confirm', approved }),
  };
}
