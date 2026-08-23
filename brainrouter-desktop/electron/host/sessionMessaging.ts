/**
 * ADR-034 Desktop participant service.
 *
 * One active Desktop Agent owns one authenticated loopback listener and, when
 * the Brain is reachable, one durable remote inbox registration. Local
 * discovery remains available offline. Every inbound envelope passes through
 * Core's recipient admission/hold store before typed safe-boundary steering.
 */
import { randomUUID } from 'node:crypto';
import {
  admitSessionMessage,
  approveHeldSessionMessage,
  declineHeldSessionMessage,
  deriveLegacyRemoteDeviceId,
  discoverLocalSessionRoutes,
  expireHeldSessionMessages,
  getLocalMessagingDeviceId,
  getSessionMeta,
  listHeldSessionMessages,
  findSessionRouteByKey,
  markHeldSessionMessageApplied,
  mergeSessionRoutes,
  sendLocalSessionMessage,
  setSessionTitle,
  startLocalSessionTransport,
  type HeldSessionMessageRecord,
  type LocalSessionActivityState,
  type LocalSessionMessage,
  type LocalSessionTransportHandle,
  type PeerSessionSender,
  type SessionRouteDescriptor,
} from '@kinqs/brainrouter-core/session';
import { endBrainSession, ensureBrainSession } from './brainSession.js';

type ToolResult = { isError?: boolean; content?: Array<{ type?: string; text?: string }> };

export interface DesktopPeerAgent {
  sessionKey: string;
  getAccessMode?(): 'read' | 'write' | 'shell';
  /** Optional exact enforcement audit; absent surfaces remain fail-closed. */
  getSessionMessageRecipientAuthority?(): {
    workspaceFiles?: 'denied' | 'confirm' | 'allow' | 'unknown';
    shell?: 'denied' | 'confirm' | 'allow' | 'unknown';
    computerUse?: 'denied' | 'confirm' | 'allow' | 'unknown';
    externalWrites?: 'denied' | 'confirm' | 'allow' | 'unknown';
    remoteTools?: 'denied' | 'confirm' | 'allow' | 'unknown';
  };
}

export interface DesktopPeerDeliveryResult {
  accepted: boolean;
  state: 'steered' | 'not_found' | 'queue_full' | 'unavailable';
  reason?: string;
}

export interface DesktopSessionMessagingMcp {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getActiveBrainrouterServerId?(): string | undefined;
  subscribeSessionMessageWakes?(
    listener: (wake: { sessionKey: string; messageIds: string[] }) => void | Promise<void>,
  ): () => void;
}

export interface DesktopPeerSendReceipt {
  ok: boolean;
  /** Durable sender-receipt row id; required when acknowledging terminal UI state. */
  receiptId?: string;
  messageId?: string;
  targetSessionKey?: string;
  transport?: 'local' | 'remote';
  status: 'queued' | 'pending' | 'held' | 'applied' | 'rejected' | 'declined' | 'expired' | 'queue_full' | 'not_queued';
  wording: string;
  reason?: string;
  wake?: 'pushed' | 'poll-fallback';
  updatedAt: string;
}

export interface DesktopHeldMessageView {
  id: string;
  senderSessionKey: string;
  senderDeviceId: string;
  targetSessionKey: string;
  text: string;
  status: HeldSessionMessageRecord['status'];
  holdReason: string;
  createdAt: number;
  expiresAt: number;
  appliedAt?: number;
  clientKind?: 'cli' | 'desktop';
  workspaceRoot?: string;
  title?: string;
  transport?: 'local' | 'remote';
  interactionId?: string;
}

export interface DesktopPeersSnapshot {
  ownSessionKey: string;
  brainOnline: boolean;
  routes: SessionRouteDescriptor[];
  error?: string;
}

export interface DesktopHeldConfirmation {
  interactionId: string;
  response: Promise<boolean | null>;
  /** Resolve the same generic broker request from another Desktop surface. */
  resolve(approved: boolean): boolean | void;
}

export interface DesktopSessionMessagingDeps {
  workspaceRoot: string;
  mcp: DesktopSessionMessagingMcp;
  getActiveAgent: () => DesktopPeerAgent;
  deliverPeer: (message: LocalSessionMessage, sender: PeerSessionSender) => DesktopPeerDeliveryResult;
  confirmHeld: (
    record: HeldSessionMessageRecord,
  ) => Promise<boolean | null> | DesktopHeldConfirmation;
  /** Surface bounded local-mailbox expiry notices in the addressed chat. */
  onNotice?: (sessionKey: string, message: string) => void;
  pollIntervalMs?: number;
  now?: () => number;
  /** Test seam; production uses Core's authenticated loopback transport. */
  local?: {
    start: typeof startLocalSessionTransport;
    discover: typeof discoverLocalSessionRoutes;
    send: typeof sendLocalSessionMessage;
    deviceId: typeof getLocalMessagingDeviceId;
  };
}

interface RemoteInboxRow {
  id: string;
  messageId?: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: string;
  payload: Record<string, unknown>;
  status?: string;
  createdAt: string;
  /** Brain-owned absolute deadline; never restart its TTL at recipient poll time. */
  expiresAt?: string;
}

interface RemoteReceiptRow {
  id?: string;
  messageId?: string;
  toSessionKey?: string;
  status?: string;
  statusReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

const DEFAULT_POLL_MS = 5_000;
const REMOTE_RECEIPT_STATUSES = new Set([
  'pending', 'held', 'applied', 'rejected', 'declined', 'expired', 'queue_full',
]);

/** Exact key wins; otherwise a unique key prefix is accepted. Titles never route. */
export function resolveDesktopPeerAddress(
  routes: readonly SessionRouteDescriptor[],
  rawAddress: string,
  ownSessionKey: string,
): { route?: SessionRouteDescriptor; reason?: 'empty' | 'self_send' | 'not_found' | 'ambiguous' } {
  const address = rawAddress.trim();
  if (!address) return { reason: 'empty' };
  if (address === ownSessionKey) return { reason: 'self_send' };
  const exact = findSessionRouteByKey(routes, address);
  if (exact) {
    if (exact.sessionKey === ownSessionKey) return { reason: 'self_send' };
    if (exact.ambiguous || (exact.instanceCount ?? 1) > 1) return { reason: 'ambiguous' };
    return { route: { ...exact } };
  }
  const matches = routes.filter((route) => route.sessionKey.startsWith(address));
  if (ownSessionKey.startsWith(address)) {
    return matches.length === 0 ? { reason: 'self_send' } : { reason: 'ambiguous' };
  }
  if (matches.length === 0) return { reason: 'not_found' };
  if (matches.length !== 1 || matches[0]!.ambiguous || (matches[0]!.instanceCount ?? 1) > 1) {
    return { reason: 'ambiguous' };
  }
  return { route: { ...matches[0]! } };
}

/** Sender-facing wording never upgrades mailbox persistence into application. */
export function desktopPeerReceiptWording(status: string, transport?: 'local' | 'remote', reason?: string): string {
  if (status === 'queued' && transport === 'local') return 'Queued in the recipient’s local inbox; not yet applied.';
  if (status === 'pending') return 'Persisted for the recipient; not yet applied.';
  if (status === 'held') return 'Held by the recipient for human approval.';
  if (status === 'applied') return 'Applied by the recipient at a safe boundary.';
  if (status === 'rejected') return reason ? `Rejected by the recipient: ${reason}` : 'Rejected by the recipient.';
  if (status === 'declined') return reason ? `Declined: ${reason}` : 'Declined by the recipient.';
  if (status === 'expired') return 'Expired without a durable application acknowledgement.';
  if (status === 'queue_full') return 'Not queued: the recipient inbox is full (maximum 100).';
  return reason ? `Not queued: ${reason}` : 'Not queued.';
}

export class DesktopSessionMessaging {
  private readonly now: () => number;
  private readonly local: NonNullable<DesktopSessionMessagingDeps['local']>;
  private readonly pollIntervalMs: number;
  private transport: LocalSessionTransportHandle | null = null;
  private activeAgent: DesktopPeerAgent | null = null;
  private agentState: LocalSessionActivityState = 'idle';
  private activeState: LocalSessionActivityState = 'idle';
  private title: string | undefined;
  private titleSource: 'derived' | 'agent' | 'hook' | 'human' | undefined;
  private brainOnline = false;
  private lastError = '';
  private generation = 0;
  private activationTail: Promise<void> = Promise.resolve();
  private inboundTail: Promise<void> = Promise.resolve();
  private remotePoll: { sessionKey: string; generation: number; promise: Promise<void> } | null = null;
  private remoteRegistrationTail: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWake: (() => void) | null = null;
  private readonly remoteInboxIds = new Set<string>();
  private readonly remoteAppliedIds = new Set<string>();
  private readonly senderByMessageId = new Map<string, PeerSessionSender>();
  private readonly remoteRoutesBySessionKey = new Map<string, SessionRouteDescriptor>();
  private remoteRoutesFetchedAt = 0;
  private readonly promptsInFlight = new Set<string>();
  private readonly heldConfirmations = new Map<string, DesktopHeldConfirmation>();
  private readonly panelDecisionIds = new Set<string>();
  private readonly localReceipts: DesktopPeerSendReceipt[] = [];
  private closed = false;

  constructor(private readonly deps: DesktopSessionMessagingDeps) {
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.local = deps.local ?? {
      start: startLocalSessionTransport,
      discover: discoverLocalSessionRoutes,
      send: sendLocalSessionMessage,
      deviceId: getLocalMessagingDeviceId,
    };
  }

  /** Start local first. Remote registration is best-effort and may remain offline. */
  async start(agent: DesktopPeerAgent = this.deps.getActiveAgent()): Promise<void> {
    if (this.closed) throw new Error('Desktop session messaging is closed.');
    if (!this.unsubscribeWake && this.deps.mcp.subscribeSessionMessageWakes) {
      this.unsubscribeWake = this.deps.mcp.subscribeSessionMessageWakes((wake) => {
        if (wake.sessionKey === this.activeAgent?.sessionKey) void this.pollRemote();
      });
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.pollRemote(); }, this.pollIntervalMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
    await this.activate(agent);
  }

  /** Switch the one advertised participant to the Agent the user is viewing. */
  activate(agent: DesktopPeerAgent): Promise<void> {
    const run = this.activationTail.then(() => this.activateNow(agent), () => this.activateNow(agent));
    this.activationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async activateNow(agent: DesktopPeerAgent): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const previous = this.transport;
    const previousAgent = this.activeAgent;
    this.transport = null;
    if (previous) {
      await previous.close();
      this.consumeDrain(previous, 'local', previousAgent);
    }
    this.activeAgent = agent;
    this.agentState = 'idle';
    this.activeState = 'idle';
    const meta = getSessionMeta(this.deps.workspaceRoot, agent.sessionKey);
    this.title = meta.title;
    this.titleSource = meta.titleSource ?? (meta.title ? 'human' : undefined);
    let created: LocalSessionTransportHandle | null = null;
    created = await this.local.start({
      sessionKey: agent.sessionKey,
      clientKind: 'desktop',
      state: this.activeState,
      workspaceRoot: this.deps.workspaceRoot,
      ...(this.title ? { title: this.title } : {}),
      onMessageAvailable: () => queueMicrotask(() => {
        if (this.transport === created && generation === this.generation) this.drainLocal(created!, 'local', agent);
      }),
    });
    if (this.closed || generation !== this.generation) {
      await created.close();
      this.consumeDrain(created, 'local', agent);
      return;
    }
    this.transport = created;
    await this.refreshRemote();
    if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== agent.sessionKey) return;
    await this.listRemoteRoutes(generation, agent.sessionKey).catch(() => []);
    if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== agent.sessionKey) return;
    // Recover remote inbox identity/provenance before replaying a previously
    // approved local hold, so application can acknowledge the exact inbox row.
    await this.pollRemote();
    this.recoverHeld(agent.sessionKey);
  }

  setActivity(sessionKey: string, state: LocalSessionActivityState): void {
    if (sessionKey !== this.activeAgent?.sessionKey || this.closed) return;
    this.agentState = state;
    this.publishEffectiveActivity();
  }

  private publishEffectiveActivity(): void {
    const state: LocalSessionActivityState = this.agentState === 'working'
      ? 'working'
      : this.promptsInFlight.size > 0 ? 'waiting' : this.agentState;
    if (state === this.activeState) return;
    this.activeState = state;
    try { this.transport?.updateRegistration({ state }); } catch { /* listener may be switching */ }
    void this.refreshRemote();
  }

  setTitle(
    sessionKey: string,
    title: string,
    source: 'derived' | 'agent' | 'hook' | 'human',
  ): void {
    if (sessionKey !== this.activeAgent?.sessionKey || this.closed) return;
    if (source === 'human') {
      setSessionTitle(this.deps.workspaceRoot, sessionKey, title, 'human');
    }
    this.title = title;
    this.titleSource = source;
    try { this.transport?.updateRegistration({ title }); } catch { /* listener may be switching */ }
    void this.refreshRemote();
  }

  async refreshRemote(): Promise<boolean> {
    const agent = this.activeAgent;
    if (!agent || this.closed) return false;
    const key = agent.sessionKey;
    const generation = this.generation;
    const registration = {
      sessionKey: key,
      deviceId: this.local.deviceId(),
      state: this.activeState,
      ...(this.title ? { title: this.title } : {}),
      ...(this.titleSource ? { titleSource: this.titleSource } : {}),
    };
    let resolveResult!: (registered: boolean) => void;
    const result = new Promise<boolean>((resolve) => { resolveResult = resolve; });
    const run = this.remoteRegistrationTail.then(async () => {
      if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== key) {
        resolveResult(false);
        return;
      }
      const connected = this.deps.mcp.getActiveBrainrouterServerId?.();
      if (this.deps.mcp.getActiveBrainrouterServerId && !connected) {
        this.brainOnline = false;
        resolveResult(false);
        return;
      }
      const registered = await ensureBrainSession(this.deps.mcp, this.deps.workspaceRoot, registration);
      if (!this.closed && generation === this.generation && this.activeAgent?.sessionKey === key) {
        this.brainOnline = registered;
      }
      resolveResult(registered && !this.closed && generation === this.generation && this.activeAgent?.sessionKey === key);
    }, () => { resolveResult(false); });
    void run.catch(() => { resolveResult(false); });
    this.remoteRegistrationTail = run.then(() => undefined, () => undefined);
    return result;
  }

  async listPeers(): Promise<DesktopPeersSnapshot> {
    const ownSessionKey = this.activeAgent?.sessionKey ?? '';
    const generation = this.generation;
    const [localResult, remoteResult] = await Promise.allSettled([
      this.local.discover(),
      this.listRemoteRoutes(generation, ownSessionKey),
    ]);
    const local = localResult.status === 'fulfilled' ? localResult.value : [];
    const remote = remoteResult.status === 'fulfilled' ? remoteResult.value : [];
    const error = [
      localResult.status === 'rejected' ? messageOf(localResult.reason) : '',
      remoteResult.status === 'rejected' ? messageOf(remoteResult.reason) : '',
    ].filter(Boolean).join(' ');
    this.lastError = error;
    return {
      ownSessionKey,
      brainOnline: this.brainOnline,
      routes: mergeSessionRoutes(local, remote).filter((route) => route.sessionKey !== ownSessionKey),
      ...(error ? { error } : {}),
    };
  }

  async send(address: string, text: string): Promise<DesktopPeerSendReceipt> {
    const senderSessionKey = this.activeAgent?.sessionKey ?? '';
    const body = text.trim();
    if (!senderSessionKey) return this.notQueued('No active Desktop session.');
    if (!body) return this.notQueued('Message text is required.');
    const snapshot = await this.listPeers();
    const resolved = resolveDesktopPeerAddress(snapshot.routes, address, senderSessionKey);
    if (!resolved.route) return this.notQueued(addressReason(resolved.reason), undefined, undefined);
    const route = resolved.route;
    const messageId = randomUUID();
    if (route.transport === 'local') {
      const receipt = await this.local.send(route.sessionKey, {
        id: messageId,
        senderSessionKey,
        text: body,
        createdAt: this.now(),
      });
      const view: DesktopPeerSendReceipt = receipt.queued
        ? {
            ok: true, messageId: receipt.messageId, targetSessionKey: route.sessionKey,
            transport: 'local', status: 'queued',
            wording: desktopPeerReceiptWording('queued', 'local'),
            updatedAt: new Date(receipt.acceptedAt).toISOString(),
          }
        : this.notQueued(receipt.reason, receipt.messageId, route.sessionKey, 'local');
      if (!receipt.queued &&
          (receipt.reason === 'not_found' || receipt.reason === 'unreachable') &&
          this.remoteRoutesBySessionKey.has(route.sessionKey)) {
        return this.sendRemote(route.sessionKey, body, senderSessionKey, messageId);
      }
      this.rememberLocalReceipt(view);
      return view;
    }
    return this.sendRemote(route.sessionKey, body, senderSessionKey, messageId);
  }

  private async sendRemote(
    targetSessionKey: string,
    body: string,
    senderSessionKey: string,
    messageId: string,
  ): Promise<DesktopPeerSendReceipt> {
    try {
      const rawSend = await this.deps.mcp.callTool('session_send', {
        messageId,
        from: senderSessionKey,
        to: targetSessionKey,
        kind: 'text',
        payload: {
          text: body,
          senderDeviceId: this.local.deviceId(),
          senderClientKind: 'desktop',
          ...(this.title ? { senderTitle: this.title } : {}),
          senderWorkspaceRoot: this.deps.workspaceRoot,
        },
      });
      const payload = toolJson(rawSend, true);
      if ((asRecord(rawSend) as ToolResult).isError) {
        const reason = stringValue(payload.error) || stringValue(payload.message) || 'session_send failed';
        return this.notQueued(reason, messageId, targetSessionKey, 'remote');
      }
      const accepted = Number(payload.accepted ?? 0);
      const recipient = Array.isArray(payload.recipients)
        ? asRecord(payload.recipients.find((value) => asRecord(value).sessionKey === targetSessionKey))
        : {};
      const status = accepted > 0 ? 'pending' : normalizedReceiptStatus(recipient.status ?? 'not_queued');
      const reason = stringValue(recipient.reason) || stringValue(payload.rejectionReason);
      const wake = recipient.wake === 'pushed' ? 'pushed' : recipient.wake === 'poll-fallback' ? 'poll-fallback' : undefined;
      this.brainOnline = true;
      return {
        ok: accepted > 0,
        messageId: stringValue(payload.messageId) || messageId,
        targetSessionKey,
        transport: 'remote',
        status,
        wording: desktopPeerReceiptWording(status, 'remote', reason),
        ...(reason ? { reason } : {}),
        ...(wake ? { wake } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      this.brainOnline = false;
      return this.notQueued(messageOf(error), messageId, targetSessionKey, 'remote');
    }
  }

  listHeld(): DesktopHeldMessageView[] {
    const key = this.activeAgent?.sessionKey ?? '';
    if (!key) return [];
    const expired = expireHeldSessionMessages(this.deps.workspaceRoot, this.now());
    for (const record of expired) {
      if (this.isRemoteMessage(record.id)) void this.ackRemote(record.id, 'expired', record.holdReason);
      else this.senderByMessageId.delete(record.id);
    }
    return listHeldSessionMessages(this.deps.workspaceRoot, key)
      .filter((record) => !record.appliedAt)
      .map((record) => heldView(record, this.heldConfirmations.get(record.id)?.interactionId));
  }

  async decideHeld(messageId: string, approved: boolean): Promise<DesktopHeldMessageView> {
    const confirmation = this.heldConfirmations.get(messageId);
    if (confirmation) {
      // Mark this path before settling the broker: its promise resumes on the
      // next microtask and must not apply the same decision a second time.
      this.panelDecisionIds.add(messageId);
      confirmation.resolve(approved);
    }
    return this.applyHeldDecision(messageId, approved);
  }

  private async applyHeldDecision(messageId: string, approved: boolean): Promise<DesktopHeldMessageView> {
    const key = this.activeAgent?.sessionKey ?? '';
    if (!key) throw new Error('No active Desktop session.');
    if (!approved) {
      const declined = declineHeldSessionMessage(this.deps.workspaceRoot, key, messageId, this.now());
      if (this.isRemoteMessage(declined.id)) {
        if (declined.status === 'expired') {
          await this.ackRemote(declined.id, 'expired', declined.holdReason);
        } else {
          const terminal = declined.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
          await this.ackRemote(
            declined.id,
            terminal,
            terminal === 'declined' ? 'Declined by the recipient.' : declined.holdReason,
          );
        }
      } else {
        this.senderByMessageId.delete(declined.id);
      }
      return heldView(declined);
    }
    const approvedRecord = approveHeldSessionMessage(this.deps.workspaceRoot, key, messageId, this.now());
    if (approvedRecord.record.status === 'expired') {
      if (this.isRemoteMessage(approvedRecord.record.id)) {
        await this.ackRemote(approvedRecord.record.id, 'expired', approvedRecord.record.holdReason, key);
      } else {
        this.senderByMessageId.delete(approvedRecord.record.id);
      }
      return heldView(approvedRecord.record);
    }
    if (approvedRecord.record.status === 'rejected') {
      if (this.isRemoteMessage(approvedRecord.record.id)) {
        const terminal = approvedRecord.record.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
        await this.ackRemote(approvedRecord.record.id, terminal, approvedRecord.record.holdReason, key);
      }
      return heldView(approvedRecord.record);
    }
    if (approvedRecord.input) {
      const sender = approvedRecord.input.sender;
      this.senderByMessageId.set(approvedRecord.record.id, sender);
      const delivered = this.deps.deliverPeer(approvedRecord.record, sender);
      if (!delivered.accepted) {
        if (delivered.state === 'queue_full') {
          throw new Error('The recipient steering queue is full (maximum 100). The approval remains durable for retry.');
        }
        throw new Error(delivered.reason ?? 'The approved message could not reach the active Agent.');
      }
      // Approval and safe-boundary application are separate durable states.
      // `onPeerApplied` stamps appliedAt and the remote receipt only after Core
      // has actually appended the peer observation to history/transcript.
      return heldView(approvedRecord.record);
    }
    return heldView(approvedRecord.record);
  }

  /** Called by HostCore's wrapped `onSteerApplied` callback. */
  onPeerApplied(sessionKey: string, messageId: string): void {
    const run = this.inboundTail.then(async () => {
      const record = listHeldSessionMessages(this.deps.workspaceRoot, sessionKey)
        .find((candidate) => candidate.id === messageId);
      if (record?.status === 'approved' && !record.appliedAt) {
        markHeldSessionMessageApplied(this.deps.workspaceRoot, sessionKey, messageId, this.now());
      }
      if (this.remoteInboxIds.has(messageId)) {
        this.remoteAppliedIds.add(messageId);
        await this.ackRemote(messageId, 'applied', undefined, sessionKey);
      } else {
        this.senderByMessageId.delete(messageId);
      }
    }, async () => {
      if (this.remoteInboxIds.has(messageId)) {
        this.remoteAppliedIds.add(messageId);
        await this.ackRemote(messageId, 'applied', undefined, sessionKey);
      } else {
        this.senderByMessageId.delete(messageId);
      }
    });
    this.inboundTail = run.then(() => undefined, () => undefined);
  }

  /** Called after Core revalidates an approved peer input at the real safe
   * boundary and expires it without model-visible application. */
  onPeerExpired(sessionKey: string, messageId: string): void {
    const settle = async (): Promise<void> => {
      if (this.remoteInboxIds.has(messageId)) {
        await this.ackRemote(
          messageId,
          'expired',
          'Message expired before recipient safe-boundary application.',
          sessionKey,
        );
      } else {
        this.remoteAppliedIds.delete(messageId);
        this.senderByMessageId.delete(messageId);
      }
    };
    const run = this.inboundTail.then(settle, settle);
    this.inboundTail = run.then(() => undefined, () => undefined);
  }

  async listReceipts(): Promise<DesktopPeerSendReceipt[]> {
    const key = this.activeAgent?.sessionKey ?? '';
    let remote: DesktopPeerSendReceipt[] = [];
    if (key) {
      try {
        const payload = toolJson(await this.deps.mcp.callTool('session_receipts', { sessionKey: key, limit: 200 }));
        const rows = Array.isArray(payload.receipts) ? payload.receipts.map(asRecord) : [];
        remote = rows.map((row) => receiptView(row as RemoteReceiptRow));
        this.brainOnline = true;
      } catch {
        this.brainOnline = false;
      }
    }
    return [...remote, ...this.localReceipts]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 200);
  }

  async acknowledgeReceipts(ids: string[]): Promise<{ acknowledged: number }> {
    const key = this.activeAgent?.sessionKey ?? '';
    if (!key || ids.length === 0) return { acknowledged: 0 };
    const payload = toolJson(await this.deps.mcp.callTool('session_receipts_ack', {
      sessionKey: key,
      ids: ids.slice(0, 500),
    }));
    return { acknowledged: Number(payload.acknowledged ?? 0) };
  }

  private drainLocal(
    handle: LocalSessionTransportHandle,
    transport: 'local' | 'remote' = 'local',
    recipient: DesktopPeerAgent | null = this.activeAgent,
  ): void {
    this.consumeDrain(handle, transport, recipient);
  }

  /** Consume messages and bounded expiry notices together at every drain site. */
  private consumeDrain(
    handle: LocalSessionTransportHandle,
    transport: 'local' | 'remote',
    recipient: DesktopPeerAgent | null,
  ): void {
    const drained = handle.drain();
    this.enqueueDrained(drained.messages, transport, recipient);
    const sessionKey = recipient?.sessionKey ?? handle.registration().sessionKey;
    for (const notice of drained.expired) {
      const message = `Peer message ${notice.messageId} from ${notice.senderSessionKey} expired before recipient admission.`;
      this.lastError = message;
      try { this.deps.onNotice?.(sessionKey, message); } catch { /* presentation is advisory */ }
      if (transport === 'remote') {
        void this.ackRemote(notice.messageId, 'expired', message, sessionKey);
      } else {
        this.senderByMessageId.delete(notice.messageId);
      }
    }
    if (drained.expiredOmitted > 0) {
      const message = `${drained.expiredOmitted} older peer-message expiry notice${drained.expiredOmitted === 1 ? ' was' : 's were'} omitted by the bounded local inbox.`;
      this.lastError = message;
      try { this.deps.onNotice?.(sessionKey, message); } catch { /* presentation is advisory */ }
    }
  }

  private enqueueDrained(
    messages: LocalSessionMessage[],
    transport: 'local' | 'remote',
    recipient: DesktopPeerAgent | null,
  ): void {
    for (const message of messages) {
      const run = this.inboundTail.then(
        () => this.processInbound(message, transport, recipient),
        () => this.processInbound(message, transport, recipient),
      );
      this.inboundTail = run.then(() => undefined, () => undefined);
    }
  }

  private async processInbound(
    message: LocalSessionMessage,
    transport: 'local' | 'remote',
    recipient: DesktopPeerAgent | null,
  ): Promise<void> {
    const sender = await this.senderForMessage(message, transport);
    if (!recipient || message.targetSessionKey !== recipient.sessionKey) {
      if (transport === 'remote') await this.ackRemote(
        message.id, 'rejected', 'Recipient session is no longer active.', recipient?.sessionKey ?? message.targetSessionKey,
      );
      else this.senderByMessageId.delete(message.id);
      return;
    }
    let admission: ReturnType<typeof admitSessionMessage>;
    try {
      admission = admitSessionMessage(
        this.deps.workspaceRoot,
        message,
        recipientAuthority(recipient),
        this.now(),
        peerSenderDetails(sender),
      );
    } catch (error) {
      const reason = messageOf(error);
      const queueFull = isSessionInputQueueFull(error);
      if (transport === 'remote') {
        await this.ackRemote(message.id, queueFull ? 'queue_full' : 'rejected', reason, recipient.sessionKey);
      } else if (queueFull) {
        try { this.deps.onNotice?.(recipient.sessionKey, `Peer message ${message.id} was not admitted: ${reason}`); } catch { /* advisory */ }
      }
      this.lastError = reason;
      return;
    }
    if (admission.decision === 'expired') {
      if (transport === 'remote') await this.ackRemote(message.id, 'expired', admission.record.holdReason, recipient.sessionKey);
      else this.senderByMessageId.delete(message.id);
      return;
    }
    if (admission.decision === 'rejected') {
      if (transport === 'remote') {
        const status = admission.record.terminalReceiptStatus === 'declined'
          ? 'declined'
          : 'rejected';
        await this.ackRemote(
          message.id,
          status,
          status === 'declined' ? 'Declined by the recipient.' : admission.record.holdReason,
          recipient.sessionKey,
        );
      } else {
        this.senderByMessageId.delete(message.id);
      }
      return;
    }
    if (admission.decision === 'applied') {
      if (transport === 'remote') {
        await this.ackRemote(message.id, 'applied', undefined, recipient.sessionKey);
      } else {
        this.senderByMessageId.delete(message.id);
      }
      return;
    }
    if (admission.decision === 'held') {
      // Crash replay of a prior explicit decision: never ask twice and never
      // apply twice. An approved/unapplied row is queued again; an already
      // applied row only needs its lost remote acknowledgement repeated.
      if (admission.record.status === 'approved') {
        if (admission.record.appliedAt) {
          if (transport === 'remote') await this.ackRemote(message.id, 'applied', undefined, message.targetSessionKey);
          else this.senderByMessageId.delete(message.id);
          return;
        }
        const delivered = this.deps.deliverPeer(admission.record, sender);
        if (!delivered.accepted && transport === 'remote') {
          await this.ackRemote(
            message.id,
            'held',
            'Approval is durable; safe-boundary delivery remains pending for retry.',
            message.targetSessionKey,
          );
        } else if (!delivered.accepted) {
          this.senderByMessageId.delete(message.id);
        }
        return;
      }
      if (admission.record.status === 'rejected') {
        if (transport === 'remote') {
          const status = admission.record.terminalReceiptStatus === 'declined'
            ? 'declined'
            : 'rejected';
          await this.ackRemote(
            message.id,
            status,
            status === 'declined' ? 'Declined by the recipient.' : admission.record.holdReason,
            recipient.sessionKey,
          );
        } else {
          this.senderByMessageId.delete(message.id);
        }
        return;
      }
      if (admission.record.status === 'expired') {
        if (transport === 'remote') {
          await this.ackRemote(message.id, 'expired', admission.record.holdReason, recipient.sessionKey);
        } else {
          this.senderByMessageId.delete(message.id);
        }
        return;
      }
      if (transport === 'remote') await this.ackRemote(message.id, 'held', admission.record.holdReason, recipient.sessionKey);
      void this.promptHeld(admission.record);
      return;
    }
    const approvedReplay = listHeldSessionMessages(this.deps.workspaceRoot, recipient.sessionKey)
      .find((record) => record.id === message.id && record.status === 'approved' && record.appliedAt === undefined);
    const delivered = this.deps.deliverPeer(message, sender);
    if (transport === 'remote' && !delivered.accepted) {
      if (approvedReplay) {
        await this.ackRemote(
          message.id,
          'held',
          'Approval is durable; safe-boundary delivery remains pending for retry.',
          message.targetSessionKey,
        );
      } else {
        await this.ackRemote(
          message.id,
          'rejected',
          delivered.reason ?? delivered.state,
          message.targetSessionKey,
        );
      }
    }
    if (!delivered.accepted) {
      if (transport === 'local') this.senderByMessageId.delete(message.id);
      this.lastError = delivered.reason ?? delivered.state;
    }
  }

  private async promptHeld(record: HeldSessionMessageRecord): Promise<void> {
    if (this.promptsInFlight.has(record.id) || record.targetSessionKey !== this.activeAgent?.sessionKey) return;
    this.promptsInFlight.add(record.id);
    this.publishEffectiveActivity();
    let confirmation: DesktopHeldConfirmation | undefined;
    try {
      const request = this.deps.confirmHeld(record);
      if (isHeldConfirmation(request)) {
        confirmation = request;
        this.heldConfirmations.set(record.id, request);
      }
      const approved = isHeldConfirmation(request) ? await request.response : await request;
      if (this.panelDecisionIds.delete(record.id)) return;
      // Dismissal/timeout is not a recipient rejection. The durable record
      // remains held until an explicit yes/no decision arrives.
      if (approved === null) return;
      await this.applyHeldDecision(record.id, approved);
    } catch (error) {
      this.lastError = messageOf(error);
    } finally {
      if (!confirmation || this.heldConfirmations.get(record.id) === confirmation) {
        this.heldConfirmations.delete(record.id);
      }
      this.promptsInFlight.delete(record.id);
      this.publishEffectiveActivity();
    }
  }

  private recoverHeld(sessionKey: string): void {
    for (const record of listHeldSessionMessages(this.deps.workspaceRoot, sessionKey, { status: 'approved' })) {
      if (!record.appliedAt) void this.applyHeldDecision(record.id, true).catch((error) => { this.lastError = messageOf(error); });
    }
    for (const record of listHeldSessionMessages(this.deps.workspaceRoot, sessionKey, { status: 'held' })) {
      void this.promptHeld(record);
    }
  }

  private async listRemoteRoutes(
    generation = this.generation,
    ownSessionKey = this.activeAgent?.sessionKey ?? '',
  ): Promise<SessionRouteDescriptor[]> {
    if (this.deps.mcp.getActiveBrainrouterServerId && !this.deps.mcp.getActiveBrainrouterServerId()) {
      this.brainOnline = false;
      return [];
    }
    try {
      const payload = toolJson(await this.deps.mcp.callTool('session_list', { includeStale: false }));
      const sessions = Array.isArray(payload.sessions) ? payload.sessions.map(asRecord) : [];
      if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== ownSessionKey) return [];
      this.brainOnline = true;
      const routes = sessions
        .filter((row) => row.sessionKey !== ownSessionKey)
        .map(remoteRoute)
        .filter((route): route is SessionRouteDescriptor => Boolean(route));
      this.remoteRoutesBySessionKey.clear();
      for (const route of routes) this.remoteRoutesBySessionKey.set(route.sessionKey, route);
      this.remoteRoutesFetchedAt = this.now();
      return routes;
    } catch (error) {
      this.brainOnline = false;
      throw error;
    }
  }

  private pollRemote(): Promise<void> {
    const key = this.activeAgent?.sessionKey;
    const generation = this.generation;
    if (!key || this.closed) return Promise.resolve();
    if (this.remotePoll) {
      if (this.remotePoll.sessionKey === key && this.remotePoll.generation === generation) {
        return this.remotePoll.promise;
      }
      return this.remotePoll.promise.then(() => this.pollRemote());
    }
    if (this.deps.mcp.getActiveBrainrouterServerId && !this.deps.mcp.getActiveBrainrouterServerId()) {
      this.brainOnline = false;
      return Promise.resolve();
    }
    const poll = this.pollRemoteNow(key, generation).finally(() => {
      if (this.remotePoll?.promise === poll) this.remotePoll = null;
    });
    this.remotePoll = { sessionKey: key, generation, promise: poll };
    return poll;
  }

  private async pollRemoteNow(sessionKey: string, generation: number): Promise<void> {
    try {
      if (this.now() - this.remoteRoutesFetchedAt > 30_000) {
        await this.listRemoteRoutes(generation, sessionKey).catch(() => []);
      }
      if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== sessionKey) return;
      const payload = toolJson(await this.deps.mcp.callTool('session_inbox_read', {
        sessionKey,
        peek: true,
        // Held rows remain visible after a restart so an approved/unapplied
        // record can recover its inbox id and transition only after Core's
        // onSteerApplied callback.
        statuses: ['pending', 'held'],
        limit: 100,
      }));
      if (this.closed || generation !== this.generation || this.activeAgent?.sessionKey !== sessionKey) return;
      this.brainOnline = true;
      const rows = Array.isArray(payload.messages) ? payload.messages.map(asRecord) : [];
      for (const raw of rows) {
        const recipient = this.activeAgent;
        if (this.closed || generation !== this.generation || recipient?.sessionKey !== sessionKey) return;
        const row = remoteInboxRow(raw);
        if (!row || row.toSessionKey !== sessionKey || row.fromSessionKey === sessionKey || row.kind !== 'text') {
          const id = stringValue(raw.id);
          if (id) await this.ackRemote(id, 'rejected', 'Invalid or self-addressed remote message.', sessionKey);
          continue;
        }
        const text = stringValue(row.payload.text);
        if (!text) {
          await this.ackRemote(row.id, 'rejected', 'Text payload is missing.', sessionKey);
          continue;
        }
        this.remoteInboxIds.add(row.id);
        const createdAt = Date.parse(row.createdAt);
        const sentAt = Number.isFinite(createdAt) ? createdAt : this.now();
        // Registration metadata is pinned by the authenticated session list.
        // Envelope metadata is display-only fallback and never grants authority.
        const pinnedRoute = this.remoteRoutesBySessionKey.get(row.fromSessionKey);
        const senderDeviceId = isUuid(pinnedRoute?.deviceId ?? '')
          ? pinnedRoute!.deviceId
          : isUuid(stringValue(row.payload.senderDeviceId))
            ? stringValue(row.payload.senderDeviceId)
          : deriveLegacyRemoteDeviceId(row.fromSessionKey);
        const senderClientKind = pinnedRoute?.clientKind ?? normalizeClientKind(row.payload.senderClientKind);
        this.senderByMessageId.set(row.id, {
          sessionKey: row.fromSessionKey,
          deviceId: senderDeviceId,
          ...(senderClientKind ? { clientKind: senderClientKind } : {}),
          transport: 'remote',
          sentAt,
          ...(pinnedRoute?.title || stringValue(row.payload.senderTitle)
            ? { title: pinnedRoute?.title || stringValue(row.payload.senderTitle) }
            : {}),
          ...(pinnedRoute?.workspaceRoot || stringValue(row.payload.senderWorkspaceRoot)
            ? { workspaceRoot: pinnedRoute?.workspaceRoot || stringValue(row.payload.senderWorkspaceRoot) }
            : {}),
        });
        const receipt = this.transport?.acceptPeerMessage({
          id: row.id,
          senderSessionKey: row.fromSessionKey,
          senderDeviceId,
          targetSessionKey: row.toSessionKey,
          text,
          createdAt: sentAt,
          ...(row.expiresAt !== undefined ? { expiresAt: Date.parse(row.expiresAt) } : {}),
        });
        if (!receipt) return;
        if (!receipt.queued) {
          await this.ackRemote(
            row.id,
            receipt.reason === 'expired' ? 'expired'
              : receipt.reason === 'queue_full' ? 'queue_full' : 'rejected',
            receipt.reason,
          );
          continue;
        }
        if (receipt.duplicate) await this.reconcileDuplicateRemote(row.id, sessionKey);
        else this.drainLocal(this.transport!, 'remote', recipient);
      }
    } catch {
      this.brainOnline = false;
    }
  }

  private async reconcileDuplicateRemote(messageId: string, sessionKey: string): Promise<void> {
    const record = listHeldSessionMessages(this.deps.workspaceRoot, sessionKey)
      .find((candidate) => candidate.id === messageId);
    if (!record) {
      // A duplicate mailbox read is not evidence of model application. Core's
      // delivery-id ledger will re-ack via onSteerApplied after a restart; in
      // this process we retry only an application callback already observed.
      if (this.remoteAppliedIds.has(messageId)) await this.ackRemote(messageId, 'applied', undefined, sessionKey);
      return;
    }
    if (record.status === 'held') await this.ackRemote(messageId, 'held', record.holdReason, sessionKey);
    else if (record.status === 'rejected') {
      const status = record.terminalReceiptStatus === 'declined' ? 'declined' : 'rejected';
      await this.ackRemote(messageId, status, record.holdReason, sessionKey);
    }
    else if (record.status === 'expired') await this.ackRemote(messageId, 'expired', record.holdReason, sessionKey);
    else if (record.status === 'approved' && !record.appliedAt) {
      const sender = await this.senderForMessage(record, 'remote');
      const delivered = this.deps.deliverPeer(record, sender);
      if (!delivered.accepted) {
        this.lastError = delivered.reason ?? delivered.state;
        await this.ackRemote(
          messageId,
          'held',
          'Approval is durable; safe-boundary delivery remains pending for retry.',
          sessionKey,
        );
      }
    }
    else if (record.appliedAt) await this.ackRemote(messageId, 'applied', undefined, sessionKey);
  }

  private async ackRemote(
    inboxId: string,
    status: 'held' | 'applied' | 'rejected' | 'declined' | 'expired' | 'queue_full',
    reason?: string,
    sessionKey = this.activeAgent?.sessionKey ?? '',
  ): Promise<boolean> {
    if (!sessionKey) return false;
    try {
      const payload = toolJson(await this.deps.mcp.callTool('session_inbox_ack', {
        sessionKey,
        ids: [inboxId],
        status,
        ...(reason ? { reason: reason.slice(0, 512) } : {}),
      }));
      const updated = typeof payload.updated === 'number' ? payload.updated : Number.NaN;
      if (!Number.isInteger(updated) || updated < 0 || updated > 1) {
        throw new Error('Recipient acknowledgement returned an invalid update count.');
      }
      if (updated === 0) {
        // The transition API is idempotent and legitimately reports zero when
        // another retry already reached this exact state. Verify the exact row
        // instead of treating every zero-count result as success.
        const readback = toolJson(await this.deps.mcp.callTool('session_inbox_read', {
          sessionKey,
          peek: true,
          includeDelivered: true,
          statuses: [status],
          limit: 200,
        }));
        const rows = Array.isArray(readback.messages) ? readback.messages.map(asRecord) : [];
        const exact = rows.find((row) => stringValue(row.id) === inboxId);
        if (!exact || stringValue(exact.status) !== status) {
          throw new Error(`Recipient acknowledgement for ${inboxId} was not persisted as ${status}.`);
        }
      }
      this.brainOnline = true;
      if (status !== 'held') {
        this.remoteInboxIds.delete(inboxId);
        this.remoteAppliedIds.delete(inboxId);
        this.senderByMessageId.delete(inboxId);
      }
      return true;
    } catch (error) {
      // Preserve inbox-id, applied, and provenance state for the next wake/poll
      // retry. A tool-level rejection is not proof that the Brain is offline.
      this.lastError = messageOf(error);
      return false;
    }
  }

  private isRemoteMessage(messageId: string): boolean {
    return this.remoteInboxIds.has(messageId) || this.senderByMessageId.get(messageId)?.transport === 'remote';
  }

  private async senderForMessage(
    message: LocalSessionMessage,
    transport: 'local' | 'remote',
  ): Promise<PeerSessionSender> {
    const known = this.senderByMessageId.get(message.id);
    if (known) return { ...known };
    let route: SessionRouteDescriptor | undefined;
    if (transport === 'local') {
      try {
        route = (await this.local.discover()).find((candidate) =>
          candidate.sessionKey === message.senderSessionKey && candidate.deviceId === message.senderDeviceId);
      } catch { /* authenticated envelope still carries the required identity */ }
    }
    const sender: PeerSessionSender = {
      sessionKey: message.senderSessionKey,
      deviceId: message.senderDeviceId,
      ...(route ? { clientKind: route.clientKind } : {}),
      ...(route?.workspaceRoot ? { workspaceRoot: route.workspaceRoot } : {}),
      ...(route?.title ? { title: route.title } : {}),
      transport,
      sentAt: message.createdAt,
    };
    this.senderByMessageId.set(message.id, sender);
    return { ...sender };
  }

  private notQueued(
    reason: string,
    messageId?: string,
    targetSessionKey?: string,
    transport?: 'local' | 'remote',
  ): DesktopPeerSendReceipt {
    const normalized = /queue.?full/i.test(reason) ? 'queue_full' : 'not_queued';
    return {
      ok: false,
      ...(messageId ? { messageId } : {}),
      ...(targetSessionKey ? { targetSessionKey } : {}),
      ...(transport ? { transport } : {}),
      status: normalized,
      wording: desktopPeerReceiptWording(normalized, transport, reason),
      reason,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private rememberLocalReceipt(receipt: DesktopPeerSendReceipt): void {
    this.localReceipts.unshift(receipt);
    if (this.localReceipts.length > 200) this.localReceipts.length = 200;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeWake?.();
    this.unsubscribeWake = null;
    await this.activationTail;
    await this.remotePoll?.promise;
    await this.remoteRegistrationTail;
    if (this.transport) {
      await this.transport.close();
      this.consumeDrain(this.transport, 'local', this.activeAgent);
      this.transport = null;
    }
    await this.inboundTail;
    await endBrainSession(this.deps.mcp);
  }
}

function recipientAuthority(agent: DesktopPeerAgent): {
  workspaceFiles?: 'denied' | 'confirm' | 'allow' | 'unknown';
  shell?: 'denied' | 'confirm' | 'allow' | 'unknown';
  computerUse?: 'denied' | 'confirm' | 'allow' | 'unknown';
  externalWrites?: 'denied' | 'confirm' | 'allow' | 'unknown';
  remoteTools?: 'denied' | 'confirm' | 'allow' | 'unknown';
} {
  const audited = agent.getSessionMessageRecipientAuthority?.();
  if (audited) return { ...audited };
  const access = agent.getAccessMode?.() ?? 'shell';
  if (access === 'read') {
    return {
      workspaceFiles: 'denied', shell: 'denied', computerUse: 'denied',
      externalWrites: 'unknown', remoteTools: 'unknown',
    };
  }
  return {
    workspaceFiles: 'allow',
    shell: access === 'shell' ? 'allow' : 'denied',
    computerUse: access === 'shell' ? 'allow' : 'denied',
    externalWrites: 'unknown',
    remoteTools: 'unknown',
  };
}

function heldView(record: HeldSessionMessageRecord, interactionId?: string): DesktopHeldMessageView {
  return {
    id: record.id,
    senderSessionKey: record.senderSessionKey,
    senderDeviceId: record.senderDeviceId,
    targetSessionKey: record.targetSessionKey,
    text: record.text,
    status: record.status,
    holdReason: record.holdReason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.appliedAt ? { appliedAt: record.appliedAt } : {}),
    ...(record.senderDetails?.clientKind ? { clientKind: record.senderDetails.clientKind } : {}),
    ...(record.senderDetails?.workspaceRoot ? { workspaceRoot: record.senderDetails.workspaceRoot } : {}),
    ...(record.senderDetails?.title ? { title: record.senderDetails.title } : {}),
    ...(record.senderDetails?.transport ? { transport: record.senderDetails.transport } : {}),
    ...(interactionId ? { interactionId } : {}),
  };
}

function isHeldConfirmation(
  value: Promise<boolean | null> | DesktopHeldConfirmation,
): value is DesktopHeldConfirmation {
  return Boolean(
    value && typeof value === 'object' &&
    typeof (value as DesktopHeldConfirmation).interactionId === 'string' &&
    typeof (value as DesktopHeldConfirmation).resolve === 'function' &&
    typeof (value as DesktopHeldConfirmation).response?.then === 'function',
  );
}

function peerSenderDetails(
  sender: PeerSessionSender,
): Partial<Omit<PeerSessionSender, 'sessionKey' | 'deviceId' | 'sentAt'>> {
  return {
    ...(sender.clientKind ? { clientKind: sender.clientKind } : {}),
    ...(sender.workspaceRoot ? { workspaceRoot: sender.workspaceRoot } : {}),
    ...(sender.title ? { title: sender.title } : {}),
    ...(sender.transport ? { transport: sender.transport } : {}),
  };
}

function receiptView(row: RemoteReceiptRow): DesktopPeerSendReceipt {
  const status = normalizedReceiptStatus(row.status);
  const reason = stringValue(row.statusReason);
  return {
    ok: status !== 'rejected' && status !== 'declined' && status !== 'expired' && status !== 'queue_full' && status !== 'not_queued',
    ...(row.id ? { receiptId: row.id } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.toSessionKey ? { targetSessionKey: row.toSessionKey } : {}),
    transport: 'remote',
    status,
    wording: desktopPeerReceiptWording(status, 'remote', reason),
    ...(reason ? { reason } : {}),
    updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0).toISOString(),
  };
}

function remoteRoute(raw: Record<string, unknown>): SessionRouteDescriptor | null {
  const sessionKey = stringValue(raw.sessionKey);
  if (!sessionKey) return null;
  const metadata = asRecord(raw.metadata);
  const client = stringValue(raw.clientKind).toLowerCase();
  const stateRaw = raw.state ?? metadata.state;
  const state: LocalSessionActivityState = stateRaw === 'working' || stateRaw === 'waiting' ? stateRaw : 'idle';
  const seen = Date.parse(stringValue(raw.lastHeartbeatAt));
  const advertisedDeviceId = stringValue(raw.deviceId) || stringValue(metadata.deviceId);
  return {
    sessionKey,
    deviceId: isUuid(advertisedDeviceId) ? advertisedDeviceId : deriveLegacyRemoteDeviceId(sessionKey),
    clientKind: client.includes('desktop') || client.includes('electron') ? 'desktop' : 'cli',
    state,
    transport: 'remote',
    lastSeenAt: Number.isFinite(seen) ? seen : Date.now(),
    ...(stringValue(raw.workspaceRoot) ? { workspaceRoot: stringValue(raw.workspaceRoot) } : {}),
    ...(stringValue(raw.title) || stringValue(metadata.title) ? { title: stringValue(raw.title) || stringValue(metadata.title) } : {}),
    instanceCount: 1,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeClientKind(value: unknown): 'cli' | 'desktop' | undefined {
  const kind = stringValue(value).toLowerCase();
  if (kind.includes('desktop') || kind.includes('electron')) return 'desktop';
  if (kind.includes('cli')) return 'cli';
  return undefined;
}

function remoteInboxRow(raw: Record<string, unknown>): RemoteInboxRow | null {
  const id = stringValue(raw.id);
  const fromSessionKey = stringValue(raw.fromSessionKey);
  const toSessionKey = stringValue(raw.toSessionKey);
  const kind = stringValue(raw.kind);
  const createdAt = stringValue(raw.createdAt);
  const expiresAt = stringValue(raw.expiresAt);
  if (raw.expiresAt !== undefined && !expiresAt) return null;
  if (!id || !fromSessionKey || !toSessionKey || !kind || !createdAt) return null;
  return {
    id,
    ...(stringValue(raw.messageId) ? { messageId: stringValue(raw.messageId) } : {}),
    fromSessionKey,
    toSessionKey,
    kind,
    payload: asRecord(raw.payload),
    ...(stringValue(raw.status) ? { status: stringValue(raw.status) } : {}),
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function toolJson(value: unknown, allowErrorPayload = false): Record<string, unknown> {
  const result = asRecord(value) as ToolResult;
  const text = result.content?.find((item) => typeof item.text === 'string')?.text ?? '';
  let parsed: Record<string, unknown> = {};
  try { parsed = asRecord(JSON.parse(text)); } catch { /* error text handled below */ }
  if (result.isError && !allowErrorPayload) throw new Error(text || 'BrainRouter session tool failed.');
  if (!Object.keys(parsed).length && text && result.isError) throw new Error(text);
  return parsed;
}

function normalizedReceiptStatus(value: unknown): DesktopPeerSendReceipt['status'] {
  const status = stringValue(value);
  if (REMOTE_RECEIPT_STATUSES.has(status)) return status as DesktopPeerSendReceipt['status'];
  return 'not_queued';
}

function isSessionInputQueueFull(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SESSION_INPUT_QUEUE_FULL';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addressReason(reason: ReturnType<typeof resolveDesktopPeerAddress>['reason']): string {
  if (reason === 'empty') return 'A recipient session key or unique prefix is required.';
  if (reason === 'self_send') return 'A session cannot message itself.';
  if (reason === 'ambiguous') return 'That session key prefix is ambiguous; use the full exact key.';
  return 'No live participant matches that session key or prefix.';
}
