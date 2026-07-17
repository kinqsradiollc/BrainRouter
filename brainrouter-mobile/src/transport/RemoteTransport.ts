/**
 * RemoteTransport — the live WebSocket client implementing BrainRouterTransport
 * (technical-doc §6). It is the M1 counterpart to MockTransport: it connects to a
 * `brainrouter-host`, streams AgentCommands out / AgentEventMessages in, and
 * correlates `query()` calls to their `query-result` events by id. The Layer-1
 * promise methods (workspaceRecents, …) are modelled as queries over the same
 * channel, so the host needs only ONE request surface.
 *
 * Resilience (WF-7): auto-reconnect with capped exponential backoff; on
 * (re)connect it sends a `hello` carrying the last-seen `seq` so the host can
 * replay missed events without gaps. The seq is tracked from every inbound
 * message. `WebSocketImpl` is injectable so the correlation/reconnect logic is
 * unit-testable with a fake socket.
 *
 * NOTE: this is structurally complete but UNVERIFIED until the `brainrouter-host`
 * server exists to talk to — it must be exercised end-to-end before shipping.
 */
import type { AgentCommand, AgentEventMessage } from './protocol';
import type {
  BrainRouterTransport,
  ConnectionStatus,
  GlobalDashboard,
  WorkspaceRecents,
  WorkspaceSessionsResult,
} from './BrainRouterTransport';

type EventListener = (msg: AgentEventMessage) => void;
type StatusListener = (s: ConnectionStatus) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export interface RemoteTransportOptions {
  /** Host WebSocket URL, e.g. `ws://192.168.1.20:3747`. */
  url: string;
  /** Device/pairing token, sent in the `hello` handshake. */
  token?: string;
  /** Reconnect backoff cap in ms (default 15s). */
  maxBackoffMs?: number;
  /** WebSocket constructor (defaults to the global; injectable for tests). */
  WebSocketImpl?: typeof WebSocket;
}

const WS_OPEN = 1;

export class RemoteTransport implements BrainRouterTransport {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly pending = new Map<string, Pending>();
  private connectionStatus: ConnectionStatus = 'idle';
  private counter = 0;
  private lastSeq = 0;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly url: string;
  private readonly token?: string;
  private readonly maxBackoff: number;
  private readonly WS: typeof WebSocket;

  constructor(opts: RemoteTransportOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.maxBackoff = opts.maxBackoffMs ?? 15_000;
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as typeof WebSocket);
    this.connect();
  }

  // ── connection lifecycle ──
  private connect(): void {
    if (this.disposed) return;
    this.setStatus(this.lastSeq > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.setStatus('connected');
      // Authenticate + request replay of anything after our last seq (WF-7).
      this.sendRaw({ kind: 'hello', token: this.token, afterSeq: this.lastSeq });
    };
    ws.onmessage = (ev: { data: unknown }) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.disposed) return;
      this.setStatus('offline');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* `onclose` follows and drives the reconnect */
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as AgentEventMessage;
    if (typeof msg.seq !== 'number' || !msg.event) return;

    this.lastSeq = Math.max(this.lastSeq, msg.seq);

    // A query-result settles the matching pending query() promise…
    const event = msg.event;
    if (event.kind === 'query-result') {
      const entry = this.pending.get(event.id);
      if (entry) {
        this.pending.delete(event.id);
        if (event.ok) entry.resolve(event.result);
        else entry.reject(new Error(event.error ?? 'query failed'));
      }
    }
    // …and every message is dispatched to the event stream.
    this.listeners.forEach((l) => l(msg));
  }

  private sendRaw(obj: unknown): void {
    // Dropped while offline; the host replays events via the `hello` afterSeq.
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── agent channel ──
  send(cmd: AgentCommand): void {
    this.sendRaw(cmd);
  }

  onEvent(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── query / request-response (one channel, correlated by id) ──
  query<T = unknown>(name: string, args?: unknown): Promise<T> {
    const id = `q_${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sendRaw({ kind: 'query', id, name, args: args ?? {} });
    });
  }

  // ── Layer-1 promise methods → queries over the same channel ──
  workspaceRecents(): Promise<WorkspaceRecents> {
    return this.query('workspace-recents');
  }
  workspaceSessions(root: string, limit?: number): Promise<WorkspaceSessionsResult> {
    return this.query('workspace-sessions', { root, limit });
  }
  openWorkspace(root: string): Promise<{ opened: boolean; needsTrust?: boolean }> {
    return this.query('open-workspace', { root });
  }
  isWorkspaceTrusted(root: string): Promise<{ trusted: boolean }> {
    return this.query('is-workspace-trusted', { root });
  }
  trustWorkspace(root: string): Promise<{ trusted: boolean }> {
    return this.query('trust-workspace', { root });
  }
  untrustWorkspace(root: string): Promise<{ trusted: boolean }> {
    return this.query('untrust-workspace', { root });
  }
  trustedWorkspaces(): Promise<{ trusted: string[] }> {
    return this.query('trusted-workspaces');
  }
  markActivity(root: string, reason: string): Promise<{ ok: boolean }> {
    return this.query('mark-activity', { root, reason });
  }
  reorderWorkspace(dragged: string, target: string): Promise<{ recents: string[] }> {
    return this.query('reorder-workspace', { dragged, target });
  }
  globalDashboard(): Promise<GlobalDashboard> {
    return this.query('global-dashboard');
  }

  // ── status ──
  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.connectionStatus === s) return;
    this.connectionStatus = s;
    this.statusListeners.forEach((l) => l(s));
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.listeners.clear();
    this.statusListeners.clear();
    this.pending.forEach((p) => p.reject(new Error('transport disposed')));
    this.pending.clear();
  }
}
