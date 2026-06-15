/**
 * DESK-4c — browser-dev mock bridge. In Electron the preload provides
 * `window.brainrouter`; in a plain browser (vite dev / UI work without the
 * shell) this installs a canned stand-in so every surface renders populated:
 * demo sessions, files, diff, plan, fleet, tokens, settings snapshot, the
 * command catalog, an echo turn with a tool group, and an approval dialog
 * when the prompt mentions "approve". No-op when the real bridge exists.
 */
import type { AgentCommand, AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

export function installDevBridge(): void {
  if (typeof window === 'undefined' || (window as { brainrouter?: unknown }).brainrouter) return;

  const listeners = new Set<(msg: AgentEventMessage) => void>();
  let termBuf = '';
  let seq = 0;
  // DESK-5v — CONCURRENT SESSIONS in the mock: `activeSession` is the chat on
  // screen; `runningSessions` is every chat with a turn in flight. Each event
  // is tagged with the session it belongs to (default: the viewed one) so the
  // renderer routes background turns correctly instead of stopping them.
  let activeSession = 'dev:new-chat';
  const runningSessions = new Set<string>();
  const emit = (event: AgentEvent, delay = 0, sessionKey: string = activeSession) => {
    setTimeout(() => {
      const msg: AgentEventMessage = { seq: ++seq, ts: Date.now(), sessionKey, event };
      listeners.forEach((l) => l(msg));
    }, delay);
  };

  const DEMO_DIFF = [
    'diff --git a/src/agent/agent.ts b/src/agent/agent.ts',
    '--- a/src/agent/agent.ts',
    '+++ b/src/agent/agent.ts',
    '@@ -1240,6 +1240,9 @@ export class Agent {',
    '   private mutatedThisTurn = false;',
    '   private verifiedThisTurn = false;',
    '+  // DESK-2 — cooperative turn interrupt, checked at every boundary.',
    '+  private interruptRequested = false;',
    '+',
    '   constructor(mcp: McpClientPool, llm: LlmConfig) {',
  ].join('\n');

  const prefs = {
    executionMode: 'planning', reviewPolicy: 'request', delegationPolicy: 'auto', autoChain: 'off',
    effort: 'medium', personality: 'standard', tier: null, theme: 'dark', quiet: false,
    memoriesEnabled: true, personaAnchorEnabled: true, experimental: false, rawScrollback: false, editorMode: 'emacs',
  } as Record<string, unknown>;

  // DESK-5l — stateful model, mirroring the real host (agent.getModel):
  // session-info must reflect a switch, or refreshes revert the UI.
  let devModel = 'claude-opus-4-8';
  let bootAnnounced = false;
  // DESK-5r — mock context fill: grows during a turn, drops on compaction,
  // so the composer ring's live + reset behavior is exercisable in preview.
  let devCtxUsed = 38_000;
  // DESK-5d — stateful workspaces: switching swaps the "current" root and
  // re-announces a boot session-changed, mirroring the real in-place swap.
  let wsCurrent = '/Users/dev/BrainRouter';
  let wsRecents = ['/Users/dev/BrainRouter', '/Users/dev/side-project', '/Users/dev/TradingAgents'];
  const SESSIONS_BY_ROOT: Record<string, unknown[]> = {
    '/Users/dev/BrainRouter': [
      { sessionKey: 'dev:fix-recall-blend', firstUserMessage: 'fix the reranker blend regression', modifiedAt: new Date(Date.now() - 3600_000).toISOString(), turnCount: 24, lastRole: 'assistant' },
      { sessionKey: 'dev:grid-tui', firstUserMessage: 'make the sidebar live', modifiedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), turnCount: 51, lastRole: 'user' },
      { sessionKey: 'dev:release-0414', firstUserMessage: 'release 0.4.14 to npm', modifiedAt: new Date(Date.now() - 6 * 86400_000).toISOString(), turnCount: 12, lastRole: 'assistant' },
    ],
    '/Users/dev/side-project': [
      { sessionKey: 'dev:side-auth', firstUserMessage: 'add OAuth login flow', modifiedAt: new Date(Date.now() - 2 * 86400_000).toISOString(), turnCount: 9, lastRole: 'assistant' },
      { sessionKey: 'dev:side-deploy', firstUserMessage: 'deploy to fly.io', modifiedAt: new Date(Date.now() - 9 * 86400_000).toISOString(), turnCount: 17, lastRole: 'user' },
    ],
    '/Users/dev/TradingAgents': [
      { sessionKey: 'dev:ta-backtest', firstUserMessage: 'backtest the momentum strategy', modifiedAt: new Date(Date.now() - 4 * 86400_000).toISOString(), turnCount: 31, lastRole: 'assistant' },
    ],
  };

  // DESK-6m — in-memory per-session UI meta so the ⋮ menu actions actually
  // mutate state in the preview (pin/rename/complete/archive/group/delete/fork).
  const devMeta: Record<string, { title?: string; pinned?: boolean; archived?: boolean; status?: string; group?: string | null }> = {
    'dev:grid-tui': { pinned: true },
  };
  const mergeMeta = (root: string) => (SESSIONS_BY_ROOT[root] ?? []).map((row) => {
    const s = row as { sessionKey: string; firstUserMessage?: string };
    const m = devMeta[s.sessionKey] ?? {};
    return { ...s, firstUserMessage: m.title || s.firstUserMessage, pinned: !!m.pinned, archived: !!m.archived, status: m.status ?? 'active', group: m.group ?? null };
  }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const devGroups = () => [...new Set(Object.values(devMeta).map((m) => m.group).filter((g): g is string => !!g))].sort();

  const queries: Record<string, (args: Record<string, unknown>) => unknown> = {
    'list-sessions': () => mergeMeta(wsCurrent),
    'workspace-sessions': (a) => mergeMeta(String(a.root ?? '')),
    // DESK-6m — per-chat ⋮ menu actions, mutating the in-memory devMeta.
    'action:session-meta': (a) => {
      const key = String(a.sessionKey ?? '');
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      const next = { ...(devMeta[key] ?? {}), ...patch } as Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] == null || next[k] === false || next[k] === '' || next[k] === 'active') delete next[k];
      if (Object.keys(next).length === 0) delete devMeta[key]; else devMeta[key] = next;
      return { ok: true, sessionKey: key, meta: devMeta[key] ?? {}, groups: devGroups() };
    },
    'action:session-delete': (a) => {
      const key = String(a.sessionKey ?? '');
      for (const root of Object.keys(SESSIONS_BY_ROOT)) SESSIONS_BY_ROOT[root] = (SESSIONS_BY_ROOT[root] as Array<{ sessionKey: string }>).filter((s) => s.sessionKey !== key);
      delete devMeta[key];
      return { ok: true, sessionKey: key };
    },
    'action:session-fork': (a) => {
      const key = String(a.sessionKey ?? '');
      const src = (SESSIONS_BY_ROOT[wsCurrent] as Array<{ sessionKey: string; firstUserMessage?: string }> | undefined)?.find((s) => s.sessionKey === key);
      const newKey = `${key.split(':')[0]}:fork-${Math.floor(Date.now() % 1e6).toString(36)}`;
      (SESSIONS_BY_ROOT[wsCurrent] as unknown[]).unshift({ sessionKey: newKey, firstUserMessage: `${src?.firstUserMessage ?? key} (fork)`, modifiedAt: new Date().toISOString(), turnCount: src ? 1 : 0, lastRole: 'assistant', forkedFrom: key });
      return { ok: true, newKey };
    },
    'action:session-groups': () => ({ groups: devGroups() }),
    'action:open-external': (a) => ({ ok: true, what: String(a.what ?? '') }),
    'git-pr': () => (wsCurrent === '/Users/dev/BrainRouter'
      ? { pr: { number: 395, state: 'OPEN', title: 'feat(desktop): DESK-4l — interactive views rail' } }
      : { pr: null }),
    // DESK-5w — each task tagged with the chat that owns it, so the sidebar can
    // nest it under its session and the env card scopes to the viewed chat.
    'fleet': () => [
      { kind: 'agent', id: 'agent-3f2a', label: 'explorer·3f2a — survey recall pipeline', role: 'explorer', startedAt: new Date(Date.now() - 95_000).toISOString(), worktree: false, parentSessionKey: 'dev:fix-recall-blend' },
      { kind: 'worker', id: 'wkr-91', label: 'wkr-91 · vitest suite', role: 'worker', startedAt: new Date(Date.now() - 14 * 60_000).toISOString(), worktree: true, parentSessionKey: 'dev:fix-recall-blend' },
      { kind: 'workflow', id: 'wf-build', label: 'build · Implement (2/4)', startedAt: new Date(Date.now() - 31 * 60_000).toISOString(), parentSessionKey: 'dev:grid-tui' },
    ],
    // DESK-6w — a workflow run's phase/agent breakdown for the /workflows card.
    'workflow-detail': (a) => {
      const slug = String(a.slug ?? 'build');
      const A = (label: string, role: string, status: string, tokens: number, tools: number, ms: number) => ({ id: `${label}`, label, role, status, tokens, tools, ms });
      const phases = [
        { id: 'understand', title: 'Understand', status: 'completed', agents: [
          A('map:llm-abort', 'explorer', 'completed', 48_200, 15, 105_000),
          A('map:runturn-checkpoints', 'explorer', 'completed', 85_900, 24, 198_000),
          A('map:tools-runcommand', 'explorer', 'completed', 63_800, 18, 1_033_000),
          A('map:child-agents', 'explorer', 'completed', 69_600, 19, 132_000),
        ] },
        { id: 'verify', title: 'Verify', status: 'running', agents: [
          A('verify:llm-abort', 'reviewer', 'completed', 59_000, 25, 199_000),
          A('verify:tools-runcommand', 'reviewer', 'running', 64_400, 32, 230_000),
          A('verify:child-agents', 'reviewer', 'pending', 0, 0, 0),
        ] },
        { id: 'synthesize', title: 'Synthesize', status: 'pending', agents: [] },
      ];
      let totalAgents = 0, totalTokens = 0;
      for (const p of phases) { totalAgents += p.agents.length; for (const ag of p.agents) totalTokens += ag.tokens; }
      return { slug, kind: 'build', status: 'running', startedAt: new Date(Date.now() - 24 * 60_000).toISOString(), updatedAt: new Date().toISOString(), totalAgents, totalTokens, phases, steps: [] };
    },
    // DESK-5w — a background task's conversation (read-only), shaped like a chat.
    'task-transcript': (a) => {
      const id = String(a.id ?? '');
      const kind = String(a.kind ?? 'agent');
      if (kind === 'worker') {
        return {
          id, kind, role: 'worker', status: 'running', goal: 'Run the vitest suite and report failures.',
          rows: [
            { kind: 'user', text: 'Run the vitest suite and report failures.' },
            { kind: 'tool-group', items: [
              { tool: 'run_command', summary: 'npm test', preview: '# tests 1387\n# pass 1384\n# fail 3', ok: true },
              { tool: 'read_file', summary: 'src/memory/recall.test.ts', ok: true },
            ] },
            { kind: 'assistant', text: '3 failing specs, all in `recall.test.ts` — the blend weight assertion expects **0.6/0.4**. Patching now.' },
          ],
        };
      }
      return {
        id, kind, role: 'explorer', status: 'running', goal: 'Survey the recall pipeline and map its four stages.',
        rows: [
          { kind: 'user', text: 'Survey the recall pipeline and map its four stages.' },
          { kind: 'tool-group', items: [
            { tool: 'grep_search', summary: 'recall', preview: 'src/memory/recall.ts:12: export async function recall(', ok: true },
            { tool: 'read_file', summary: 'src/memory/recall.ts', ok: true },
          ] },
          { kind: 'assistant', text: 'The pipeline runs four stages: **retrieve → rerank → judge → graph-expand**. The reranker currently *replaces* the retriever order — that\'s the blend bug.' },
        ],
      };
    },
    'session-info': () => ({ sessionKey: 'dev:demo', model: devModel, workspaceRoot: wsCurrent, username: 'anhdang' }),
    'home-stats': () => {
      const perDay: Record<string, number> = {};
      const today = new Date();
      for (let i = 0; i < 119; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        // deterministic pseudo-activity so screenshots are stable
        const n = (i * 7 + 3) % 11;
        if (n > 4) perDay[d.toISOString().slice(0, 10)] = n - 4;
      }
      return { sessions: 23, turns: 412, activeDays: 64, currentStreak: 3, longestStreak: 11, model: 'claude-opus-4-8', perDay };
    },
    'changed-files': () => [
      { status: 'M', path: 'src/agent/agent.ts' },
      { status: 'M', path: 'src/cli/ink/ChatApp.tsx' },
      { status: 'A', path: 'src/state/completionInbox.ts' },
      { status: '??', path: 'notes/scratch.md' },
    ],
    'list-files': () => ({
      files: [
        'package.json', 'README.md', 'src/agent/agent.ts', 'src/agent/tools/registry.ts',
        'src/cli/ink/ChatApp.tsx', 'src/cli/ink/components/Sidebar.tsx', 'src/cli/repl.ts',
        'src/config/config.ts', 'src/runtime/mcpPool.ts', 'src/state/completionInbox.ts',
        'src/state/sessionStore.ts', 'src/tests/interrupt.test.ts',
      ],
      truncated: false,
    }),
    'git-info': () => ({ repo: 'BrainRouter', branch: 'release/0.4.15', files: 4, insertions: 7670, deletions: 112 }),
    'git-log': () => ({ subjects: ['feat(desktop): DESK-4l — interactive views rail, tabbed bottom terminal', 'feat(desktop): DESK-4k — modern skin', 'feat(desktop): DESK-5c — file tree, real terminal'] }),
    'context-usage': () => ({ used: devCtxUsed, window: 256_000, compactAt: 80_000, limit: 80_000, pct: Math.min(1, devCtxUsed / 80_000) }),
    'git-branches': () => ({ current: 'release/0.4.15', branches: ['release/0.4.15', 'main', 'feat/desk-4j-reference-patterns', 'release/0.4.14'] }),
    'list-models': () => ({ current: devModel, models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-5.5', 'gpt-5.3-codex', 'qwen3-coder-32b', 'deepseek-v4', 'glm-5-air', 'text-embedding-nomic-embed-text-v1.5', 'whisper-large-v3'] }),
    'term-open': () => { termBuf = '\u001b[1;32mdemo-shell\u001b[0m on \u001b[1;34m/Users/dev/BrainRouter\u001b[0m\r\n$ '; return { id: 'tdemo', shell: '/bin/zsh (demo)' }; },
    'term-write': (a) => {
      const d = String(a.data ?? '');
      termBuf += d.replace('\r', '');
      if (d.includes('\r')) termBuf += '\r\n(demo) executed in the workspace\r\n$ ';
      return { ok: true };
    },
    'term-read': (a) => { const from = Number(a.from) || 0; return { chunk: termBuf.slice(from), next: termBuf.length, alive: true }; },
    'term-kill': () => ({ ok: true }),
    'file-diff': (a) => ({ path: String(a.path ?? 'src/agent/agent.ts'), diff: DEMO_DIFF }),
    'read-file': (a) => ({
      path: String(a.path ?? 'src/state/completionInbox.ts'),
      content: [
        '/** Completion inbox — detached workers report back here. */',
        "import { randomUUID } from 'node:crypto';",
        '',
        'export interface Completion {',
        '  id: string;',
        '  parentSessionKey: string;',
        '  summary: string;',
        '}',
        ...Array.from({ length: 20 }, (_, i) => `// line ${i + 9}`),
      ].join('\n'),
    }),
    'commands-catalog': () => ({
      categories: [
        { key: 'session', title: 'Session & State', entries: [
          { cmd: '/new [label]', desc: 'Start a new chat with a fresh session key' },
          { cmd: '/clear', desc: 'Clear chat history for the active session' },
          { cmd: '/compact', desc: 'LLM-driven compaction of the active session' },
          { cmd: '/resume <id>', desc: 'Resume a previous session by sessionKey' },
          { cmd: '/find <query>', desc: 'Search this session transcript' },
          { cmd: '/recap', desc: 'Instant summary of this session' },
          { cmd: '/chapters', desc: 'Table of contents from chapter markers' },
          { cmd: '/export-chat [md|json]', desc: 'Export this session transcript to a file' },
        ] },
        { key: 'guard', title: 'Guardrails & Permissions', entries: [
          { cmd: '/permissions [read|write|shell]', desc: 'View or set agent access mode' },
          { cmd: '/mode [planning|fast]', desc: 'Session execution stance' },
          { cmd: '/yolo [on|off]', desc: 'Fast mode + proceed review policy' },
          { cmd: '/hooks [list|add|remove]', desc: 'Lifecycle shell hooks' },
        ] },
        { key: 'obs', title: 'Observability', entries: [
          { cmd: '/usage', desc: 'Per-actor token breakdown' },
          { cmd: '/tokens', desc: 'Session token usage' },
          { cmd: '/context [all|current]', desc: 'Context-window fill' },
        ] },
        { key: 'workflow', title: 'Workflows & Skills', entries: [
          { cmd: '/review [scope] [--fix]', desc: 'Multi-agent code review' },
          { cmd: '/goal [text|clear]', desc: 'Sticky goal' },
          { cmd: '/plan', desc: 'Show the durable CLI task plan' },
          { cmd: '/diff', desc: 'Show git changes' },
        ] },
      ],
      all: ['/help', '/status', '/model', '/mcp', '/theme', '/vim', '/spawn', '/bg', '/workers', '/ps'],
    }),
    'config-snapshot': () => ({
      model: 'claude-opus-4-8', provider: 'anthropic', fallbackModel: null,
      workspaceRoot: '/Users/dev/BrainRouter', sandbox: 'off', prefs: { ...prefs },
      permissionRules: { allow: ['run_command(git *)', 'run_command(npm test*)'], deny: ['run_command(rm -rf *)'] },
      hooks: [
        { id: 'h1', event: 'pre-tool', command: './hooks/guard-prod.sh', enabled: true, match: 'run_command' },
        { id: 'h2', event: 'user-prompt-submit', command: './hooks/inject-ticket.sh', enabled: false },
      ],
      servers: [{ id: 'brainrouter', online: true }, { id: 'github', online: false }],
    }),
    'usage-breakdown': () => [
      'parent      48,213 in · 1,904 out · cache hit 92%',
      'explorer·3f2a   12,408 in · 822 out',
      'worker·91        8,114 in · 1,201 out',
      'TOTAL       68,735 in · 3,927 out',
      'offload: 31% of parent context avoided via child agents',
    ],
    'search-transcript': (a) => [
      { index: 3, role: 'assistant', snippet: `…the reranker ${String(a.q ?? 'blend')} replaces the retriever order — fix is a weighted blend…` },
      { index: 7, role: 'user', snippet: `…can you re-run the sweep after the ${String(a.q ?? 'blend')} change…` },
    ],
    'chapters': () => [
      { title: 'Reproduce the regression', summary: '6-split sweep, MemBench drop isolated' },
      { title: 'Patch the blend scoring', summary: '0.6·rerank + 0.4·rrf' },
    ],
    'export-chat': () => ({ filename: 'dev-demo.md', content: '# BrainRouter session transcript\n\n- Session: dev:demo\n\n…' }),
    'recap': () => ['Last prompt: fix the reranker blend regression', 'Files touched: src/memory/recall.ts', 'Open plan: 2/3 done'],
    'action:clear': () => ({ ok: true }),
    'action:compact': () => ({ summary: 'Early exploration compacted; kept the blend fix decision and the sweep numbers.', estimatedTokens: 412, durationMs: 1830, replacedMessages: 14 }),
    'action:set-pref': (a) => { prefs[String(a.key)] = a.value; return { ...prefs }; },
    'action:set-hook': () => ({ ok: true }),
    'action:set-access': (a) => ({ ok: true, mode: a.mode }),
    'action:reconnect-mcp': () => ({ ok: true }),
    'search-content': (a) => [
      { file: 'src/memory/recall.ts', line: 42, snippet: `const blended = 0.6 * rerank + 0.4 * rrf; // ${String(a.q ?? '')}` },
      { file: 'src/agent/agent.ts', line: 1240, snippet: 'private interruptRequested = false;' },
    ],
    'transcript': (a) => {
      // DESK-6t — real per-message timestamps (epoch ms), so the preview shows
      // "2h ago" / "1h ago" instead of "just now" for resumed history.
      const min = 60_000, hr = 60 * min;
      return {
        sessionKey: String(a.sessionKey ?? 'dev:fix-recall-blend'),
        rows: [
          { kind: 'user', text: 'fix the reranker blend regression', ts: Date.now() - 2 * hr - 8 * min },
          { kind: 'tool-group', ts: Date.now() - 2 * hr - 6 * min, items: [
            { tool: 'grep_search', summary: 'reranker', preview: 'src/memory/recall.ts:42: const blended = ...\nsrc/memory/rerank.ts:18: ...', ok: true },
            { tool: 'read_file', summary: 'src/memory/recall.ts', preview: 'export function recall() {\n  // …\n}', ok: true },
            { tool: 'edit_file', summary: 'src/memory/recall.ts', preview: 'applied 1 hunk', ok: true, file: 'src/memory/recall.ts' },
          ] },
          { kind: 'assistant', text: 'Found it — the reranker score **replaces** the retriever order in `recall.ts`. Blending 0.6/0.4 with RRF restores MemBench to **0.58**.', ts: Date.now() - 2 * hr - 5 * min },
          { kind: 'user', text: 'run the full sweep to confirm', ts: Date.now() - 1 * hr - 12 * min },
          { kind: 'tool-group', ts: Date.now() - 1 * hr - 10 * min, items: [
            { tool: 'run_command', summary: 'npm run bench -- --sweep', preview: '# split MemBench 0.58\n# split LoCoMo 0.52\n# all green', ok: true },
            { tool: 'read_file', summary: 'bench/results.json', preview: '{ "MemBench": 0.58 }', ok: true },
          ] },
          { kind: 'assistant', text: 'Sweep complete across 6 splits — all green:\n\n| split | score |\n|---|---|\n| MemBench | 0.58 |\n| LoCoMo | 0.52 |', ts: Date.now() - 1 * hr - 9 * min },
        ],
      };
    },
    'action:allow-rule': (a) => ({ ok: true, rule: a.rule }),
    'action:term-exec': (a) => ({ out: `$ ${String(a.cmd ?? '')}\n(demo) command executed in the workspace`, code: 0 }),
    'command:dispatch': (a) => {
      const cmd = String(a.cmd ?? '');
      const demo: Record<string, string[]> = {
        goal: a.args ? [`Goal set: ${String(a.args)}`, 'status: active'] : ['Goal: ship DESK-5 command bridge', 'status: active · set 2026-06-11'],
        plan: ['[x] Capture live app behavior', '[~] Implement command bridge', '[ ] Provider editor'],
        workers: ['wkr-91 · running · vitest suite', 'wkr-87 · done · docs sweep'],
        ps: ['worker · wkr-91 · vitest suite', 'sub-agent · agent-3f2a · survey recall pipeline'],
        tools: ['12 MCP tools:', 'memory_search', 'cognitive_recall', 'memory_capture_turn', 'blackboard_review'],
        status: ['model: claude-opus-4-8 (anthropic)', 'workspace: /Users/dev/BrainRouter', 'mcp brainrouter: connected (brainrouter)'],
        memory: [`3 memories for "${String(a.args ?? '')}":`, '• reranker blend regression — fixed via 0.6/0.4 split', '• grid TUI sidebar must stay', '• release/0.4.15 active track'],
        recall: [`recall("${String(a.args ?? '')}") → 2 anchors`, '• recall.ts blend pipeline', '• benchmark sweep config'],
        briefing: ['Sources queried: keyword, vector, graph', 'pinnedAnchor: core-identity v3', 'records: 6 recalled · 2 pinned'],
      };
      return { lines: demo[cmd] ?? [`Unknown bridge command "${cmd}"`] };
    },
    'action:set-llm': (a) => ({ ok: true, provider: a.provider ?? 'openai', model: 'claude-opus-4-8', endpoint: a.endpoint ?? null }),
  };

  (window as unknown as { brainrouter: unknown }).brainrouter = {
    send(command: AgentCommand): void {
      switch (command.kind) {
        case 'query': {
          const handler = queries[command.name];
          if (handler) emit({ kind: 'query-result', id: command.id, ok: true, result: handler(command.args ?? {}) }, 30);
          else emit({ kind: 'query-result', id: command.id, ok: false, error: `Unknown query "${command.name}" (dev bridge)` }, 30);
          return;
        }
        case 'start-turn': {
          // DESK-5v — capture the session this turn belongs to. The user may
          // switch away while it runs; every event below stays tagged with THIS
          // key so it lands in the right chat, never the one now on screen.
          const ts = activeSession;
          if (runningSessions.has(ts)) return; // one turn per chat (other chats run in parallel)
          runningSessions.add(ts);
          emit({ kind: 'turn-start', prompt: command.prompt }, 0, ts);
          // DESK-5u — a prompt containing "fail"/"error"/"402" surfaces a real
          // turn-error card, so the per-session error-persistence path is testable.
          if (/\b(fail|error|402)\b/i.test(command.prompt)) {
            emit({ kind: 'status', text: 'Calling the model…' }, 100, ts);
            emit({ kind: 'turn-error', message: 'LLM Execution failed: OpenAI API error: 402 Payment Required' }, 500, ts);
            setTimeout(() => runningSessions.delete(ts), 560);
            return;
          }
          // DESK-5r — ramp context up through the turn; cross the compact line
          // and fire a compaction (which resets the fill), so the ring's live
          // growth + reset is visible in the preview.
          [600, 1100, 1700].forEach((d, i) => setTimeout(() => { devCtxUsed = 38_000 + (i + 1) * 18_000; }, d));
          setTimeout(() => {
            devCtxUsed = 92_000; // over the 80k compact threshold
            setTimeout(() => { emit({ kind: 'compaction', droppedMessages: 14, keptMessages: 6, summary: 'Summarized early exploration; kept the decision + sweep numbers.' }, 0, ts); devCtxUsed = 24_000; }, 250);
          }, 2300);
          const wantsApproval = command.prompt.toLowerCase().includes('approve');
          // DESK-5n — a "worker"/"build" prompt fans out a live child agent so
          // the Background-tasks panel's live path is exercisable in preview.
          const wantsWorker = /worker|build|spawn|agent/i.test(command.prompt);
          if (wantsWorker) {
            emit({ kind: 'child-tool-start', childId: 'agent-8b283dc5', role: 'worker', tool: 'list_dir', args: {} }, 300, ts);
            emit({ kind: 'child-tool-end', childId: 'agent-8b283dc5', role: 'worker', tool: 'list_dir', ok: true, summary: 'listed 4 items in .', durationMs: 120 }, 700, ts);
            emit({ kind: 'child-tool-start', childId: 'agent-8b283dc5', role: 'worker', tool: 'write_file', args: {} }, 1200, ts);
            emit({ kind: 'child-tool-end', childId: 'agent-8b283dc5', role: 'worker', tool: 'write_file', ok: true, summary: 'wrote snake-game/src/hooks/useSnakeGame.ts', durationMs: 200 }, 1900, ts);
            emit({ kind: 'child-complete', childId: 'agent-8b283dc5', role: 'worker', status: 'completed' }, 3200, ts);
          }
          emit({ kind: 'status', text: 'Reading the workspace…' }, 100, ts);
          emit({ kind: 'tool-end', tool: 'grep_search', ok: true, summary: '14 hits in 6 files' }, 500, ts);
          emit({ kind: 'tool-end', tool: 'read_file', ok: true, summary: 'src/agent/agent.ts (220 lines)', preview: 'export class Agent {\n  // …\n}' }, 900, ts);
          emit({ kind: 'tool-end', tool: 'run_command', ok: true, summary: 'npm test', preview: '# tests 1387\n# pass 1387\n# fail 0' }, 1400, ts);
          emit({ kind: 'tool-end', tool: 'edit_file', ok: true, summary: 'Edited src/agent/agent.ts +3 -0', preview: 'applied 1 hunk' }, 1600, ts);
          if (wantsApproval) {
            emit({ kind: 'interaction-request', request: { id: 'ir_demo', type: 'confirm', title: 'Run shell command?', detail: 'git push origin release/0.4.15', dangerous: true, tool: 'run_command' } }, 1800, ts);
          }
          emit({ kind: 'plan-update', items: [
            { step: 'Reproduce the failing case', status: 'completed', acceptance: 'MemBench drop isolated to the blend' },
            { step: 'Patch the blend scoring', status: 'in_progress', acceptance: 'recall.ts blends 0.6·rerank + 0.4·rrf' },
            { step: 'Re-run the 6-split sweep', status: 'pending', acceptance: 'all 6 splits green' },
          ] }, 1900, ts);
          emit({ kind: 'assistant-turn-start' }, 2100, ts);
          const answer = `Here's what I found in the workspace:\n\n- The recall blend lives in \`src/memory/recall.ts\` and the reranker score **replaces** the retriever order.\n- Fix: blend with the recency/RRF score instead — *score → sort → take top-N, never hard-drop*.\n\n\`\`\`ts\nconst blended = 0.6 * rerank + 0.4 * rrf;\n\`\`\`\n\n| split | before | after |\n|---|---|---|\n| MemBench | 0.41 | **0.58** |\n| LoCoMo | 0.37 | **0.52** |`;
          answer.split(/(?<=\s)/).forEach((chunk, i) => emit({ kind: 'assistant-delta', text: chunk }, 2200 + i * 18, ts));
          const end = 2200 + answer.split(/(?<=\s)/).length * 18 + 200;
          emit({ kind: 'assistant-turn-end' }, end, ts);
          emit({ kind: 'turn-complete', answer }, end + 80, ts);
          setTimeout(() => runningSessions.delete(ts), end + 90);
          emit({ kind: 'tokens-updated', promptTokens: 48_213, completionTokens: 1_904, calls: 6, turns: 3 }, end + 120, ts);
          return;
        }
        case 'interaction-response':
          emit({ kind: 'status', text: 'Approval received (demo).' }, 50);
          return;
        case 'new-session':
          // DESK-5v — switching NEVER stops a running turn; it keeps streaming
          // in the background (tagged with its own key) while we move on.
          activeSession = 'dev:new-chat';
          devCtxUsed = 1_200; // DESK-5t — a fresh chat has ~no context
          emit({ kind: 'session-changed', sessionKey: 'dev:new-chat', loadedMessages: 0, model: devModel }, 60, 'dev:new-chat');
          return;
        case 'resume-session': {
          const key = (command as { sessionKey: string }).sessionKey;
          activeSession = key;
          // DESK-5t — each session has its OWN context size (per-key, mirrors
          // the host estimating the loaded history). Switching must change it.
          const perSession = 14_000 + (([...key].reduce((s, c) => s + c.charCodeAt(0), 0)) % 5) * 13_000;
          devCtxUsed = perSession;
          emit({ kind: 'session-changed', sessionKey: key, loadedMessages: 12, model: devModel }, 60, key);
          return;
        }
        case 'set-model':
          devModel = (command as { model: string }).model;
          emit({ kind: 'status', text: `Model set to ${devModel} (saved to config.json — shared with the CLI).` }, 60, activeSession);
          emit({ kind: 'session-changed', sessionKey: activeSession, loadedMessages: -1, model: devModel }, 80, activeSession);
          return;
        case 'interrupt':
          // DESK-5v — interrupt only the chat on screen; others keep running.
          emit({ kind: 'status', text: 'Interrupt requested.' }, 30, activeSession);
          emit({ kind: 'turn-error', message: 'Turn interrupted by user.' }, 200, activeSession);
          setTimeout(() => runningSessions.delete(activeSession), 210);
          return;
        default: return;
      }
    },
    onEvent(listener: (msg: AgentEventMessage) => void): () => void {
      listeners.add(listener);
      emit({ kind: 'status', text: 'Dev bridge online (browser preview — no Electron).' }, 50);
      // DESK-5u — mirror the host's boot behavior: open on a FRESH NEW CHAT
      // (a session-changed with loadedMessages 0), not a restored session.
      if (!bootAnnounced) {
        bootAnnounced = true;
        devCtxUsed = 1_200;
        activeSession = 'dev:new-chat';
        emit({ kind: 'session-changed', sessionKey: 'dev:new-chat', loadedMessages: 0, model: devModel }, 120, 'dev:new-chat');
      }
      return () => listeners.delete(listener);
    },
    addWorkspace: async () => ({ opened: false, workspaceRoot: '/Users/dev/new-project' }),
    workspaceRecents: async () => ({ current: wsCurrent, recents: wsRecents }),
    openWorkspace: async (root: string) => {
      // Mirror the real main-process swap: recents update, then the "new
      // host" announces itself with a boot session-changed.
      wsCurrent = root;
      wsRecents = [root, ...wsRecents.filter((r) => r !== root)].slice(0, 10);
      if (!SESSIONS_BY_ROOT[root]) SESSIONS_BY_ROOT[root] = [];
      emit({ kind: 'session-changed', sessionKey: `dev:${root.split('/').pop()}`, loadedMessages: 0, model: 'claude-opus-4-8' }, 350);
      return { opened: true };
    },
  };
}
