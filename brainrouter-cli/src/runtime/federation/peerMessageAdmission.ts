/**
 * ADR-034 — CLI adapter from verified transport envelopes to the Agent safe boundary.
 * Transport never approves content: exact recipient authority owns durable
 * hold/decline state, and dismissal stays non-terminal for later recovery.
 */

import type { IAgent, SessionMessageRecipientAuthority } from '@kinqs/brainrouter-core/agent';
import {
  admitSessionMessage,
  approveHeldSessionMessage,
  declineHeldSessionMessage,
  deriveLegacyRemoteDeviceId,
  holdSessionMessage,
  listHeldSessionMessages,
  markHeldSessionMessageApplied,
  sanitizePeerTextForTerminal,
  type LocalSessionMessage,
  type PeerSessionSenderDetails,
  type PeerSessionSteeringInput,
} from '@kinqs/brainrouter-core/session';
import type { InboundPeerMessageState } from './federationRegistration.js';

const queuedDeliveryIds = new WeakMap<IAgent, Set<string>>();
const approvalPrompts = new WeakMap<IAgent, Map<string, Promise<InboundPeerMessageState>>>();

export async function admitPeerMessageForAgent(
  agent: IAgent,
  message: LocalSessionMessage,
  senderDetails: PeerSessionSenderDetails,
): Promise<InboundPeerMessageState> {
  let admission: ReturnType<typeof admitSessionMessage>;
  try {
    admission = admitSessionMessage(
      agent.workspaceRoot,
      message,
      authorityForAgent(agent),
      Date.now(),
      senderDetails,
    );
  } catch (error) {
    if (isSessionInputQueueFull(error)) return 'queue_full';
    throw error;
  }
  if (admission.decision === 'rejected') {
    return admission.record.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
  }
  if (admission.decision === 'expired') return 'expired';
  if (admission.decision === 'applied') return 'applied';
  if (admission.decision === 'held') {
    return requestHeldPeerMessageApproval(agent, message.targetSessionKey, message.id);
  }
  try {
    queuePeerInputOnce(agent, admission.input);
    return 'queued';
  } catch (error) {
    const existing = listHeldSessionMessages(agent.workspaceRoot, message.targetSessionKey)
      .find((record) => record.id === message.id);
    let held;
    try {
      held = existing ?? holdSessionMessage(
          agent.workspaceRoot,
          message,
          `Safe-boundary admission failed: ${error instanceof Error ? error.message : String(error)}`,
          Date.now(),
          senderDetails,
        );
    } catch (holdError) {
      if (isSessionInputQueueFull(holdError)) return 'queue_full';
      throw holdError;
    }
    return held.status === 'expired' ? 'expired' : 'held';
  }
}

function isSessionInputQueueFull(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SESSION_INPUT_QUEUE_FULL';
}

/**
 * Present an unsafe held row through the host-neutral interaction port. A
 * missing, dismissed, or non-interactive port is not a rejection: the durable
 * record remains held until a later explicit approval or decline.
 */
export function requestHeldPeerMessageApproval(
  agent: IAgent,
  participantSessionKey: string,
  messageId: string,
): Promise<InboundPeerMessageState> {
  let agentPrompts = approvalPrompts.get(agent);
  if (!agentPrompts) {
    agentPrompts = new Map();
    approvalPrompts.set(agent, agentPrompts);
  }
  const existingPrompt = agentPrompts.get(messageId);
  if (existingPrompt) return existingPrompt;
  const prompt = requestHeldPeerMessageApprovalOnce(agent, participantSessionKey, messageId)
    .finally(() => { agentPrompts?.delete(messageId); });
  agentPrompts.set(messageId, prompt);
  return prompt;
}

async function requestHeldPeerMessageApprovalOnce(
  agent: IAgent,
  participantSessionKey: string,
  messageId: string,
): Promise<InboundPeerMessageState> {
  const record = listHeldSessionMessages(agent.workspaceRoot, participantSessionKey)
    .find((candidate) => candidate.id === messageId);
  if (!record) throw new Error(`Unknown held session message "${messageId}".`);
  if (record.status === 'rejected') {
    return record.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
  }
  if (record.status === 'expired') return 'expired';
  if (record.status === 'approved' && record.appliedAt !== undefined) return 'applied';

  if (record.status === 'held') {
    if (!agent.interactionPort) return 'held';
    let decision: 'approved' | 'declined' | 'dismissed';
    try {
      const detail = [
        `From session: ${sanitizePeerTextForTerminal(record.senderSessionKey)}`,
        record.senderDetails?.title
          ? `Sender title: ${sanitizePeerTextForTerminal(record.senderDetails.title)}`
          : '',
        '',
        sanitizePeerTextForTerminal(record.text),
      ].filter(Boolean).join('\n').slice(0, 4_000);
      if (agent.interactionPort.confirmExplicit) {
        decision = await agent.interactionPort.confirmExplicit({
          title: 'Apply held peer message?',
          detail,
        });
      } else {
        // A generic boolean host cannot distinguish explicit No from a
        // headless default or dismissed prompt. Only true is authoritative.
        decision = await agent.interactionPort.confirm({
          title: 'Apply held peer message?',
          detail,
          dangerous: true,
          tool: 'peer-session-message',
        }) ? 'approved' : 'dismissed';
      }
    } catch {
      return 'held';
    }
    if (decision === 'dismissed') return 'held';
    if (decision === 'declined') {
      const declined = declineHeldSessionMessage(
        agent.workspaceRoot,
        participantSessionKey,
        messageId,
      );
      if (declined.status === 'expired') return 'expired';
      return declined.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
    }
  }

  return approveHeldPeerMessageForAgent(agent, participantSessionKey, messageId);
}

/** Apply an already-explicit CLI approval without presenting a second prompt. */
export function approveHeldPeerMessageForAgent(
  agent: IAgent,
  participantSessionKey: string,
  messageId: string,
): InboundPeerMessageState {
  const approved = approveHeldSessionMessage(agent.workspaceRoot, participantSessionKey, messageId);
  if (approved.record.status === 'expired') return 'expired';
  if (approved.record.status === 'rejected') {
    return approved.record.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
  }
  if (!approved.input) return 'applied';
  try {
    queuePeerInputOnce(agent, approved.input);
    return 'queued';
  } catch {
    // Approval is already durable. Keeping the remote row held lets a later
    // poll or restarted host replay this approved-but-unapplied input.
    return 'held';
  }
}

export interface DeferredPeerSteeringResult {
  deferredPeerMessages: number;
  discardedOtherInputs: number;
}

/**
 * Detach queued steering from the current history before its logical address
 * changes. Peer inputs are durably preserved as approved-but-unapplied rows
 * for replay when that exact old session is resumed; other pending inputs are
 * cleared so they cannot leak into unrelated history.
 */
export function deferPendingSteeringForSessionSwitch(
  agent: IAgent,
  participantSessionKey: string,
): DeferredPeerSteeringResult {
  const pending = agent.consumePendingSteering();
  let deferredPeerMessages = 0;
  let discardedOtherInputs = 0;
  for (const input of pending) {
    if (input.source !== 'peer-session') {
      discardedOtherInputs += 1;
      continue;
    }
    const senderDeviceId = input.sender.deviceId ??
      deriveLegacyRemoteDeviceId(input.sender.sessionKey);
    const receivedAt = input.createdAt;
    const message: LocalSessionMessage = {
      id: input.id,
      senderSessionKey: input.sender.sessionKey,
      senderDeviceId,
      targetSessionKey: participantSessionKey,
      text: input.text,
      createdAt: input.sender.sentAt ?? receivedAt,
      receivedAt,
      expiresAt: input.expiresAt,
      source: 'peer-session',
      trust: 'untrusted-session',
    };
    const {
      sessionKey: _senderSessionKey,
      deviceId: _senderDeviceId,
      sentAt: _sentAt,
      ...senderDetails
    } = input.sender;
    holdSessionMessage(
      agent.workspaceRoot,
      message,
      'Session switched before safe-boundary application.',
      Date.now(),
      senderDetails,
    );
    approveHeldSessionMessage(agent.workspaceRoot, participantSessionKey, input.id);
    queuedDeliveryIds.get(agent)?.delete(input.id);
    deferredPeerMessages += 1;
  }
  return { deferredPeerMessages, discardedOtherInputs };
}

/** Retry durable approvals only when their exact logical participant resumes. */
export function recoverApprovedPeerMessagesForAgent(
  agent: IAgent,
  participantSessionKey: string,
): number {
  let recovered = 0;
  for (const record of listHeldSessionMessages(
    agent.workspaceRoot,
    participantSessionKey,
    { status: 'approved' },
  )) {
    if (record.appliedAt !== undefined) continue;
    const approved = approveHeldSessionMessage(
      agent.workspaceRoot,
      participantSessionKey,
      record.id,
    );
    if (!approved.input) continue;
    try {
      queuePeerInputOnce(agent, approved.input);
      recovered += 1;
    } catch {
      // The durable approval remains retryable on a later start/switch.
    }
  }
  return recovered;
}

function queuePeerInputOnce(agent: IAgent, input: PeerSessionSteeringInput): void {
  let queued = queuedDeliveryIds.get(agent);
  if (!queued) {
    queued = new Set();
    queuedDeliveryIds.set(agent, queued);
  }
  if (queued.has(input.id)) return;
  agent.requestSteer(input.text, {
    id: input.id,
    source: input.source,
    sender: input.sender,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
  queued.add(input.id);
}

/** Mark only a previously approved held row after Agent confirms safe-boundary application. */
export function markApprovedPeerMessageApplied(
  agent: IAgent,
  participantSessionKey: string,
  messageId: string,
): void {
  const approved = listHeldSessionMessages(agent.workspaceRoot, participantSessionKey, { status: 'approved' })
    .some((record) => record.id === messageId);
  if (approved) {
    markHeldSessionMessageApplied(agent.workspaceRoot, participantSessionKey, messageId);
  }
  queuedDeliveryIds.get(agent)?.delete(messageId);
}

/** Release the process-local delivery guard after Core expires at the actual
 * safe boundary. The durable row is already terminal and must not requeue. */
export function forgetExpiredPeerMessageForAgent(agent: IAgent, messageId: string): void {
  queuedDeliveryIds.get(agent)?.delete(messageId);
}

export function authorityForAgent(agent: IAgent): SessionMessageRecipientAuthority {
  if (agent.getAccessMode() !== 'read') return {};
  return {
    workspaceFiles: 'denied',
    shell: 'denied',
    computerUse: 'denied',
    // Access mode constrains local filesystem/shell tools. It says nothing
    // about third-party MCP mutation semantics, so uncertainty must hold.
    externalWrites: 'unknown',
    remoteTools: 'unknown',
  };
}
