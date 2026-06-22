/**
 * MockTransport — an in-memory BrainRouterTransport for UI development and
 * tests, mirroring the desktop `devBridge.ts`: it serves canned sessions/files/
 * plan/review data, runs an echo turn that streams an assistant reply plus a
 * tool group, and raises an approval prompt when the prompt mentions "approve"
 * (technical-doc.md §6). It lets every screen build and exercise the core loop
 * without a live `brainrouter-host`.
 *
 * Scope note (M0): this mirrors devBridge's CORE behavior and a representative
 * slice of its query surface. The full ~140-handler demo dataset is filled in
 * alongside the M1 screens that consume each query, keeping the mock honest as
 * features land rather than front-loading dead fixtures.
 */
import type { AgentCommand, AgentEvent, AgentEventMessage } from './protocol';
import type {
  BrainRouterTransport,
  ConnectionStatus,
  GlobalDashboard,
  WorkspaceRecents,
  WorkspaceSessionsResult,
} from './BrainRouterTransport';

type EventListener = (msg: AgentEventMessage) => void;
type StatusListener = (s: ConnectionStatus) => void;
type EmittedMessage = AgentEventMessage & { workspaceRoot?: string };

const DEMO_ROOT = '/Users/dev/BrainRouter';

const SESSIONS_BY_ROOT: Record<string, Array<Record<string, unknown>>> = {
  [DEMO_ROOT]: [
    { sessionKey: 'dev:fix-recall-blend', firstUserMessage: 'fix the reranker blend regression', turnCount: 24, lastRole: 'assistant', pinned: false, status: 'active' },
    { sessionKey: 'dev:grid-tui', firstUserMessage: 'make the sidebar live', turnCount: 51, lastRole: 'user', pinned: true, status: 'active' },
    { sessionKey: 'dev:release-0414', firstUserMessage: 'release 0.4.14 to npm', turnCount: 12, lastRole: 'assistant', pinned: false, status: 'completed' },
  ],
  '/Users/dev/side-project': [
    { sessionKey: 'dev:side-auth', firstUserMessage: 'add OAuth login flow', turnCount: 9, lastRole: 'assistant', status: 'active' },
  ],
};

const DEMO_PLAN = {
  items: [
    { step: 'Audit the session/context meter logic', status: 'completed' as const },
    { step: 'Reset context + plan on session switch', status: 'in_progress' as const },
    { step: 'Add a regression test for the reset path', status: 'pending' as const },
  ],
  explanation: 'Session-scoped state fix',
};

const DEMO_MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export interface MockTransportOptions {
  /** Initial active session key. */
  activeSession?: string;
  /** Initial current workspace root. */
  workspaceRoot?: string;
}

export class MockTransport implements BrainRouterTransport {
  private readonly listeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private seq = 0;
  private connectionStatus: ConnectionStatus = 'connected';
  private activeSession: string;
  private wsCurrent: string;
  private wsRecents = [DEMO_ROOT, '/Users/dev/side-project', '/Users/dev/TradingAgents'];
  private readonly trusted = new Set<string>(this.wsRecents);
  private model = 'claude-opus-4-8';

  constructor(opts: MockTransportOptions = {}) {
    this.activeSession = opts.activeSession ?? 'dev:new-chat';
    this.wsCurrent = opts.workspaceRoot ?? DEMO_ROOT;
  }

  // ── event stream ──
  private emit(event: AgentEvent, delay = 0, sessionKey: string = this.activeSession): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      const msg: EmittedMessage = {
        seq: ++this.seq,
        ts: Date.now(),
        sessionKey,
        workspaceRoot: this.wsCurrent,
        event,
      };
      this.listeners.forEach((l) => l(msg));
    }, delay);
    this.timers.add(t);
  }

  onEvent(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── command channel ──
  send(cmd: AgentCommand): void {
    switch (cmd.kind) {
      case 'start-turn':
        this.runEchoTurn(cmd.prompt);
        break;
      case 'query':
        this.dispatchQueryCommand(cmd.id, cmd.name, cmd.args ?? {});
        break;
      case 'set-model':
        this.model = cmd.model;
        this.emit({ kind: 'session-changed', sessionKey: this.activeSession, loadedMessages: 0, model: this.model, running: false }, 0);
        break;
      case 'resume-session':
        this.activeSession = cmd.sessionKey;
        this.emit({ kind: 'session-changed', sessionKey: cmd.sessionKey, loadedMessages: 0, model: this.model, running: false }, 0);
        break;
      case 'interrupt':
        this.emit({ kind: 'turn-complete', answer: '' }, 0);
        break;
      case 'interaction-response':
      case 'new-session':
      case 'shutdown':
      default:
        break;
    }
  }

  /** The canned core loop: stream a reply + a tool group, and gate on "approve". */
  private runEchoTurn(prompt: string): void {
    let d = 0;
    const step = 120;
    this.emit({ kind: 'turn-start', prompt }, (d += step));
    this.emit({ kind: 'assistant-turn-start' }, (d += step));
    this.emit({ kind: 'assistant-delta', text: 'Working on it' }, (d += step));
    this.emit({ kind: 'assistant-delta', text: '… here is what I found.' }, (d += step));
    this.emit({ kind: 'tool-start', tool: 'read_file', args: { path: 'src/memory/recall.ts' }, callId: 'c1' }, (d += step));
    this.emit({ kind: 'tool-end', tool: 'read_file', ok: true, summary: 'read src/memory/recall.ts (42 lines)', callId: 'c1' }, (d += step));

    if (/approve/i.test(prompt)) {
      this.emit(
        {
          kind: 'interaction-request',
          request: {
            id: 'mock-approval-1',
            type: 'confirm',
            title: 'Allow run_command?',
            detail: 'npm test',
            dangerous: false,
            tool: 'run_command',
          },
        },
        (d += step),
      );
    }

    this.emit({ kind: 'plan-update', items: DEMO_PLAN.items, explanation: DEMO_PLAN.explanation }, (d += step));
    this.emit({ kind: 'assistant-turn-end' }, (d += step));
    this.emit({ kind: 'tokens-updated', promptTokens: 38_000, completionTokens: 1_200, calls: 3, turns: 1, cachedTokens: 12_000 }, (d += step));
    this.emit({ kind: 'turn-complete', answer: `echo: ${prompt}` }, (d += step));
  }

  private dispatchQueryCommand(id: string, name: string, args: Record<string, unknown>): void {
    try {
      const result = this.runQuery(name, args);
      this.emit({ kind: 'query-result', id, ok: true, result }, 0);
    } catch (err) {
      this.emit({ kind: 'query-result', id, ok: false, error: err instanceof Error ? err.message : String(err) }, 0);
    }
  }

  // ── query (promise) ──
  query<T = unknown>(name: string, args?: unknown): Promise<T> {
    return Promise.resolve(this.runQuery(name, (args ?? {}) as Record<string, unknown>) as T);
  }

  /** Single dispatcher shared by the promise `query()` and the `send({query})` path. */
  private runQuery(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'list-sessions':
        return this.sessionsFor(this.wsCurrent);
      case 'workspace-sessions':
        return this.sessionsFor(String(args.root ?? this.wsCurrent));
      case 'plan-state':
        return DEMO_PLAN;
      case 'plan-history':
        return [];
      case 'list-models':
        return { models: DEMO_MODELS, current: this.model };
      case 'context-usage':
        return { used: 38_000, max: 200_000 };
      case 'fleet':
        return [];
      case 'tasks-list':
        return [];
      case 'review-current':
        return { run: null, gate: { status: 'needs-review', blocked: true, reason: 'No review has run for the current changes.' }, files: 0 };
      case 'changed-files':
        return { files: [] };
      case 'config-snapshot':
        return { model: this.model, theme: 'dark' };
      case 'commands-catalog':
        return { commands: [] };
      default:
        return null;
    }
  }

  private sessionsFor(root: string): Array<Record<string, unknown>> {
    return [...(SESSIONS_BY_ROOT[root] ?? [])].sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned),
    );
  }

  // ── Layer-1 promise methods ──
  workspaceRecents(): Promise<WorkspaceRecents> {
    return Promise.resolve({ current: this.wsCurrent, recents: [...this.wsRecents] });
  }

  workspaceSessions(root: string, _limit?: number): Promise<WorkspaceSessionsResult> {
    return Promise.resolve({ rows: this.sessionsFor(root) });
  }

  openWorkspace(root: string): Promise<{ opened: boolean; needsTrust?: boolean }> {
    if (!this.trusted.has(root)) return Promise.resolve({ opened: false, needsTrust: true });
    this.wsCurrent = root;
    return Promise.resolve({ opened: true });
  }

  isWorkspaceTrusted(root: string): Promise<{ trusted: boolean }> {
    return Promise.resolve({ trusted: this.trusted.has(root) });
  }

  trustWorkspace(root: string): Promise<{ trusted: boolean }> {
    this.trusted.add(root);
    return Promise.resolve({ trusted: true });
  }

  untrustWorkspace(root: string): Promise<{ trusted: boolean }> {
    this.trusted.delete(root);
    return Promise.resolve({ trusted: false });
  }

  trustedWorkspaces(): Promise<{ trusted: string[] }> {
    return Promise.resolve({ trusted: [...this.trusted] });
  }

  markActivity(_root: string, _reason: string): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  reorderWorkspace(dragged: string, target: string): Promise<{ recents: string[] }> {
    const next = this.wsRecents.filter((r) => r !== dragged);
    const at = next.indexOf(target);
    if (at >= 0) next.splice(at, 0, dragged);
    else next.push(dragged);
    this.wsRecents = next;
    return Promise.resolve({ recents: [...next] });
  }

  globalDashboard(): Promise<GlobalDashboard> {
    return Promise.resolve({
      workspaces: this.wsRecents.map((workspaceRoot) => ({ workspaceRoot, tasks: [], reviewGate: null })),
    });
  }

  // ── connection lifecycle ──
  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Test/utility hook to drive the status seam (e.g. simulate offline). */
  setStatus(s: ConnectionStatus): void {
    this.connectionStatus = s;
    this.statusListeners.forEach((l) => l(s));
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
