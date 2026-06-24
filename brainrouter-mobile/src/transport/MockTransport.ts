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

// Demo background tasks for the Activity dashboard (S-10). Shapes match the
// ported `domain/workspace/dashboard` DashTask; statuses span the lifecycle tabs.
const DEMO_TASKS: Array<Record<string, unknown>> = [
  { kind: 'agent', id: 'tk-verify', label: 'Verify recall-blend fix', role: 'verifier', status: 'running', phase: 'checking', workspaceRoot: DEMO_ROOT },
  { kind: 'workflow', id: 'tk-release', label: 'Release 0.4.15 checklist', status: 'running', phase: 'build', workspaceRoot: DEMO_ROOT },
  { kind: 'bash', id: 'tk-test', label: 'npm test — packages/types', status: 'completed', workspaceRoot: DEMO_ROOT },
  { kind: 'agent', id: 'tk-migrate', label: 'Draft schema migration', status: 'failed', error: 'timeout after 120s', workspaceRoot: DEMO_ROOT },
];

// Demo working-tree changes for the Changes screen (S-07). Mirrors the host's
// `changed-files` shape exactly: porcelain status code + workspace-relative path.
const DEMO_CHANGED = [
  { status: 'M', path: 'src/auth/token.ts' },
  { status: 'M', path: 'src/auth/token.test.ts' },
  { status: '??', path: 'src/auth/refresh.ts' },
];

// Demo review findings for the Review inbox (S-11/12). `diffHunk` feeds the
// ported reviewCode.findingRows mini-diff renderer.
const DEMO_FINDINGS = [
  {
    id: 'fnd-1',
    file: 'src/auth/token.ts',
    line: 42,
    severity: 'warn',
    title: 'Await the refresh before asserting',
    body: 'The test asserts token validity before the refresh timer flushes, which makes it flaky under load.',
    diffHunk: '@@ -40,4 +40,5 @@\n   const t = await login();\n-  expect(t.valid).toBe(true);\n+  await t.refresh();\n+  expect(t.valid).toBe(true);',
  },
  {
    id: 'fnd-2',
    file: 'src/memory/recall.ts',
    line: 88,
    severity: 'info',
    title: 'Reranker recomputes embeddings each call',
    body: 'Consider memoizing the embedding for the blended reranker to cut latency on repeat queries.',
  },
];

// Demo record sets for the More-tab surfaces (S-26/27/28/29). Shapes match the
// @kinqs/brainrouter-types records the ported view-models expect.
const DEMO_REQUIREMENTS = [
  { id: 'req_8801', title: 'Reranker blend must not regress recall@10', description: 'Keep recall@10 ≥ 0.92 after the blend change.', status: 'in-progress', priority: 'high', acceptanceCriteria: ['recall@10 ≥ 0.92'], clarifyingQuestions: [], workspaceRoot: DEMO_ROOT, taskIds: ['tk-verify'], artifactIds: ['art_3301'], linkedMemoryIds: ['mem_1'], origin: 'manual', createdAt: '2026-06-20T10:00:00Z', updatedAt: '2026-06-22T12:00:00Z' },
  { id: 'req_8802', title: 'Mobile pairing flow (QR + device token)', status: 'ready', priority: 'medium', acceptanceCriteria: [], clarifyingQuestions: [], workspaceRoot: DEMO_ROOT, taskIds: [], artifactIds: [], linkedMemoryIds: [], origin: 'manual', createdAt: '2026-06-19T09:00:00Z', updatedAt: '2026-06-19T09:00:00Z' },
  { id: 'req_8803', title: 'Archive stale worktrees weekly', status: 'done', priority: 'low', acceptanceCriteria: [], clarifyingQuestions: [], workspaceRoot: DEMO_ROOT, taskIds: [], artifactIds: [], linkedMemoryIds: [], origin: 'auto', createdAt: '2026-06-10T09:00:00Z', updatedAt: '2026-06-18T09:00:00Z' },
];

const DEMO_ANNOTATIONS = [
  { id: 'ann_5501', type: 'review-finding', status: 'open', severity: 'high', body: 'Token refresh races the assertion — await it before checking validity.', anchor: { filePath: 'src/auth/token.ts', startLine: 42 }, workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-22T11:00:00Z', updatedAt: '2026-06-22T11:00:00Z' },
  { id: 'ann_5502', type: 'diff', status: 'accepted', severity: 'medium', body: 'Pull the cache TTL into a named constant.', anchor: { filePath: 'src/memory/recall.ts', startLine: 88, endLine: 90 }, workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-21T11:00:00Z', updatedAt: '2026-06-21T11:00:00Z' },
  { id: 'ann_5503', type: 'plan', status: 'resolved', body: 'Step 2 done — context resets on session switch.', workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-20T11:00:00Z', updatedAt: '2026-06-20T11:00:00Z' },
];

const DEMO_ARTIFACTS = [
  { id: 'art_3301', kind: 'markdown-report', title: 'Recall-blend benchmark report', status: 'final', format: 'markdown', workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-22T09:00:00Z', updatedAt: '2026-06-22T09:00:00Z' },
  { id: 'art_3302', kind: 'html-prototype', title: 'Mobile session screen prototype', status: 'draft', format: 'html', workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-21T09:00:00Z', updatedAt: '2026-06-21T09:00:00Z' },
  { id: 'art_3303', kind: 'verification-summary', title: 'Auth fix verification', status: 'final', format: 'text', workspaceRoot: DEMO_ROOT, linkedMemoryIds: [], createdAt: '2026-06-20T09:00:00Z', updatedAt: '2026-06-20T09:00:00Z' },
];

const DEMO_SCHEDULES = [
  { id: 'sch_01', kind: 'cron', expr: '0 9 * * 1', command: 'weekly worktree cleanup', enabled: true, nextRun: '2026-06-29T09:00:00Z', lastRun: '2026-06-22T09:00:00Z' },
  { id: 'sch_02', kind: 'once', expr: '2026-06-25T01:21:00Z', command: 'release 0.4.15 to npm', enabled: true, nextRun: '2026-06-25T01:21:00Z' },
  { id: 'sch_03', kind: 'cron', expr: '*/30 * * * *', command: 'recall regression sweep', enabled: false, nextRun: '2026-06-24T12:30:00Z' },
];

// Demo GitHub CI checks (S-25) + git worktrees (S-30).
const DEMO_CI = [
  { name: 'build', bucket: 'pass', workflow: 'ci.yml', startedAt: '2026-06-22T10:00:00Z', completedAt: '2026-06-22T10:04:00Z' },
  { name: 'test', bucket: 'pass', workflow: 'ci.yml', startedAt: '2026-06-22T10:00:00Z', completedAt: '2026-06-22T10:07:30Z' },
  { name: 'lint', bucket: 'fail', workflow: 'ci.yml', startedAt: '2026-06-22T10:00:00Z', completedAt: '2026-06-22T10:02:00Z' },
  { name: 'e2e', bucket: 'pending', workflow: 'e2e.yml', startedAt: '2026-06-22T10:00:00Z' },
];

const DEMO_WORKTREES = {
  current: DEMO_ROOT,
  porcelain: [
    'worktree /Users/dev/BrainRouter',
    'HEAD abc1234000000000000000000000000000000000',
    'branch refs/heads/main',
    '',
    'worktree /Users/dev/BrainRouter-mobile',
    'HEAD def5678000000000000000000000000000000000',
    'branch refs/heads/brainrouter-mobile',
    '',
    'worktree /Users/dev/BrainRouter-hotfix',
    'HEAD 789abcd000000000000000000000000000000000',
    'detached',
  ].join('\n'),
};

// Demo workspace files (S-20/21) + session search hits (S-22).
const DEMO_FILES = [
  'src/auth/token.ts',
  'src/auth/token.test.ts',
  'src/memory/recall.ts',
  'src/memory/rerank.ts',
  'package.json',
  'README.md',
];

const DEMO_FILE_CONTENT: Record<string, string> = {
  'src/auth/token.ts': 'export async function refresh(token: Token): Promise<Token> {\n  // await the refresh before asserting validity\n  await token.rotate();\n  return token;\n}\n',
  'README.md': '# BrainRouter\n\nA memory-routing engine for coding agents.\n',
};

const DEMO_SEARCH = [
  { sessionKey: 'dev:fix-recall-blend', title: 'fix the reranker blend regression', snippet: '…the blend weight regressed recall@10; reverting the rerank order restores it…' },
  { sessionKey: 'dev:grid-tui', title: 'make the sidebar live', snippet: '…live sidebar updates driven off the workspace event stream…' },
];

// Demo work-item board (S-31).
const DEMO_TRACK = [
  { id: 'WI-101', title: 'Mobile pairing flow (QR + device token)', status: 'in-progress', type: 'feature' },
  { id: 'WI-102', title: 'Reranker blend recall@10 regression', status: 'todo', type: 'bug' },
  { id: 'WI-103', title: 'Release 0.4.15 to npm', status: 'todo', type: 'chore' },
  { id: 'WI-104', title: 'Weekly worktree cleanup script', status: 'done', type: 'chore' },
  { id: 'WI-105', title: 'Approval push notifications', status: 'in-progress', type: 'feature' },
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
        return { rows: this.sessionsFor(String(args.root ?? this.wsCurrent)), truncated: false };
      case 'plan-state':
        return DEMO_PLAN;
      case 'plan-history':
        return [];
      case 'list-models':
        return { models: DEMO_MODELS, current: this.model };
      case 'context-usage':
        return { used: 38_000, window: 200_000, compactAt: 160_000, limit: 160_000, pct: 19 };
      case 'fleet':
        return [];
      case 'tasks-list':
        return [];
      case 'review-current':
        return { run: { id: 'rv-1', findings: DEMO_FINDINGS }, gate: { status: 'needs-review', blocked: true, reason: '2 findings need triage before commit.' }, files: DEMO_CHANGED.length };
      case 'changed-files':
        return DEMO_CHANGED;
      case 'git-info':
        return { repo: 'BrainRouter', branch: 'brainrouter-mobile', files: DEMO_CHANGED.length, insertions: 30, deletions: 6, workspaceRoot: DEMO_ROOT };
      case 'config-snapshot':
        return { model: this.model, provider: 'openai', endpoint: null, workspaceRoot: DEMO_ROOT, sandbox: 'off', prefs: { theme: 'dark' } };
      case 'commands-catalog':
        return { commands: [] };
      case 'requirement-list':
        return DEMO_REQUIREMENTS;
      case 'annotation-list':
        return DEMO_ANNOTATIONS;
      case 'artifact-list':
        return DEMO_ARTIFACTS;
      case 'schedule-list':
        return DEMO_SCHEDULES;
      case 'ci-checks':
        return DEMO_CI;
      case 'worktrees':
        return DEMO_WORKTREES;
      case 'search': {
        const q = String(args.q ?? '').toLowerCase();
        return DEMO_SEARCH.filter((h) => !q || `${h.title} ${h.snippet}`.toLowerCase().includes(q));
      }
      case 'list-files':
        return { files: DEMO_FILES };
      case 'read-file':
        return { kind: 'file', path: String(args.path ?? ''), content: DEMO_FILE_CONTENT[String(args.path ?? '')] ?? `// ${args.path}\n// (demo content not provided for this file)\n` };
      case 'track-items':
        return DEMO_TRACK;
      case 'term-run': {
        const c = String(args.cmd ?? '');
        const head = c.split(/\s+/)[0] ?? '';
        const out = /^ls/.test(c)
          ? 'docs/  src/  package.json  README.md  app.json'
          : /^git status/.test(c)
            ? 'On branch brainrouter-mobile\nnothing to commit, working tree clean'
            : /^git branch/.test(c)
              ? '* brainrouter-mobile\n  main'
              : /^pwd/.test(c)
                ? '/Users/dev/BrainRouter'
                : /^echo /.test(c)
                  ? c.slice(5)
                  : `${head}: runs on the paired host (mock shell)`;
        return { output: out };
      }
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
      workspaces: this.wsRecents.map((workspaceRoot, idx) => ({
        workspaceRoot,
        tasks: idx === 0 ? DEMO_TASKS : [],
        reviewGate: idx === 0 ? { status: 'needs-review', blocked: true, reason: '2 findings need triage' } : null,
      })),
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
