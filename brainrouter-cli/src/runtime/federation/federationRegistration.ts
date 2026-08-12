/**
 * CLI ownership of the ADR-034 participant lifecycle.
 *
 * One process key is registered in both the private loopback registry and the
 * optional Brain registry. Local messaging remains available when MCP is
 * absent; authenticated remote wakes and polling both replay durable rows
 * through the same recipient-side idempotency gate.
 */

import { randomUUID } from 'node:crypto';
import { callMcpTool, hasMcpTool, type McpClientPool } from '@kinqs/brainrouter-core/mcp';
import {
  discoverLocalSessionRoutes,
  deriveLegacyRemoteDeviceId,
  getLocalMessagingDeviceId,
  sanitizePeerTextForTerminal,
  sendLocalSessionMessage,
  startLocalSessionTransport,
  type LocalSessionActivityState,
  type LocalSessionMessage,
  type LocalSessionRegistrationPatch,
  type LocalSessionTransportHandle,
  type PeerSessionSenderDetails,
} from '@kinqs/brainrouter-core/session';

const HEARTBEAT_INTERVAL_MS = 30 * 1_000;
const INBOX_POLL_INTERVAL_MS = 5 * 1_000;
const MAX_UNIFIED_ROUTES = 100;
const SENDER_DISCOVERY_BUDGET_MS = 100;
const MAX_PRESENTATION_BUFFER = 100;

export type InboundPeerMessageState =
  | 'queued'
  | 'held'
  | 'applied'
  | 'expired'
  | 'rejected'
  | 'declined'
  | 'queue_full';
export type SessionTitleSource = 'derived' | 'agent' | 'hook' | 'human';
type InboundTransitionStatus = 'held' | 'applied' | 'rejected' | 'declined' | 'expired' | 'queue_full';

export interface FederationRoute {
  sessionKey: string;
  deviceId: string;
  clientKind: string;
  state: LocalSessionActivityState;
  transport: 'local' | 'remote';
  lastSeenAt: number;
  workspaceRoot?: string;
  title?: string;
  titleSource?: SessionTitleSource;
  ambiguous?: boolean;
  instanceCount?: number;
}

export interface FederationDiscoveryResult {
  routes: FederationRoute[];
  remoteError?: string;
}

export type FederationSendFailureReason =
  | 'not_found'
  | 'ambiguous'
  | 'self_send'
  | 'queue_full'
  | 'expired'
  | 'payload_too_large'
  | 'invalid_message'
  | 'id_conflict'
  | 'unreachable'
  | 'remote_unavailable'
  | 'fanout_limit'
  | 'rejected';

export type FederationSendReceipt =
  | {
      accepted: true;
      state: 'queued' | 'persisted';
      transport: 'local' | 'remote';
      messageId: string;
      targetSessionKey: string;
      duplicate?: boolean;
      pending?: number;
      wake?: 'pushed' | 'poll-fallback';
      inboxId?: string;
      recipientStatus?: SenderReceiptNotice['status'];
    }
  | {
      accepted: false;
      state: 'not-accepted';
      targetSessionKey: string;
      messageId: string;
      reason: FederationSendFailureReason;
      detail?: string;
    };

export interface FederationMessageRequest {
  targetSessionKey: string;
  kind: 'text' | 'goal-handoff';
  payload: Record<string, unknown>;
  /** Text admitted by a same-machine recipient. */
  localText: string;
  messageId?: string;
  createdAt?: number;
}

export interface FederationHandle {
  sessionKey: string;
  deviceId: string;
  clientKind: string;
  discoverSessions(): Promise<FederationDiscoveryResult>;
  resolveTarget(target: string): Promise<{ route?: FederationRoute; error?: string }>;
  sendMessage(request: FederationMessageRequest): Promise<FederationSendReceipt>;
  broadcastText(text: string, clientKind?: string): Promise<FederationSendReceipt[]>;
  pollNow(): Promise<void>;
  transitionInbound(
    inboxId: string,
    status: InboundTransitionStatus,
    reason?: string,
  ): Promise<boolean>;
  updateRegistration(
    patch: LocalSessionRegistrationPatch & { titleSource?: SessionTitleSource },
  ): Promise<FederationRoute>;
  /**
   * Stop the old participant, run the Agent/history transition with no live
   * listener, then attach the same facade to the new logical address.
   */
  rebindSession(
    nextSessionKey: string,
    transition: () => void | Promise<void>,
    registration?: Pick<FederationOptions, 'title' | 'titleSource'>,
  ): Promise<void>;
  stop(): Promise<void>;
  setOnInboxText(handler: ((messages: InboxTextMessage[]) => void | Promise<void>) | null): void;
  setOnReceipts(handler: ((receipts: SenderReceiptNotice[]) => void | Promise<void>) | null): void;
}

export interface FederationOptions {
  mcpClient: McpClientPool;
  sessionKey: string;
  workspaceRoot: string;
  /** Remote registry label. The loopback registry uses the canonical `cli`. */
  clientKind?: string;
  state?: LocalSessionActivityState;
  title?: string;
  titleSource?: SessionTitleSource;
  getUsage?: () => UsageSnapshot | undefined;
  intervalMs?: number;
  inboxIntervalMs?: number;
  onInboxText?: (messages: InboxTextMessage[]) => void | Promise<void>;
  onReceipts?: (receipts: SenderReceiptNotice[]) => void | Promise<void>;
  /** Recipient authority/held handling supplied by the CLI Agent host. */
  onPeerMessage?: (
    message: LocalSessionMessage,
    senderDetails: PeerSessionSenderDetails,
  ) => InboundPeerMessageState | Promise<InboundPeerMessageState>;
  /** Inbox failures are surfaced here; the default writes a concise stderr line. */
  onInboxError?: (error: Error) => void;
  /** Focused lifecycle-test seam; production uses Core's loopback listener. */
  startLocalTransport?: typeof startLocalSessionTransport;
}

export interface InboxTextMessage {
  id: string;
  fromSessionKey: string;
  text: string;
  receivedAt: string;
  transport: 'local' | 'remote';
  state: InboundPeerMessageState;
}

export interface SenderReceiptNotice {
  inboxId: string;
  messageId: string;
  targetSessionKey: string;
  status: 'pending' | 'held' | 'applied' | 'rejected' | 'declined' | 'expired' | 'queue_full';
  reason?: string;
}

export interface UsageSnapshot {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalUsd?: number;
  cacheSavingsUsd?: number;
}

type FederationParticipantHandle = Omit<FederationHandle, 'rebindSession'>;

interface RemoteInboxRow {
  id: string;
  messageId?: string;
  fromSessionKey: string;
  toSessionKey?: string;
  kind: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  /** Brain-owned absolute deadline; never restart its TTL at recipient poll time. */
  expiresAt?: string;
}

interface RemoteSessionRow {
  sessionKey?: string;
  clientKind?: string;
  workspaceRoot?: string;
  lastHeartbeatAt?: string;
  deviceId?: string;
  title?: string;
  titleSource?: SessionTitleSource;
  state?: LocalSessionActivityState;
  metadata?: Record<string, unknown>;
}

interface RemoteSenderReceiptRow {
  id: string;
  messageId?: string;
  toSessionKey: string;
  status?: SenderReceiptNotice['status'];
  statusReason?: string | null;
}

/**
 * A participant address is the logical Agent conversation, so a resumed host
 * can reclaim and drain durable rows after a crash. Per-incarnation listener
 * and MCP connection identities still make simultaneous live claims refuse.
 */
export function resolveFederationSessionKey(agentSessionKey: string): string {
  return exactKey(agentSessionKey);
}

/**
 * Return one stable process handle whose participant identity can be rebound
 * as the CLI changes logical conversations. All public operations share the
 * same tail, so a send can never race across the stop/transition/attach gap.
 */
export async function attachFederation(options: FederationOptions): Promise<FederationHandle> {
  let effectiveOptions: FederationOptions = {
    ...options,
    sessionKey: exactKey(options.sessionKey),
  };
  let inboxHandler = options.onInboxText ?? null;
  let receiptHandler = options.onReceipts ?? null;
  delete effectiveOptions.onInboxText;
  delete effectiveOptions.onReceipts;

  const participantOptions = (): FederationOptions => ({
    ...effectiveOptions,
    ...(inboxHandler ? { onInboxText: inboxHandler } : {}),
    ...(receiptHandler ? { onReceipts: receiptHandler } : {}),
  });

  let current = await attachFederationParticipant(participantOptions());
  let operationTail: Promise<void> = Promise.resolve();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let detachedError: Error | null = null;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const whileActive = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) return Promise.reject(new Error('Federation participant is stopping.'));
    return serialize(async () => {
      if (detachedError) {
        throw new Error(
          `Federation participant ${effectiveOptions.sessionKey} is detached: ${detachedError.message}`,
        );
      }
      return operation();
    });
  };

  const facade: FederationHandle = {
    get sessionKey() { return effectiveOptions.sessionKey; },
    get deviceId() { return current.deviceId; },
    get clientKind() { return current.clientKind; },
    discoverSessions: () => whileActive(() => current.discoverSessions()),
    resolveTarget: (target) => whileActive(() => current.resolveTarget(target)),
    sendMessage: (request) => whileActive(() => current.sendMessage(request)),
    broadcastText: (text, clientKind) =>
      whileActive(() => current.broadcastText(text, clientKind)),
    pollNow: () => whileActive(() => current.pollNow()),
    transitionInbound: (inboxId, status, reason) =>
      whileActive(() => current.transitionInbound(inboxId, status, reason)),
    updateRegistration: (patch) => whileActive(async () => {
      const route = await current.updateRegistration(patch);
      if (patch.state !== undefined) effectiveOptions.state = patch.state;
      if (patch.title !== undefined) effectiveOptions.title = patch.title;
      if (patch.titleSource !== undefined) effectiveOptions.titleSource = patch.titleSource;
      return route;
    }),
    rebindSession(nextSessionKey, transition, registration) {
      if (stopping) return Promise.reject(new Error('Federation participant is stopping.'));
      const normalized = exactKey(nextSessionKey);
      return serialize(async () => {
        const previousOptions = effectiveOptions;
        await current.stop();
        try {
          await transition();
        } catch (error) {
          try {
            current = await attachFederationParticipant(participantOptions());
            detachedError = null;
          } catch (reattachError) {
            detachedError = reattachError instanceof Error
              ? reattachError
              : new Error(String(reattachError));
          }
          throw error;
        }
        effectiveOptions = { ...previousOptions, sessionKey: normalized };
        if (registration && Object.prototype.hasOwnProperty.call(registration, 'title')) {
          if (registration.title === undefined) delete effectiveOptions.title;
          else effectiveOptions.title = registration.title;
        }
        if (registration && Object.prototype.hasOwnProperty.call(registration, 'titleSource')) {
          if (registration.titleSource === undefined) delete effectiveOptions.titleSource;
          else effectiveOptions.titleSource = registration.titleSource;
        }
        try {
          current = await attachFederationParticipant(participantOptions());
          detachedError = null;
        } catch (error) {
          detachedError = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = serialize(() => current.stop());
      return stopPromise;
    },
    setOnInboxText(handler) {
      if (stopping) return;
      inboxHandler = handler;
      current.setOnInboxText(handler);
    },
    setOnReceipts(handler) {
      if (stopping) return;
      receiptHandler = handler;
      current.setOnReceipts(handler);
    },
  };
  return facade;
}

async function attachFederationParticipant(
  options: FederationOptions,
): Promise<FederationParticipantHandle> {
  const sessionKey = exactKey(options.sessionKey);
  const clientKind = options.clientKind ?? 'brainrouter-cli';
  const deviceId = getLocalMessagingDeviceId();
  const intervalMs = validInterval(options.intervalMs, HEARTBEAT_INTERVAL_MS);
  const inboxIntervalMs = validInterval(options.inboxIntervalMs, INBOX_POLL_INTERVAL_MS);
  let state = options.state ?? 'idle';
  let title = options.title;
  let titleSource = options.titleSource;
  let stopped = false;
  let stopping = false;
  let participantStopPromise: Promise<void> | null = null;
  let generation = 0;
  let remoteRegistered = false;
  let registrationRevision = 0;
  let remoteRegistrationRevision = -1;
  let registrationAttempted = false;
  let remoteLifecycleTail: Promise<void> = Promise.resolve();
  let toolNames = new Set<string>();
  let unsubscribeWake: (() => void) | undefined;
  let activeHandler: ((messages: InboxTextMessage[]) => void | Promise<void>) | null =
    options.onInboxText ?? null;
  const buffered: InboxTextMessage[] = [];
  let activeReceiptHandler: ((receipts: SenderReceiptNotice[]) => void | Promise<void>) | null =
    options.onReceipts ?? null;
  const bufferedReceipts: SenderReceiptNotice[] = [];
  const seenReceiptStates = new Map<string, SenderReceiptNotice['status']>();
  const remoteInboxIds = new Set<string>();
  const pendingInboundTransitions = new Map<string, { status: InboundTransitionStatus; reason?: string }>();
  const inFlightTransitions = new Set<Promise<boolean>>();
  const remoteRouteCache = new Map<string, FederationRoute>();
  let lastReportedError = '';

  const reportInboxError = (error: unknown): void => {
    const normalized = new Error(sanitizePeerTextForTerminal(
      error instanceof Error ? error.message : String(error),
    ));
    if (normalized.message === lastReportedError) return;
    lastReportedError = normalized.message;
    if (options.onInboxError) options.onInboxError(normalized);
    else console.error(`[BrainRouter] session inbox: ${normalized.message}`);
  };

  const dispatch = async (messages: InboxTextMessage[]): Promise<void> => {
    if (!activeHandler) {
      const available = Math.max(0, MAX_PRESENTATION_BUFFER - buffered.length);
      buffered.push(...messages.slice(0, available));
      const omitted = Math.max(0, messages.length - available);
      if (omitted > 0) {
        reportInboxError(new Error(
          `Incoming peer-message presentation buffer is full; omitted ${omitted} banner${omitted === 1 ? '' : 's'}. Durable lifecycle state was preserved.`,
        ));
      }
      return;
    }
    try {
      await activeHandler(messages);
    } catch (error) {
      reportInboxError(error);
    }
  };

  const dispatchReceipts = async (receipts: SenderReceiptNotice[]): Promise<void> => {
    if (!activeReceiptHandler) {
      const available = Math.max(0, MAX_PRESENTATION_BUFFER - bufferedReceipts.length);
      bufferedReceipts.push(...receipts.slice(0, available));
      const omitted = Math.max(0, receipts.length - available);
      if (omitted > 0) {
        reportInboxError(new Error(
          `Sender-receipt presentation buffer is full; deferred ${omitted} receipt${omitted === 1 ? '' : 's'} to the next durable poll.`,
        ));
      }
      return;
    }
    try {
      await activeReceiptHandler(receipts);
      const terminalIds = receipts
        .filter((receipt) => !['pending', 'held'].includes(receipt.status))
        .map((receipt) => receipt.inboxId);
      if (terminalIds.length > 0 && hasMcpTool(toolNames, 'session_receipts_ack')) {
        const ack = await callMcpTool(options.mcpClient, 'session_receipts_ack', {
          sessionKey,
          ids: terminalIds,
        });
        if (ack.isError) throw new Error(ack.text || 'session_receipts_ack failed');
      }
      for (const receipt of receipts) seenReceiptStates.set(receipt.inboxId, receipt.status);
    } catch (error) {
      reportInboxError(error);
    }
  };

  const isCurrent = (expectedGeneration: number): boolean =>
    !stopped && expectedGeneration === generation;

  const commitInboundTransition = async (
    inboxId: string,
    transition: { status: InboundTransitionStatus; reason?: string },
    expectedGeneration: number,
  ): Promise<boolean> => {
    if (!isCurrent(expectedGeneration)) return false;
    const { status, reason } = transition;
    if (!hasMcpTool(toolNames, 'session_inbox_ack')) {
      reportInboxError(new Error(`Cannot transition remote inbox row ${inboxId}: session_inbox_ack is unavailable.`));
      return false;
    }
    try {
      const result = await callMcpTool<{ updated?: number }>(options.mcpClient, 'session_inbox_ack', {
        sessionKey,
        ids: [inboxId],
        status,
        ...(reason ? { reason: reason.slice(0, 512) } : {}),
      });
      if (!isCurrent(expectedGeneration)) return false;
      if (result.isError) throw new Error(result.text || 'session_inbox_ack failed');
      let confirmed = (result.parsed?.updated ?? 0) > 0;
      if (!confirmed && hasMcpTool(toolNames, 'session_inbox_read')) {
        const readback = await callMcpTool<{ messages?: Array<{ id: string; status?: string }> }>(
          options.mcpClient,
          'session_inbox_read',
          {
            sessionKey,
            peek: true,
            includeDelivered: true,
            statuses: [status],
            limit: 200,
          },
        );
        if (!isCurrent(expectedGeneration)) return false;
        if (readback.isError) throw new Error(readback.text || 'session_inbox_read confirmation failed');
        confirmed = (readback.parsed?.messages ?? [])
          .some((row) => row.id === inboxId && row.status === status);
      }
      if (!confirmed) {
        throw new Error(`Remote inbox row ${inboxId} did not confirm transition to ${status}.`);
      }
      if (pendingInboundTransitions.get(inboxId)?.status === status) {
        pendingInboundTransitions.delete(inboxId);
      }
      if (status !== 'held') remoteInboxIds.delete(inboxId);
      return true;
    } catch (error) {
      reportInboxError(error);
      return false;
    }
  };

  const transitionInbound = (
    inboxId: string,
    status: InboundTransitionStatus,
    reason?: string,
  ): Promise<boolean> => {
    if (stopped || (!remoteInboxIds.has(inboxId) && !pendingInboundTransitions.has(inboxId))) {
      return Promise.resolve(false);
    }
    const transition = { status, ...(reason ? { reason } : {}) };
    pendingInboundTransitions.set(inboxId, transition);
    const task = commitInboundTransition(inboxId, transition, generation);
    inFlightTransitions.add(task);
    void task.finally(() => { inFlightTransitions.delete(task); });
    return task;
  };

  const retryPendingInboundTransitions = async (): Promise<void> => {
    const pending = [...pendingInboundTransitions.entries()];
    for (const [inboxId, transition] of pending) {
      if (stopped) return;
      await transitionInbound(inboxId, transition.status, transition.reason);
    }
  };

  const resolveLocalSenderDetails = async (
    senderSessionKey: string,
  ): Promise<PeerSessionSenderDetails> => {
    try {
      const route = (await discoverLocalSessionRoutes()).find((candidate) =>
        candidate.sessionKey === senderSessionKey && !candidate.ambiguous);
      return peerSenderDetails(route, 'local');
    } catch {
      return { transport: 'local' };
    }
  };

  let localTransport!: LocalSessionTransportHandle;
  const remoteSenderDetailsById = new Map<string, PeerSessionSenderDetails>();
  let drainTail = Promise.resolve();
  const drainLocal = (): Promise<void> => {
    const drainGeneration = generation;
    drainTail = drainTail.then(async () => {
      if (!localTransport || !isCurrent(drainGeneration)) return;
      const drained = localTransport.drain();
      for (const notice of drained.expired) {
        if (!isCurrent(drainGeneration)) return;
        reportInboxError(new Error(`Queued peer message ${notice.messageId} expired before admission.`));
        await transitionInbound(
          notice.messageId,
          'expired',
          'Message expired before recipient admission.',
        );
        if (!isCurrent(drainGeneration)) return;
      }
      const rendered: InboxTextMessage[] = [];
      for (const message of drained.messages) {
        if (!isCurrent(drainGeneration)) return;
        const remoteSenderDetails = remoteSenderDetailsById.get(message.id);
        const senderDetails = remoteSenderDetails ?? await resolveLocalSenderDetails(message.senderSessionKey);
        if (!isCurrent(drainGeneration)) return;
        let admitted: InboundPeerMessageState = 'queued';
        try {
          admitted = await options.onPeerMessage?.(message, senderDetails) ?? 'queued';
        } catch (error) {
          admitted = 'rejected';
          reportInboxError(error);
        }
        if (!isCurrent(drainGeneration)) return;
        if (admitted !== 'queued') {
          await transitionInbound(
            message.id,
            admitted === 'held' ? 'held'
              : admitted === 'applied' ? 'applied'
                : admitted === 'expired' ? 'expired'
                  : admitted === 'declined' ? 'declined'
                    : admitted === 'queue_full' ? 'queue_full' : 'rejected',
          );
          if (!isCurrent(drainGeneration)) return;
        }
        rendered.push({
          id: message.id,
          fromSessionKey: message.senderSessionKey,
          text: message.text,
          receivedAt: new Date(message.receivedAt).toISOString(),
          transport: senderDetails.transport ?? 'local',
          state: admitted,
        });
        remoteSenderDetailsById.delete(message.id);
      }
      if (rendered.length > 0 && isCurrent(drainGeneration)) await dispatch(rendered);
    }).catch(reportInboxError);
    return drainTail;
  };

  localTransport = await (options.startLocalTransport ?? startLocalSessionTransport)({
    sessionKey,
    clientKind: 'cli',
    state,
    workspaceRoot: options.workspaceRoot,
    ...(title ? { title } : {}),
    onMessageAvailable: () => { void drainLocal(); },
  });

  const refreshCapabilities = async (expectedGeneration = generation): Promise<void> => {
    try {
      const tools = await options.mcpClient.listTools();
      if (!isCurrent(expectedGeneration)) return;
      toolNames = new Set(((tools as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name));
      lastReportedError = '';
    } catch (error) {
      if (!isCurrent(expectedGeneration)) return;
      toolNames = new Set();
      reportInboxError(new Error(`Remote session capabilities unavailable: ${errorMessage(error)}`));
    }
  };

  const serializeRemoteLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = remoteLifecycleTail.then(operation, operation);
    remoteLifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const registerRemoteNow = async (expectedGeneration = generation): Promise<boolean> => {
    if (!isCurrent(expectedGeneration)) return false;
    if (!hasMcpTool(toolNames, 'session_register') || !hasMcpTool(toolNames, 'session_heartbeat')) return false;
    registrationAttempted = true;
    const registeredRevision = registrationRevision;
    const res = await callMcpTool(options.mcpClient, 'session_register', {
      sessionKey,
      clientKind,
      workspaceRoot: options.workspaceRoot,
      deviceId,
      state,
      ...(title ? { title } : {}),
      ...(titleSource ? { titleSource } : {}),
      metadata: { pid: process.pid },
      messageWakeVersion: 1,
      usage: options.getUsage?.(),
    });
    if (res.isError) throw new Error(res.text || 'session_register failed');
    if (!isCurrent(expectedGeneration)) return false;
    remoteRegistered = true;
    remoteRegistrationRevision = Math.max(remoteRegistrationRevision, registeredRevision);
    return true;
  };

  const registerRemote = (expectedGeneration = generation): Promise<boolean> =>
    serializeRemoteLifecycle(() => registerRemoteNow(expectedGeneration));

  await refreshCapabilities();
  if (hasMcpTool(toolNames, 'session_register') && hasMcpTool(toolNames, 'session_heartbeat')) {
    try { await registerRemote(); } catch (error) { reportInboxError(error); }
  }

  let pollPromise: Promise<void> | undefined;
  let pollAgain = false;
  const pollRemoteInbox = async (): Promise<void> => {
    if (stopped || stopping || (
      !hasMcpTool(toolNames, 'session_inbox_read') &&
      !hasMcpTool(toolNames, 'session_receipts')
    )) return;
    if (pollPromise) {
      pollAgain = true;
      return pollPromise;
    }
    const pollGeneration = generation;
    pollPromise = (async () => {
      do {
        if (!isCurrent(pollGeneration)) return;
        pollAgain = false;
        await retryPendingInboundTransitions();
        if (!isCurrent(pollGeneration)) return;
        if (hasMcpTool(toolNames, 'session_inbox_read')) {
          // Resolve authenticated sender display metadata concurrently. Inbox
          // admission proceeds after a small budget even if discovery stalls.
          const senderDiscovery = discoverRemote(pollGeneration);
          const res = await callMcpTool<{ messages?: RemoteInboxRow[] }>(
            options.mcpClient,
            'session_inbox_read',
            { sessionKey, peek: true, statuses: ['pending', 'held'], limit: 200 },
          );
          if (!isCurrent(pollGeneration)) return;
          if (res.isError) throw new Error(res.text || 'session_inbox_read failed');
          await settleWithin(senderDiscovery, SENDER_DISCOVERY_BUDGET_MS);
          if (!isCurrent(pollGeneration)) return;
          for (const row of res.parsed?.messages ?? []) {
            if (!isCurrent(pollGeneration)) return;
            if (row.kind !== 'text') continue;
            const envelope = remoteEnvelope(row, sessionKey);
            remoteInboxIds.add(row.id);
            const senderDetails = remotePeerSenderDetails(row, remoteRouteCache.get(row.fromSessionKey));
            const receipt = localTransport.acceptPeerMessage(envelope);
            if (receipt.queued && !receipt.duplicate) {
              remoteSenderDetailsById.set(envelope.id, senderDetails);
            }
            if (!receipt.queued) {
              reportInboxError(new Error(`Remote message ${envelope.id} was not admitted: ${receipt.reason}.`));
              await transitionInbound(
                envelope.id,
                receipt.reason === 'expired' ? 'expired'
                  : receipt.reason === 'queue_full' ? 'queue_full' : 'rejected',
                receipt.reason === 'id_conflict'
                  ? 'The sender reused a message id with different content.'
                  : `Recipient admission refused the message: ${receipt.reason}.`,
              );
              if (!isCurrent(pollGeneration)) return;
            }
          }
          await drainLocal();
          if (!isCurrent(pollGeneration)) return;
        }
        if (hasMcpTool(toolNames, 'session_receipts')) {
          const res = await callMcpTool<{ receipts?: RemoteSenderReceiptRow[] }>(
            options.mcpClient,
            'session_receipts',
            { sessionKey, limit: 500 },
          );
          if (!isCurrent(pollGeneration)) return;
          if (res.isError) throw new Error(res.text || 'session_receipts failed');
          const notices: SenderReceiptNotice[] = [];
          for (const row of res.parsed?.receipts ?? []) {
            const status = row.status ?? 'pending';
            if (seenReceiptStates.get(row.id) === status ||
                bufferedReceipts.some((receipt) => receipt.inboxId === row.id && receipt.status === status)) continue;
            notices.push({
              inboxId: row.id,
              messageId: row.messageId ?? row.id,
              targetSessionKey: row.toSessionKey,
              status,
              ...(row.statusReason ? { reason: row.statusReason } : {}),
            });
          }
          if (notices.length > 0) await dispatchReceipts(notices);
          if (!isCurrent(pollGeneration)) return;
        }
        lastReportedError = '';
      } while (pollAgain && isCurrent(pollGeneration));
    })().catch((error) => {
      if (isCurrent(pollGeneration)) reportInboxError(error);
    }).finally(() => { pollPromise = undefined; });
    return pollPromise;
  };

  const wakeCapablePool = options.mcpClient as McpClientPool & {
    subscribeSessionMessageWakes?: (
      listener: (wake: { sessionKey: string; messageIds: string[] }) => void | Promise<void>,
    ) => () => void;
  };
  if (typeof wakeCapablePool.subscribeSessionMessageWakes === 'function') {
    unsubscribeWake = wakeCapablePool.subscribeSessionMessageWakes((wake) => {
      if (wake.sessionKey === sessionKey) return pollRemoteInbox();
    });
  }

  let heartbeatPromise: Promise<void> | undefined;
  const runHeartbeat = (): Promise<void> => {
    if (stopped || stopping) return Promise.resolve();
    if (heartbeatPromise) return heartbeatPromise;
    const heartbeatGeneration = generation;
    heartbeatPromise = (async () => {
      await refreshCapabilities(heartbeatGeneration);
      if (!isCurrent(heartbeatGeneration)) return;
      if (!hasMcpTool(toolNames, 'session_register') || !hasMcpTool(toolNames, 'session_heartbeat')) return;
      try {
        await serializeRemoteLifecycle(async () => {
          if (!isCurrent(heartbeatGeneration)) return;
          if (!remoteRegistered || remoteRegistrationRevision < registrationRevision) {
            await registerRemoteNow(heartbeatGeneration);
            return;
          }
          const res = await callMcpTool<{ updated: boolean }>(options.mcpClient, 'session_heartbeat', {
            sessionKey,
            usage: options.getUsage?.(),
          });
          if (!isCurrent(heartbeatGeneration)) return;
          if (res.isError) throw new Error(res.text || 'session_heartbeat failed');
          if (res.parsed?.updated === false) await registerRemoteNow(heartbeatGeneration);
        });
      } catch (error) {
        if (!isCurrent(heartbeatGeneration)) return;
        remoteRegistered = false;
        reportInboxError(error);
      }
    })().finally(() => { heartbeatPromise = undefined; });
    return heartbeatPromise;
  };

  const heartbeatTimer = setInterval(() => {
    if (stopped || stopping) return;
    void runHeartbeat();
  }, intervalMs);

  const inboxTimer = setInterval(() => {
    if (!stopped && !stopping) void pollRemoteInbox();
  }, inboxIntervalMs);

  async function discoverRemote(expectedGeneration = generation): Promise<{ routes: FederationRoute[]; error?: string }> {
    if (!isCurrent(expectedGeneration)) return { routes: [] };
    if (!hasMcpTool(toolNames, 'session_list')) return { routes: [] };
    try {
      const res = await callMcpTool<{ sessions?: RemoteSessionRow[] }>(
        options.mcpClient,
        'session_list',
        { includeStale: false },
      );
      if (!isCurrent(expectedGeneration)) return { routes: [] };
      if (res.isError) return { routes: [], error: res.text || 'session_list failed' };
      const routes = (res.parsed?.sessions ?? []).flatMap(remoteRoute);
      remoteRouteCache.clear();
      for (const route of routes) remoteRouteCache.set(route.sessionKey, route);
      return { routes };
    } catch (error) {
      if (!isCurrent(expectedGeneration)) return { routes: [] };
      return { routes: [], error: errorMessage(error) };
    }
  }

  const discoverMergedSessions = async (): Promise<FederationDiscoveryResult> => {
    const discoveryGeneration = generation;
    if (!isCurrent(discoveryGeneration)) return { routes: [] };
    const [local, remote] = await Promise.all([
      discoverLocalSessionRoutes(),
      discoverRemote(discoveryGeneration),
    ]);
    if (!isCurrent(discoveryGeneration)) return { routes: [] };
    const merged = new Map<string, FederationRoute>();
    for (const route of remote.routes) merged.set(route.sessionKey, route);
    for (const route of local) {
      merged.set(route.sessionKey, {
        ...route,
        clientKind: route.clientKind === 'cli' ? clientKind : route.clientKind,
        transport: 'local',
      });
    }
    return {
      routes: [...merged.values()]
        .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
      ...(remote.error ? { remoteError: remote.error } : {}),
    };
  };

  const discoverSessions = async (): Promise<FederationDiscoveryResult> => {
    const discovery = await discoverMergedSessions();
    return { ...discovery, routes: discovery.routes.slice(0, MAX_UNIFIED_ROUTES) };
  };

  const sendMessage = async (request: FederationMessageRequest): Promise<FederationSendReceipt> => {
    const messageId = request.messageId ?? randomUUID();
    const createdAt = request.createdAt ?? Date.now();
    let target: string;
    try { target = exactKey(request.targetSessionKey); }
    catch { return sendFailure(request.targetSessionKey, messageId, 'invalid_message'); }
    if (target === sessionKey) return sendFailure(target, messageId, 'self_send');

    const [localRoutes, remote] = await Promise.all([discoverLocalSessionRoutes(), discoverRemote()]);
    const local = localRoutes.find((route) => route.sessionKey === target);
    const remoteExact = remote.routes.find((route) => route.sessionKey === target);
    if (!local && !remoteExact) {
      return sendFailure(target, messageId, 'not_found', remote.error);
    }
    if (local?.ambiguous) return sendFailure(target, messageId, 'ambiguous');
    if (local) {
      const receipt = await sendLocalSessionMessage(target, {
        id: messageId,
        senderSessionKey: sessionKey,
        text: request.localText,
        createdAt,
      });
      if (receipt.queued) {
        return {
          accepted: true,
          state: 'queued',
          transport: 'local',
          messageId,
          targetSessionKey: target,
          duplicate: receipt.duplicate,
          pending: receipt.pending,
        };
      }
      if (!remoteExact || !['not_found', 'unreachable'].includes(receipt.reason)) {
        return sendFailure(target, messageId, normalizeLocalFailure(receipt.reason));
      }
    }
    if (!hasMcpTool(toolNames, 'session_send')) {
      return sendFailure(target, messageId, 'remote_unavailable', remote.error);
    }
    try {
      const payload = {
        ...request.payload,
        messageId,
        senderDeviceId: deviceId,
        senderClientKind: clientKind,
        senderWorkspaceRoot: options.workspaceRoot,
        ...(title ? { senderTitle: title } : {}),
        createdAt,
      };
      const res = await callMcpTool<{
        messageId?: string;
        accepted?: number;
        delivered?: number;
        rejectionReason?: string;
        recipients?: Array<{
          sessionKey?: string;
          inboxId?: string;
          status?: SenderReceiptNotice['status'];
          wake?: 'pushed' | 'poll-fallback';
        }>;
      }>(options.mcpClient, 'session_send', {
        messageId,
        from: sessionKey,
        to: target,
        kind: request.kind,
        payload,
      });
      if (res.isError) {
        return sendFailure(
          target,
          messageId,
          normalizeRemoteFailure(res.parsed?.rejectionReason, res.text),
          res.parsed?.rejectionReason ?? res.text,
        );
      }
      const accepted = res.parsed?.accepted ?? res.parsed?.delivered ?? 0;
      if (accepted < 1) return sendFailure(target, messageId, 'rejected', 'No recipient accepted the durable row.');
      const recipient = res.parsed?.recipients?.find((entry) => entry.sessionKey === target)
        ?? res.parsed?.recipients?.[0];
      return {
        accepted: true,
        state: 'persisted',
        transport: 'remote',
        messageId: res.parsed?.messageId ?? messageId,
        targetSessionKey: target,
        ...(recipient?.wake ? { wake: recipient.wake } : {}),
        ...(recipient?.inboxId ? { inboxId: recipient.inboxId } : {}),
        ...(recipient?.status ? { recipientStatus: recipient.status } : {}),
      };
    } catch (error) {
      return sendFailure(target, messageId, 'remote_unavailable', errorMessage(error));
    }
  };

  const handle: FederationParticipantHandle = {
    sessionKey,
    deviceId,
    clientKind,
    discoverSessions,
    async resolveTarget(target) {
      const discovery = await discoverSessions();
      const resolved = resolveFederationTarget(discovery.routes, target, sessionKey);
      if (!resolved.route && discovery.remoteError && resolved.error?.startsWith('No active')) {
        return { error: `${resolved.error} Remote discovery also failed: ${discovery.remoteError}` };
      }
      return resolved;
    },
    sendMessage,
    async broadcastText(text, wantedKind) {
      const createdAt = Date.now();
      const discovery = await discoverMergedSessions();
      const routes = discovery.routes.filter((route) =>
        route.sessionKey !== sessionKey && (!wantedKind || route.clientKind === wantedKind));
      if (routes.length > MAX_UNIFIED_ROUTES) {
        return [sendFailure(
          wantedKind ? `${wantedKind}:*` : '*',
          randomUUID(),
          'fanout_limit',
          `Broadcast matched more than ${MAX_UNIFIED_ROUTES} active recipients; nothing was sent. Narrow the client-kind filter or use exact session keys.`,
        )];
      }
      const receipts: FederationSendReceipt[] = [];
      for (const route of routes) {
        receipts.push(await sendMessage({
          targetSessionKey: route.sessionKey,
          kind: 'text',
          payload: { text },
          localText: text,
          createdAt,
        }));
      }
      return receipts;
    },
    pollNow: pollRemoteInbox,
    transitionInbound,
    async updateRegistration(patch) {
      const updateGeneration = generation;
      if (patch.state) state = patch.state;
      if (patch.title !== undefined) title = patch.title;
      if (patch.titleSource !== undefined) titleSource = patch.titleSource;
      registrationRevision += 1;
      const { titleSource: _titleSource, ...localPatch } = patch;
      const route = localTransport.updateRegistration(localPatch);
      if (isCurrent(updateGeneration) &&
          hasMcpTool(toolNames, 'session_register') &&
          hasMcpTool(toolNames, 'session_heartbeat')) {
        try { await registerRemote(updateGeneration); } catch (error) {
          if (isCurrent(updateGeneration)) {
            remoteRegistered = false;
            reportInboxError(error);
          }
        }
      }
      return { ...route, clientKind, transport: 'local' };
    },
    stop() {
      if (participantStopPromise) return participantStopPromise;
      participantStopPromise = (async () => {
        stopping = true;
        clearInterval(heartbeatTimer);
        clearInterval(inboxTimer);
        unsubscribeWake?.();
        // Finish remote work already admitted before shutting the local ingress.
        await Promise.allSettled([
          ...(pollPromise ? [pollPromise] : []),
          ...(heartbeatPromise ? [heartbeatPromise] : []),
          remoteLifecycleTail,
          ...inFlightTransitions,
        ]);
        // Core close is a quiescence barrier: after it resolves no local POST
        // can newly receive 202. Drain once more while this generation is still
        // current so every earlier acknowledgement is delivered or held.
        const [closeResult] = await Promise.allSettled([localTransport.close()]);
        if (closeResult?.status === 'rejected') reportInboxError(closeResult.reason);
        await drainLocal();
        await Promise.allSettled([drainTail, ...inFlightTransitions]);
        stopped = true;
        generation += 1;
        if (registrationAttempted && hasMcpTool(toolNames, 'session_unregister')) {
          await serializeRemoteLifecycle(() => unregisterOnce(options.mcpClient, sessionKey));
        }
        remoteRegistered = false;
      })();
      return participantStopPromise;
    },
    setOnInboxText(handler) {
      if (stopped || stopping) return;
      activeHandler = handler;
      if (handler && buffered.length > 0) {
        const replay = buffered.splice(0, buffered.length);
        void dispatch(replay);
      }
    },
    setOnReceipts(handler) {
      if (stopped || stopping) return;
      activeReceiptHandler = handler;
      if (handler && bufferedReceipts.length > 0) {
        const replay = bufferedReceipts.splice(0, bufferedReceipts.length);
        void dispatchReceipts(replay);
      }
    },
  };
  return handle;
}

export function resolveFederationTarget(
  routes: readonly FederationRoute[],
  target: string,
  selfSessionKey?: string,
): { route?: FederationRoute; error?: string } {
  const raw = target.trim();
  if (!raw) return { error: 'A target session key or prefix is required.' };
  const candidates = routes.filter((route) => route.sessionKey !== selfSessionKey);
  const nextIdle = /^([a-z][a-z0-9-]*):next-idle$/i.exec(raw);
  if (nextIdle) {
    const kind = nextIdle[1]!.toLowerCase();
    const matches = candidates
      .filter((route) => route.clientKind.toLowerCase() === kind && route.state === 'idle')
      .sort((left, right) => left.lastSeenAt - right.lastSeenAt);
    return matches[0]
      ? { route: { ...matches[0] } }
      : { error: `No idle ${kind} session is available.` };
  }
  const exact = candidates.find((route) => route.sessionKey === raw);
  if (exact) return exact.ambiguous
    ? { error: `Session key "${raw}" is claimed by multiple live processes.` }
    : { route: { ...exact } };
  const matches = candidates.filter((route) => route.sessionKey.startsWith(raw));
  if (matches.length === 1) return matches[0]!.ambiguous
    ? { error: `Session prefix "${raw}" resolves to an ambiguous live key.` }
    : { route: { ...matches[0]! } };
  if (matches.length > 1) {
    return { error: `Ambiguous session prefix "${raw}" matched ${matches.length} sessions. Use more characters.` };
  }
  return { error: `No active session matched "${raw}". Refresh /agents --remote and choose an exact key or unique prefix.` };
}

function remoteEnvelope(row: RemoteInboxRow, targetSessionKey: string) {
  const payload = row.payload ?? {};
  const text = typeof payload.text === 'string' ? payload.text : '';
  const senderDeviceId = typeof payload.senderDeviceId === 'string' && isUuid(payload.senderDeviceId)
    ? payload.senderDeviceId
    : deriveLegacyRemoteDeviceId(row.fromSessionKey);
  // The Brain owns both persistence time and absolute expiry. Pairing its
  // deadline with sender-controlled payload time could reject a valid row (or
  // let presentation metadata redefine the recipient lifecycle).
  const createdAt = Date.parse(row.createdAt);
  return {
    // The sender idempotency key is scoped by sender. The durable receipt id
    // is globally unique and therefore owns recipient dedupe and lifecycle.
    id: row.id,
    senderSessionKey: row.fromSessionKey,
    senderDeviceId,
    targetSessionKey: row.toSessionKey ?? targetSessionKey,
    text,
    createdAt,
    ...(row.expiresAt !== undefined ? { expiresAt: Date.parse(row.expiresAt) } : {}),
  };
}

/** Live authenticated discovery wins; persisted sender presentation is the
 * restart fallback after the sender unregisters. Neither grants authority. */
function remotePeerSenderDetails(
  row: RemoteInboxRow,
  route: FederationRoute | undefined,
): PeerSessionSenderDetails {
  const payload = row.payload ?? {};
  const persistedClientKind = typeof payload.senderClientKind === 'string'
    ? normalizePeerClientKind(payload.senderClientKind)
    : undefined;
  const persistedWorkspaceRoot = typeof payload.senderWorkspaceRoot === 'string' && payload.senderWorkspaceRoot
    ? payload.senderWorkspaceRoot
    : undefined;
  const persistedTitle = typeof payload.senderTitle === 'string' && payload.senderTitle
    ? payload.senderTitle
    : undefined;
  return {
    transport: 'remote',
    ...(persistedClientKind ? { clientKind: persistedClientKind } : {}),
    ...(persistedWorkspaceRoot ? { workspaceRoot: persistedWorkspaceRoot } : {}),
    ...(persistedTitle ? { title: persistedTitle } : {}),
    ...peerSenderDetails(route, 'remote'),
  };
}

function remoteRoute(row: RemoteSessionRow): FederationRoute[] {
  if (typeof row.sessionKey !== 'string' || !row.sessionKey) return [];
  const metadata = row.metadata ?? {};
  const rawState = row.state ?? metadata.state;
  const state: LocalSessionActivityState = rawState === 'working' || rawState === 'waiting' ? rawState : 'idle';
  const lastSeenAt = Date.parse(row.lastHeartbeatAt ?? '');
  const title = typeof row.title === 'string' && row.title
    ? row.title
    : typeof metadata.title === 'string' && metadata.title ? metadata.title : undefined;
  const titleSource = isTitleSource(row.titleSource)
    ? row.titleSource
    : isTitleSource(metadata.titleSource) ? metadata.titleSource : undefined;
  return [{
    sessionKey: row.sessionKey,
    deviceId: typeof row.deviceId === 'string' && row.deviceId
      ? row.deviceId
      : typeof metadata.deviceId === 'string' && metadata.deviceId
        ? metadata.deviceId
        : deriveLegacyRemoteDeviceId(row.sessionKey),
    clientKind: row.clientKind ?? 'unknown',
    state,
    transport: 'remote',
    lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : 0,
    ...(row.workspaceRoot ? { workspaceRoot: row.workspaceRoot } : {}),
    ...(title ? { title } : {}),
    ...(titleSource ? { titleSource } : {}),
  }];
}

function isTitleSource(value: unknown): value is SessionTitleSource {
  return value === 'derived' || value === 'agent' || value === 'hook' || value === 'human';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function peerSenderDetails(
  route: { clientKind: string; workspaceRoot?: string; title?: string } | undefined,
  transport: 'local' | 'remote',
): PeerSessionSenderDetails {
  const clientKind = normalizePeerClientKind(route?.clientKind);
  return {
    transport,
    ...(clientKind ? { clientKind } : {}),
    ...(route?.workspaceRoot ? { workspaceRoot: route.workspaceRoot } : {}),
    ...(route?.title ? { title: route.title } : {}),
  };
}

function normalizePeerClientKind(value: string | undefined): 'cli' | 'desktop' | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'cli' || normalized === 'brainrouter-cli') return 'cli';
  if (normalized === 'desktop' || normalized === 'brainrouter-desktop') return 'desktop';
  return undefined;
}

async function settleWithin(promise: Promise<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function exactKey(value: string): string {
  if (!value || value !== value.trim()) throw new Error('Invalid session key.');
  return value;
}

function validInterval(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 5) throw new Error('Federation interval must be at least 5ms.');
  return resolved;
}

function normalizeLocalFailure(reason: string): FederationSendFailureReason {
  return reason === 'not_found' || reason === 'ambiguous' || reason === 'self_send' ||
    reason === 'queue_full' || reason === 'expired' || reason === 'payload_too_large' ||
    reason === 'invalid_message' || reason === 'id_conflict' || reason === 'unreachable'
    ? reason
    : 'rejected';
}

function normalizeRemoteFailure(
  rejectionReason: string | undefined,
  detail: string,
): FederationSendFailureReason {
  if (rejectionReason === 'self_send') return 'self_send';
  if (rejectionReason === 'queue_full') return 'queue_full';
  if (rejectionReason === 'recipient_not_active' || rejectionReason === 'no_active_recipient') return 'not_found';
  if (rejectionReason === 'sender_not_active') return 'remote_unavailable';
  if (/idempotency key was reused/i.test(detail)) return 'id_conflict';
  return 'rejected';
}

function sendFailure(
  targetSessionKey: string,
  messageId: string,
  reason: FederationSendFailureReason,
  detail?: string,
): FederationSendReceipt {
  return {
    accepted: false,
    state: 'not-accepted',
    targetSessionKey,
    messageId,
    reason,
    ...(detail ? { detail } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function unregisterOnce(mcpClient: McpClientPool, sessionKey: string): Promise<void> {
  await Promise.race([
    callMcpTool(mcpClient, 'session_unregister', { sessionKey }).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
  ]);
}
