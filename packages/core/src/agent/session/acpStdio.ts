/**
 * ADR-050 P2c — the Agent Client Protocol (ACP) transport (JSON-RPC over stdio).
 *
 * One generic client unlocks every ACP-speaking agent (Gemini CLI is the proving
 * agent). Lifecycle: `initialize` → `session/new` (or `session/load <id>` to
 * resume) → per prompt a `session/prompt` request whose RESPONSE carries the
 * `stopReason`, while `session/update` notifications stream `agent_message_chunk`
 * text and `tool_call` activity. The agent asks permission via a REQUEST to us —
 * `session/request_permission` — which we route to `onPermission` and answer by
 * selecting the matching ACP option (allow_once / allow_always / reject_once),
 * default-denying when no handler is present (ADR-050 D3).
 *
 * The `session/update` NORMALIZER and the permission→option mapping are pure and
 * tested against the published ACP shapes (schema v0.11.x).
 */
import { JsonRpcStdio } from './jsonRpcStdio.js';
import type {
  AgentSessionDeps,
  AgentSessionEvent,
  AgentSessionHandlers,
  AgentSessionPort,
  AgentSessionSpec,
  AgentSessionTurn,
  SessionPermissionDecision,
  SessionPermissionMode,
  SessionPermissionRequest,
  SessionStopReason,
} from './types.js';

/** Pure: map the permission posture to an ACP mode id (ADR-050 D3).
 *  Undefined ⇒ no mode set (the agent's own default). */
export function acpModeId(mode?: SessionPermissionMode): string | undefined {
  switch (mode) {
    case 'full-access': return 'bypassPermissions';
    case 'auto-edit': return 'acceptEdits';
    case 'default': return 'default';
    default: return undefined;
  }
}

export type AcpNormalized = { t: 'text'; text: string } | { t: 'tool'; name: string };

/** Pure: normalize an ACP `session/update` notification. */
export function normalizeAcpUpdate(params: unknown): AcpNormalized[] {
  const out: AcpNormalized[] = [];
  const u = (params as { update?: Record<string, any> } | undefined)?.update;
  if (!u || typeof u !== 'object' || typeof u.sessionUpdate !== 'string') return out;
  if (u.sessionUpdate === 'agent_message_chunk') {
    if (u.content && u.content.type === 'text' && typeof u.content.text === 'string') out.push({ t: 'text', text: u.content.text });
  } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
    const name = typeof u.title === 'string' ? u.title : typeof u.kind === 'string' ? u.kind : 'tool';
    out.push({ t: 'tool', name });
  }
  return out;
}

/** Pure: read a permission request out of an ACP `session/request_permission` params. */
export function acpPermissionRequest(params: unknown): SessionPermissionRequest {
  const p = params as { toolCall?: Record<string, any> } | undefined;
  const tc = p?.toolCall ?? {};
  const kindRaw = typeof tc.kind === 'string' ? tc.kind : '';
  const kind: SessionPermissionRequest['kind'] =
    kindRaw === 'execute' ? 'command' : kindRaw === 'edit' ? 'file-edit' : kindRaw === 'read' ? 'file-read' : 'other';
  return {
    requestId: typeof tc.toolCallId === 'string' ? tc.toolCallId : 'acp-permission',
    kind,
    title: typeof tc.title === 'string' ? tc.title : 'The agent is requesting permission',
    ...(typeof tc.rawInput === 'string' ? { detail: tc.rawInput } : {}),
  };
}

/** Pure: map a decision to the ACP request-permission outcome, choosing from the offered options. */
export function acpPermissionOutcome(decision: SessionPermissionDecision, params: unknown): unknown {
  const options = ((params as { options?: Array<Record<string, any>> } | undefined)?.options ?? []);
  const want = decision === 'approved-for-session' ? 'allow_always' : decision === 'approved' ? 'allow_once' : 'reject_once';
  const pick = options.find((o) => o.kind === want)
    ?? options.find((o) => o.kind === (decision === 'declined' ? 'reject_always' : 'allow_always'));
  if (decision === 'declined' && !pick) return { outcome: { outcome: 'cancelled' } };
  if (!pick) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: pick.optionId } };
}

interface AcpTurn {
  onEvent: (e: AgentSessionEvent) => void;
  onPermission?: (r: SessionPermissionRequest) => Promise<SessionPermissionDecision>;
  text: string;
  done: boolean;
  settledReason?: SessionStopReason;
}

export class AcpStdioSession implements AgentSessionPort {
  readonly transport = 'acp-stdio' as const;
  private _resumeCursor?: string;
  private rpc?: JsonRpcStdio;
  private stderr = '';
  private turn?: AcpTurn;

  constructor(private readonly spec: AgentSessionSpec, private readonly deps: AgentSessionDeps = {}) {
    this._resumeCursor = spec.resumeCursor;
  }

  get resumeCursor(): string | undefined { return this._resumeCursor; }

  async open(): Promise<void> {
    if (this.rpc?.running) return;
    this.rpc = new JsonRpcStdio(
      this.spec.command, [...this.spec.args],
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (method, params) => this.onRequest(method, params),
        onStderr: (t) => { this.stderr += t; },
        onExit: () => this.settle('error', this.stderr.trim() || 'acp agent exited'),
        onError: (err) => this.settle('error', err.message),
      },
      { ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}), ...(this.spec.env ? { env: this.spec.env } : {}) },
      this.deps,
    );
    this.rpc.start();
    await this.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    if (this._resumeCursor) {
      await this.rpc.request('session/load', { sessionId: this._resumeCursor, cwd: this.spec.cwd ?? process.cwd(), mcpServers: [] });
    } else {
      const created = await this.rpc.request<{ sessionId?: string }>('session/new', { cwd: this.spec.cwd ?? process.cwd(), mcpServers: [] });
      this._resumeCursor = created?.sessionId;
      if (this._resumeCursor) this.turn?.onEvent({ kind: 'session', sessionId: this._resumeCursor });
    }
    // Best-effort posture: an agent that doesn't advertise the mode ignores it.
    const modeId = acpModeId(this.spec.permissionMode);
    if (this._resumeCursor && modeId) {
      await this.rpc.request('session/set_mode', { sessionId: this._resumeCursor, modeId }).catch(() => { /* mode not supported */ });
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !this.turn || this.turn.done) return;
    for (const n of normalizeAcpUpdate(params)) {
      if (n.t === 'text') { this.turn.text += n.text; this.turn.onEvent({ kind: 'text', delta: n.text }); }
      else this.turn.onEvent({ kind: 'tool', phase: 'start', name: n.name });
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') throw new Error(`unsupported ACP client method: ${method}`);
    const request = acpPermissionRequest(params);
    // ADR-050 D3 — no handler ⇒ default-deny.
    const decision = this.turn?.onPermission ? await this.turn.onPermission(request) : 'declined';
    return acpPermissionOutcome(decision, params);
  }

  private settle(reason: SessionStopReason, error?: string): void {
    const t = this.turn;
    if (!t || t.done) return;
    t.done = true;
    t.settledReason = reason;
    t.onEvent({ kind: 'done', reason, ...(error ? { error } : {}) });
  }

  async prompt(text: string, handlers: AgentSessionHandlers): Promise<AgentSessionTurn> {
    // Set the turn BEFORE open(): the handshake (session/new) captures the
    // session id and emits it to the active turn.
    const t: AcpTurn = { onEvent: handlers.onEvent, text: '', done: false, ...(handlers.onPermission ? { onPermission: handlers.onPermission } : {}) };
    this.turn = t;
    this.stderr = '';
    if (handlers.signal?.aborted) { this.settle('interrupted'); return { text: '', reason: 'interrupted' }; }
    const onAbort = (): void => { void this.interrupt(); };
    handlers.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (!this.rpc?.running) await this.open();
      const res = await this.rpc!.request<{ stopReason?: string }>('session/prompt', { sessionId: this._resumeCursor, prompt: [{ type: 'text', text }] });
      if (!t.done) this.settle(res?.stopReason === 'cancelled' ? 'interrupted' : 'stop');
    } catch (err) {
      if (!t.done) this.settle('error', err instanceof Error ? err.message : String(err));
    } finally {
      handlers.signal?.removeEventListener('abort', onAbort);
    }
    return { text: t.text, reason: t.settledReason ?? 'stop' };
  }

  async interrupt(): Promise<void> {
    try { this.rpc?.notify('session/cancel', { sessionId: this._resumeCursor }); } catch { /* best effort */ }
    this.settle('interrupted');
  }

  async close(): Promise<void> {
    this.settle('interrupted');
    this.rpc?.kill();
    this.rpc = undefined;
  }
}
