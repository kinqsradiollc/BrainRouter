// devBridge/state.ts — shared mutable state + helper closures for the browser-only
// dev bridge. Extracted verbatim from devBridge.ts's installDevBridge() body so the
// query + command handlers (in ./queries and ./commands) close over one live state
// object. Reassignable scalars are exposed via get/set so cross-module writes are
// visible everywhere; collections + helpers are shared by reference. Behavior-identical.
import type { AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type { ConnectorCatalogEntry, ConnectorRecord } from '@kinqs/brainrouter-types';
import { createDevOnboardingState } from './onboarding.js';

export function createDevState() {
  const listeners = new Set<(msg: AgentEventMessage) => void>();
  // Wave 1 — recents-changed listeners (membership/state + explicit reorder).
  const recentsListeners = new Set<(d: { recents: string[]; reason: string; workspaceRoot: string }) => void>();
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
      // T2/T3 — mirror main: tag every event with the current workspace so the
      // renderer's workspace-identity + stale-drop logic is exercised in dev.
      const msg = { seq: ++seq, ts: Date.now(), sessionKey, event, workspaceRoot: wsCurrent } as AgentEventMessage & { workspaceRoot: string };
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
    effort: 'medium', personality: 'pair-programmer', personalityMode: 'auto', personalitySource: 'profile', tier: null, theme: 'dark', quiet: false,
    memoriesEnabled: true, personaAnchorEnabled: true, experimental: false, rawScrollback: false, editorMode: 'emacs',
  } as Record<string, unknown>;
  const sessionModes: Record<string, Record<string, unknown>> = {};
  const effectivePrefs = () => {
    const session = sessionModes[activeSession] ?? {};
    return {
      ...prefs,
      ...session,
      ...(session.personality ? { personalitySource: 'chat' } : {}),
    };
  };

  // DESK-5l — stateful model, mirroring the real host (agent.getModel):
  // session-info must reflect a switch, or refreshes revert the UI.
  let devModel = 'claude-opus-4-8';
  // Item 10 — per-session model overrides (mirrors sessionRuntimeStore). The
  // resolved model is the session override if present, else the global default.
  const devSessionModels: Record<string, string> = {};
  const resolvedModel = (sessionKey: string): string => devSessionModels[sessionKey] ?? devModel;
  let bootAnnounced = false;
  // DESK-5r — mock context fill: grows during a turn, drops on compaction,
  // so the composer ring's live + reset behavior is exercisable in preview.
  let devCtxUsed = 38_000;
  // DESK-5d — stateful workspaces: switching swaps the "current" root and
  // re-announces a boot session-changed, mirroring the real in-place swap.
  let wsCurrent = '/Users/dev/BrainRouter';
  let wsRecents = ['/Users/dev/BrainRouter', '/Users/dev/side-project', '/Users/dev/TradingAgents'];
  // T1 — mock trust set (existing projects pre-trusted so the dev UI isn't gated).
  const trustedRoots = new Set<string>(wsRecents);
  const onboarding = createDevOnboardingState();
  const SESSIONS_BY_ROOT: Record<string, unknown[]> = {
    '/Users/dev/BrainRouter': [
      { sessionKey: 'dev:fix-recall-blend', firstUserMessage: 'fix the reranker blend regression', modifiedAt: new Date(Date.now() - 3600_000).toISOString(), turnCount: 24, lastRole: 'assistant' },
      { sessionKey: 'dev:grid-tui', firstUserMessage: 'make the sidebar live', modifiedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), turnCount: 51, lastRole: 'user' },
      { sessionKey: 'dev:release-0414', firstUserMessage: 'release 0.4.14 to npm', modifiedAt: new Date(Date.now() - 6 * 86400_000).toISOString(), turnCount: 12, lastRole: 'assistant' },
      // Item 9 — extra sessions so the sidebar pagination (show more / fewer) is exercisable.
      ...Array.from({ length: 12 }, (_, i) => ({
        sessionKey: `dev:older-${i + 1}`,
        firstUserMessage: `older task ${i + 1} — ${['tidy the recall logs', 'bump deps', 'fix flaky test', 'doc pass', 'perf probe'][i % 5]}`,
        modifiedAt: new Date(Date.now() - (8 + i) * 86400_000).toISOString(), turnCount: 3 + i, lastRole: i % 2 ? 'user' : 'assistant',
      })),
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

  // T14 — in-memory schedules so the Schedules panel is fully exercisable in dev.
  let schedSeq = 2;
  const devSchedules: Array<{ id: string; kind: 'cron' | 'once'; expr: string; command: string; owner: string; enabled: boolean; nextRun: string; lastRun?: string; createdAt: string }> = [
    { id: 'sch_demo1', kind: 'cron', expr: '*/15 * * * *', command: '/status', owner: 'dev:new-chat', enabled: true, createdAt: new Date(Date.now() - 86400_000).toISOString(), nextRun: new Date(Date.now() + 600_000).toISOString(), lastRun: new Date(Date.now() - 300_000).toISOString() },
    { id: 'sch_demo2', kind: 'once', expr: new Date(Date.now() + 3600_000).toISOString(), command: '/usage', owner: 'dev:new-chat', enabled: false, createdAt: new Date(Date.now() - 1800_000).toISOString(), nextRun: new Date(Date.now() + 3600_000).toISOString() },
  ];
  // T13 — in-memory worktrees for the panel preview.
  const devWorktrees: Array<{ path: string; branch: string; detached: boolean }> = [
    { path: '/Users/dev/BrainRouter', branch: 'release/0.4.15', detached: false },
    { path: '/Users/dev/BrainRouter/.worktrees/experiment', branch: 'spike-new-recall', detached: false },
  ];
  // REQUIREMENT-RECORDS — in-memory requirements so the panel renders populated
  // in the browser preview (varied status/priority/criteria/Q&A/links). Mirrors
  // the host's requirementStore wrappers; the real store lives in the CLI.
  type DevReq = {
    id: string; title: string; description?: string; status: string; priority: string;
    acceptanceCriteria: string[]; clarifyingQuestions: Array<{ question: string; answer?: string }>;
    workspaceRoot: string; sessionKey?: string; taskIds: string[]; artifactIds: string[];
    linkedMemoryIds: string[]; sourceEventId?: string; origin?: 'manual' | 'auto'; createdAt: string; updatedAt: string;
  };
  let reqSeq = 3;
  const nowIso = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
  const devRequirements: DevReq[] = [
    {
      id: 'req_a1b2c3d4', title: 'Blend reranker + retriever scores in recall', status: 'in-progress', priority: 'high',
      description: 'The reranker score currently replaces the retriever order, hard-dropping good candidates. Blend 0.6·rerank + 0.4·rrf instead.',
      acceptanceCriteria: ['MemBench recovers to ≥ 0.58 across all 6 splits', 'Reranker never hard-drops a top-retriever candidate'],
      clarifyingQuestions: [{ question: 'Which split regressed first?', answer: 'MemBench, then LoCoMo.' }, { question: 'Keep the LLM judge stage?' }],
      workspaceRoot: '/Users/dev/BrainRouter', sessionKey: 'dev:fix-recall-blend',
      taskIds: ['task_1', 'task_2'], artifactIds: ['art_9'], linkedMemoryIds: ['mem_blend'], origin: 'auto', sourceEventId: 'mem_auto_blend',
      createdAt: nowIso(3 * 86400_000), updatedAt: nowIso(3600_000),
    },
    {
      id: 'req_e5f6a7b8', title: 'Persona injection in the CLI briefing', status: 'ready', priority: 'medium',
      description: 'The brain distills a Core Identity but the CLI briefing never injects it.',
      acceptanceCriteria: ['Core Identity anchor is injected before federation context'],
      clarifyingQuestions: [],
      workspaceRoot: '/Users/dev/BrainRouter',
      taskIds: [], artifactIds: [], linkedMemoryIds: ['mem_persona'],
      createdAt: nowIso(1 * 86400_000), updatedAt: nowIso(2 * 3600_000),
    },
    {
      id: 'req_c9d0e1f2', title: 'Draft: requirement-records desktop panel', status: 'draft', priority: 'low',
      acceptanceCriteria: [],
      clarifyingQuestions: [{ question: 'Mirror an existing panel or invent a new layout?' }],
      workspaceRoot: '/Users/dev/BrainRouter',
      taskIds: [], artifactIds: [], linkedMemoryIds: [],
      createdAt: nowIso(2 * 3600_000), updatedAt: nowIso(2 * 3600_000),
    },
  ];
  // ANNOTATION-RECORDS — in-memory annotations so the panel renders populated in
  // the browser preview (varied target kind / status / severity / anchor /
  // suggestedText). Mirrors the host's annotationStore wrappers; the real store
  // lives in the CLI. The status set + create mutate this list in place.
  type DevAnnot = {
    id: string; type: string; targetId?: string; body: string; workspaceRoot: string;
    sessionKey?: string; requirementId?: string; taskId?: string; artifactId?: string;
    anchor?: { filePath?: string; startLine?: number; endLine?: number; block?: string; selectedText?: string; contentHash?: string };
    suggestedText?: string; severity?: string; status: string; author?: string;
    comments?: Array<{ id: string; body: string; author?: string; createdAt: string }>;
    stale?: boolean;
    linkedMemoryIds: string[]; createdAt: string; updatedAt: string;
  };
  let annotSeq = 4;
  const devAnnotations: DevAnnot[] = [
    {
      id: 'ann_a1b2c3d4', type: 'review-finding', targetId: 'f0', body: 'Reranker score replaces retriever order — good candidates are hard-dropped instead of blended.',
      workspaceRoot: wsCurrent, sessionKey: 'dev:fix-recall-blend', requirementId: 'req_a1b2c3d4',
      anchor: { filePath: 'src/memory/recall.ts', startLine: 1247, endLine: 1249, selectedText: 'results.sort((a, b) => ranked[b] - ranked[a]);', contentHash: 'deadbeef' },
      suggestedText: 'const blended = reranked.map((r, i) => 0.6 * r.score + 0.4 * rrf[i]);\nresults.sort((a, b) => blended[b] - blended[a]);',
      severity: 'high', status: 'open', author: 'review', linkedMemoryIds: ['mem_blend'],
      // §6 — a seeded comment thread + a stale anchor (the code at recall.ts:1247 moved since this was made).
      comments: [
        { id: 'cmt_seed1', body: 'Confirmed — the hard sort drops blended candidates. Will switch to the rrf blend.', author: 'anhdang', createdAt: nowIso(90 * 60_000) },
        { id: 'cmt_seed2', body: 'Fix is in; re-running the recall benchmark to confirm the win.', author: 'agent', createdAt: nowIso(30 * 60_000) },
      ],
      stale: true,
      createdAt: nowIso(2 * 3600_000), updatedAt: nowIso(2 * 3600_000),
    },
    {
      id: 'ann_e5f6a7b8', type: 'file', body: 'This helper is duplicated in completionInbox.ts — extract a shared util.',
      workspaceRoot: wsCurrent, anchor: { filePath: 'src/state/completionInbox.ts', startLine: 4 },
      severity: 'medium', status: 'accepted', author: 'anhdang', linkedMemoryIds: [],
      createdAt: nowIso(1 * 86400_000), updatedAt: nowIso(3600_000),
    },
    {
      id: 'ann_c9d0e1f2', type: 'plan', taskId: 'task_2', body: 'Add a MemBench regression gate to this plan step before merging.',
      workspaceRoot: wsCurrent, severity: 'low', status: 'resolved', linkedMemoryIds: [],
      createdAt: nowIso(2 * 86400_000), updatedAt: nowIso(6 * 3600_000),
    },
    {
      id: 'ann_b3c4d5e6', type: 'markdown', targetId: 'art_9', artifactId: 'art_9', body: 'The architecture doc still references the old 3-stage pipeline. Update to 4 stages.',
      workspaceRoot: wsCurrent, anchor: { block: 'Recall pipeline', selectedText: '3-stage pipeline: retrieve → rerank → expand' },
      suggestedText: '4-stage pipeline: retrieve → rerank → judge → expand',
      severity: 'info', status: 'ignored', linkedMemoryIds: ['mem_arch', 'mem_pipeline'],
      createdAt: nowIso(3 * 86400_000), updatedAt: nowIso(3 * 86400_000),
    },
  ];
  const devAnnotMarkdown = (list: DevAnnot[]): string => {
    if (list.length === 0) return '# Annotations\n\n_No annotations to export._\n';
    const lines = ['# Annotations', ''];
    for (const a of [...list].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
      const at = a.anchor?.filePath ? ` at ${a.anchor.filePath}${a.anchor.startLine ? `:${a.anchor.startLine}` : ''}` : '';
      lines.push(`- **${a.id}** (${a.type}, status: ${a.status}${a.severity ? `, severity: ${a.severity}` : ''}${at})`, `  ${a.body}`);
      if (a.suggestedText) lines.push('', '  Suggested:', '  ```', ...a.suggestedText.split('\n').map((l) => `  ${l}`), '  ```');
      lines.push('');
    }
    return lines.join('\n');
  };

  // ARTIFACT-RECORDS — in-memory artifacts so the panel renders populated in the
  // browser preview (varied kind / status / format; one inline markdown, one
  // inline html, one file-backed via a path). Mirrors the host's artifactStore
  // wrappers; the real store lives in the CLI. status-set + create mutate in place.
  type DevArtifact = {
    id: string; kind: string; title: string; status: string; format: string;
    path?: string; content?: string; summary?: string; workspaceRoot: string;
    sessionKey?: string; requirementId?: string; taskId?: string; linkedMemoryIds: string[];
    createdAt: string; updatedAt: string;
  };
  let artSeq = 4;
  const devArtifacts: DevArtifact[] = [
    {
      id: 'art_9', kind: 'markdown-report', title: 'Recall blend verification report', status: 'final', format: 'markdown',
      summary: 'MemBench + LoCoMo results after blending reranker + retriever scores.',
      content: '# Recall blend verification\n\nAfter blending **0.6·rerank + 0.4·rrf**, MemBench recovered across all splits.\n\n| Split | Before | After |\n| --- | --- | --- |\n| MemBench | 0.51 | **0.59** |\n| LoCoMo | 0.54 | **0.60** |\n\n```ts\nconst blended = reranked.map((r, i) => 0.6 * r.score + 0.4 * rrf[i]);\n```\n\n- Reranker no longer hard-drops top-retriever candidates.\n- LLM judge stage retained.\n',
      workspaceRoot: wsCurrent, sessionKey: 'dev:fix-recall-blend', requirementId: 'req_a1b2c3d4',
      taskId: 'task_2', linkedMemoryIds: ['mem_blend', 'mem_arch'],
      createdAt: nowIso(2 * 3600_000), updatedAt: nowIso(2 * 3600_000),
    },
    {
      id: 'art_html1', kind: 'html-prototype', title: 'Artifacts panel layout sketch', status: 'draft', format: 'html',
      summary: 'Static HTML sketch of the list + detail + preview columns.',
      content: '<section class="artifacts">\n  <ul class="rows">\n    <li><span class="kind">markdown-report</span> <span class="title">Recall report</span></li>\n  </ul>\n  <div class="detail">\n    <h3>Preview</h3>\n    <article>rendered markdown / html source</article>\n  </div>\n</section>',
      workspaceRoot: wsCurrent, sessionKey: activeSession, linkedMemoryIds: [],
      createdAt: nowIso(6 * 3600_000), updatedAt: nowIso(5 * 3600_000),
    },
    {
      id: 'art_design1', kind: 'design-note', title: 'Persona injection design note', status: 'final', format: 'markdown',
      summary: 'Where the Core Identity anchor is injected in the CLI briefing.',
      path: 'brainrouter-docs/specs/persona-injection.md',
      workspaceRoot: wsCurrent, requirementId: 'req_e5f6a7b8', linkedMemoryIds: ['mem_persona'],
      createdAt: nowIso(1 * 86400_000), updatedAt: nowIso(12 * 3600_000),
    },
    {
      id: 'art_verif1', kind: 'verification-summary', title: 'Release 0.4.14 verification summary', status: 'archived', format: 'text',
      content: 'All 6 MemBench splits >= 0.58.\nGrid TUI renders on macOS Terminal + iTerm.\nModel-spawned workers report back to the completion inbox.\nNo regressions in the recall pipeline test suite.',
      workspaceRoot: wsCurrent, linkedMemoryIds: [],
      createdAt: nowIso(4 * 86400_000), updatedAt: nowIso(4 * 86400_000),
    },
  ];

  // Review v2 — a shared mock run + gate so the commit/push review gate is exercisable.
  // §7 PLAN REVIEW — a mutable in-memory decision log so Approve / Request-changes
  // actually grow the version history in the browser preview (append order;
  // oldest-first, exactly as the host's planHistoryStore returns it).
  type DevPlanItem = { step: string; status: string; acceptance?: string };
  type DevPlanDecision = { id: string; verdict: 'approved' | 'changes-requested' | 'revised'; actor?: 'user' | 'auto'; feedback?: string; planSnapshot: DevPlanItem[]; explanation?: string; createdAt: string; linkedMemoryIds: string[] };
  const devPlanState: { items: DevPlanItem[]; explanation?: string } = { items: [{ step: 'Audit the session/context meter logic', status: 'completed' }, { step: 'Reset context + plan on session switch', status: 'in_progress' }], explanation: 'Session-scoped state fix' };
  // TRACK mode mock: a project + work items the board/list renders from.
  const trackCat = (s: string): string => (
    s === 'done' ? 'completed'
      : s === 'cancelled' ? 'cancelled'
        : s === 'backlog' ? 'backlog'
          : s === 'todo' ? 'unstarted'
            : 'started'); // in-progress / in-review
  const mkItem = (key: string, type: string, title: string, status: string, priority: string, assignee?: string, labels: string[] = []) => ({
    id: `wi_${key}`, key, type, title, status, statusCategory: trackCat(status), priority,
    assignees: assignee ? [assignee] : [], assignee, watchers: [], labels, components: [], links: [], comments: [], attachmentIds: [],
    activity: [{ at: '2026-06-21T00:00:00.000Z', actor: 'user', field: 'created' }],
    workspaceRoot: wsCurrent, linkedMemoryIds: [], codeLinks: [], taskIds: [], artifactIds: [], reviewFindingIds: [],
    createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
  });
  const devTrack: { project: Record<string, unknown>; items: Record<string, unknown>[] } = {
    project: {
      id: 'proj_dev', workspaceRoot: wsCurrent, name: 'BrainRouter', key: 'BR', keyCounter: 8,
      workflowStates: [
        { id: 'backlog', name: 'Backlog', category: 'backlog', color: '#94a3b8', default: true },
        { id: 'todo', name: 'Todo', category: 'unstarted', color: '#64748b' },
        { id: 'in-progress', name: 'In Progress', category: 'started', color: '#f59e0b' },
        { id: 'in-review', name: 'In Review', category: 'started', color: '#6366f1' },
        { id: 'done', name: 'Done', category: 'completed', color: '#22c55e' },
        { id: 'cancelled', name: 'Cancelled', category: 'cancelled', color: '#9ca3af' },
      ],
      issueTypes: [], components: ['cli', 'desktop', 'memory'],
      labels: [
        { id: 'lbl_track', name: 'track', color: '#6366f1' },
        { id: 'lbl_desktop', name: 'desktop', color: '#3b82f6' },
        { id: 'lbl_memory', name: 'memory', color: '#a855f7' },
      ],
      members: [
        { id: 'you', name: 'You', role: 'owner', addedAt: '2026-06-21T00:00:00.000Z' },
        { id: 'anhdang', name: 'Anh Dang', role: 'admin', addedAt: '2026-06-21T00:00:00.000Z' },
        { id: 'reviewer', name: 'Reviewer', role: 'viewer', addedAt: '2026-06-21T00:00:00.000Z' },
      ],
      createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z',
    },
    items: [
      mkItem('BR-1', 'epic', 'Unified workspace — Chat · Track · Code', 'in-progress', 'high', 'anhdang', ['track']),
      mkItem('BR-2', 'story', 'Track data model + durable store', 'done', 'high', 'anhdang', ['track']),
      mkItem('BR-3', 'story', 'Left-sidebar mode switcher', 'in-progress', 'high', 'anhdang', ['desktop']),
      mkItem('BR-4', 'task', 'Track board view (columns + cards)', 'in-review', 'medium', 'anhdang', ['desktop']),
      mkItem('BR-5', 'bug', 'Reranker timeout under a slow local server', 'done', 'urgent', 'bob', ['memory']),
      mkItem('BR-6', 'task', 'Agent tools for the tracker', 'todo', 'medium'),
      mkItem('BR-7', 'task', '/track CLI commands', 'backlog', 'low'),
    ],
  };
  let devTrackN = 8;
  // ADR-029 — the id counter the Notes mock mints blocks and references from.
  //
  // It starts PAST the last fixture id (`blk_4`). At 4 the first block anyone
  // created was minted as `blk_4` again, and the harness then wrote every
  // keystroke into the fixture page of that name as well — which reads as the
  // editor typing into two blocks at once.
  let devNotesN = 5;
  const devSprints: Record<string, unknown>[] = [
    { id: 'sp_1', workspaceRoot: wsCurrent, name: 'Sprint 1 — Track foundation', goal: 'Ship the board', state: 'active', capacity: 20, createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
    { id: 'sp_2', workspaceRoot: wsCurrent, name: 'Sprint 2 — Views', state: 'future', createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
  ];
  let devSprintN = 3;
  const devModules: Record<string, unknown>[] = [
    { id: 'mod_1', workspaceRoot: wsCurrent, name: 'Recall pipeline', description: 'reranker + RRF blend, graph expansion', status: 'in-progress', lead: 'anhdang', members: ['anhdang', 'bob'], targetDate: '2026-07-12T00:00:00.000Z', createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
    { id: 'mod_2', workspaceRoot: wsCurrent, name: 'Unified workspace', description: 'Chat · Track · Code modes', status: 'in-progress', lead: 'you', members: ['you', 'anhdang'], targetDate: '2026-07-20T00:00:00.000Z', createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
    { id: 'mod_3', workspaceRoot: wsCurrent, name: 'Cloud packaging', description: 'server image + remote dashboard', status: 'planned', lead: 'you', members: ['you'], targetDate: '2026-08-01T00:00:00.000Z', createdAt: '2026-06-20T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
  ];
  let devModuleN = 4;
  const devViews: Record<string, unknown>[] = [
    { id: 'view_1', workspaceRoot: wsCurrent, name: 'My open bugs', layout: 'board', query: 'type = bug', filters: { priority: 'high' }, createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
    { id: 'view_2', workspaceRoot: wsCurrent, name: 'This month', layout: 'calendar', createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
  ];
  let devViewN = 3;
  // Seed a few module assignments so the preview's progress bars have data.
  for (const it of devTrack.items) {
    if (it.key === 'BR-1' || it.key === 'BR-2') it.moduleId = 'mod_2';
    if (it.key === 'BR-3' || it.key === 'BR-5') it.moduleId = 'mod_1';
  }
  // Spread start/target dates across the current month so calendar + gantt have data.
  {
    const now = new Date();
    const mk = (off: number): string => new Date(now.getFullYear(), now.getMonth(), Math.max(1, Math.min(28, now.getDate() + off))).toISOString();
    const dates: Record<string, [number, number]> = { 'BR-1': [-3, 6], 'BR-2': [-10, -2], 'BR-3': [0, 5], 'BR-4': [2, 9], 'BR-5': [-6, -1], 'BR-6': [4, 12], 'BR-7': [7, 14] };
    for (const it of devTrack.items) { const d = dates[String(it.key)]; if (d) { it.startDate = mk(d[0]); it.targetDate = mk(d[1]); } }
  }
  // A Markdown description on one item so the detail drawer's rendering is visible in preview.
  {
    const bug = devTrack.items.find((it) => it.key === 'BR-5');
    if (bug) bug.description = ['### Summary', 'Reranker **times out** under a slow local server.', '', '### Reproduction steps', '1. Point at a slow OpenAI-compatible endpoint', '2. Run `/recall "…"`', '3. Observe the hang', '', '### Expected', 'Recall degrades gracefully (no hard block).', '', '```shell', 'BRAINROUTER_RECALL_TIMEOUT_MS=8000 brainrouter chat', '```', '', '> See the `request-timeout.ts` chokepoint.'].join('\n');
  }
  const devFindItem = (k: unknown): Record<string, unknown> | undefined => devTrack.items.find((w) => w.key === k || w.id === k);
  const devAutomations: Record<string, unknown>[] = [
    { id: 'auto_1', name: 'Bugs start high', enabled: true, trigger: 'created', condition: 'type = bug', actions: [{ type: 'set-priority', value: 'high' }], createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
    { id: 'auto_2', name: 'Comment on done', enabled: false, trigger: 'transitioned', condition: 'status = done', actions: [{ type: 'comment', value: 'Auto-resolved by Track' }], createdAt: '2026-06-21T00:00:00.000Z', updatedAt: '2026-06-21T00:00:00.000Z' },
  ];
  let devAutoN = 3;
  const devPlanDecisions: DevPlanDecision[] = [
    { id: 'pdec_seed', verdict: 'changes-requested', actor: 'user', feedback: 'add a regression test for the reset path', planSnapshot: [{ step: 'Audit the session/context meter logic', status: 'in_progress' }], explanation: 'Session-scoped state fix', createdAt: '2026-06-17T22:00:00.000Z', linkedMemoryIds: [] },
    // auto-approved while running in auto mode (no approval prompt) — shows "approved · auto" in history
    { id: 'pdec_auto', verdict: 'approved', actor: 'auto', planSnapshot: [{ step: 'Audit the session/context meter logic', status: 'completed' }, { step: 'Reset context + plan on session switch', status: 'in_progress' }], explanation: 'Session-scoped state fix', createdAt: '2026-06-18T00:00:00.000Z', linkedMemoryIds: [] },
  ];
  let devPlanSeq = 1;
  const DEV_DIFF_HASH = 'devhash';
  type DevFinding = { id: string; file: string; line?: number; endLine?: number; severity: string; confidence: number; summary: string; status: string; canApply: boolean; source: string; details?: string; suggestion?: string; codeExcerpt?: string; diffHunk?: string; patch?: string };
  let devReview: { id: string; diffHash: string; status: string; summary: string; findings: DevFinding[] } | null = null;
  const devRunReview = () => {
    devReview = {
      id: 'rev_dev', diffHash: DEV_DIFF_HASH, status: 'completed',
      summary: 'Reviewed 2 changed files. One real bug and one perf nit; the rest looks good.',
      findings: [
        { id: 'f0', file: 'src/memory/recall.ts', line: 1247, endLine: 1249, severity: 'high', confidence: 92,
          summary: 'Reranker score replaces retriever order — good candidates are hard-dropped instead of blended.', status: 'open', canApply: true, source: 'ai-review',
          details: 'The reranker output overwrites the retriever ranking, so any candidate the reranker scores low is discarded even when the retriever ranked it highly. Blend the two scores instead of replacing.',
          suggestion: 'Blend the scores: const blended = 0.6 * rerank + 0.4 * rrf; then sort + take top-N.',
          codeExcerpt: 'const ranked = reranked.map(r => r.score);\nresults.sort((a, b) => ranked[b] - ranked[a]);\nreturn results.slice(0, topN);',
          diffHunk: '@@ -1247,3 +1247,3 @@\n-const ranked = reranked.map(r => r.score);\n-results.sort((a, b) => ranked[b] - ranked[a]);\n+const blended = reranked.map((r, i) => 0.6 * r.score + 0.4 * rrf[i]);\n+results.sort((a, b) => blended[b] - blended[a]);\n return results.slice(0, topN);',
          patch: '--- a/src/memory/recall.ts\n+++ b/src/memory/recall.ts\n@@ -1247,2 +1247,2 @@\n-const ranked = reranked.map(r => r.score);\n-results.sort((a, b) => ranked[b] - ranked[a]);\n+const blended = reranked.map((r, i) => 0.6 * r.score + 0.4 * rrf[i]);\n+results.sort((a, b) => blended[b] - blended[a]);' },
        { id: 'f1', file: 'src/memory/recall.ts', line: 1260, severity: 'medium', confidence: 71,
          summary: 'Re-sorts the full candidate list per call; sort once after blending.', status: 'open', canApply: false, source: 'ai-review',
          details: 'sortCandidates() runs inside the per-result loop, so the list is re-sorted O(n) times. Sort once after the blend.',
          codeExcerpt: 'for (const r of results) {\n  sortCandidates(results);\n  emit(r);\n}' },
        { id: 'f2', file: 'src/agent/agent.ts', line: 880, severity: 'low', confidence: 60,
          summary: 'Unused local `mutatedThisTurn` after the refactor.', status: 'open', canApply: false, source: 'ai-review',
          codeExcerpt: 'let mutatedThisTurn = false;' },
      ],
    };
    return { ...devReview, files: 2 };
  };
  const devGate = () => {
    if (!devReview || devReview.diffHash !== DEV_DIFF_HASH) return { status: 'needs-review', blocked: true, reason: 'No review has run for the current changes.', blockingFindings: [] };
    const blocking = devReview.findings.filter((f) => f.status === 'open' && (f.severity === 'critical' || f.severity === 'high'));
    if (blocking.length) return { status: 'blocked', blocked: true, reason: `${blocking.length} unresolved high+ finding(s) must be resolved, fixed, or dismissed.`, blockingFindings: blocking };
    return { status: 'clean', blocked: false, reason: 'No unresolved blocking findings.', blockingFindings: [] };
  };
  // T7/T6 — mutable permission rules + MCP servers so the Settings editors work in preview.
  const devRules: { allow: string[]; deny: string[] } = { allow: ['run_command(git *)', 'run_command(npm test*)'], deny: ['run_command(rm -rf *)'] };
  // §multi-provider — MUTABLE provider list so the browser preview actually
  // reflects create/configure/remove (the real Electron host persists to
  // config.json; here we keep an in-memory list that config-snapshot reads).
  const devProviders: Array<{ name: string; provider: string; model: string; endpoint: string | null; hasKey: boolean; models: string[]; cachedModels?: string[]; cachedAt?: string | null; apiVersion?: string | null; free?: boolean; passthroughUnknown?: boolean }> = [
    { name: 'groq', provider: 'groq', model: 'llama-3.3-70b', endpoint: 'https://api.groq.com/openai/v1', hasKey: true, models: [], cachedModels: ['llama-3.3-70b', 'llama-3.1-405b', 'mixtral-8x7b'], cachedAt: '2026-07-05T00:00:00.000Z', free: true },
    { name: 'local', provider: 'lmstudio', model: 'qwen2.5-coder-7b', endpoint: 'http://localhost:1234/v1', hasKey: false, models: [], cachedModels: ['qwen2.5-coder-7b'], cachedAt: '2026-07-05T00:00:00.000Z', free: true },
  ];
  let devDefaultProvider: string | null = 'groq';
  const devCliKnobs: Record<string, unknown> = {
    autoCompactTokens: 80000, maxToolLoops: 60, recallMode: 'gated', contextCompaction: true, llmTimeoutMs: 120000,
    automation: { enabled: true, requirements: { enabled: true, autopilot: false }, sync: { enabled: true }, sprints: { enabled: true, autopilot: true } },
    // Motor Cortex — realistic fixtures so the Runtime / Automations / Profiles panels preview with content.
    runtime: { backend: 'worktree', maxLive: 4, archiveOnDispose: true, archiveKeep: 20, archiveMaxMB: 64, jitSecrets: true, serve: false, serveHost: '127.0.0.1', servePort: 8791, previewPorts: { web: 5173, api: 8080 } },
    budget: { maxPerTaskUSD: 2.5, maxPerTaskTokens: 0 },
    critic: { enabled: true, threshold: 0.7, maxRefinementIterations: 2, model: '' },
    router: { enabled: true, passThrough: true, chain: ['groq/llama-3.3-70b', 'local/qwen2.5-coder-7b'], strategy: 'priority', serve: false, serveHost: '127.0.0.1', servePort: 8790, serveKey: 'set-in-dev' },
    triggers: { enabled: true, host: '127.0.0.1', port: 8787, githubSecret: 'set-in-dev', allowedRepos: ['kinqsradio/brainrouter'], mentionHandle: 'brainrouter', ciNudge: true },
    agents: { hosted: [{ name: 'claude-code', command: 'claude', args: ['--print'], protocol: 'line-json' }] },
    llmProfiles: { fast: { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low', fast: true }, deep: { model: 'claude-opus-4-8', reasoningEffort: 'high' } },
    activeLlmProfile: 'deep',
    skillsKeywordTriggers: true, skillsStackMax: 5, skillsHideBundled: false, skills: { orgRepoDiscovery: false },
    plugins: { orgScope: false, autoUpdateCheck: false, altManifestNames: [], publishRepo: '' },
    safeMode: false, attribution: { sessionUrl: true },
  };
  const devExtensions = {
    trusted: true,
    items: [
      { name: 'warehouse', version: '1.0.0', source: 'workspace' as const, description: 'Adds query_warehouse + run_migration tools', contributes: ['tools'], enabled: true, blocked: false },
      { name: 'acme-gateway', version: '0.3.1', source: 'user' as const, description: 'Custom-streaming provider', contributes: ['providers'], enabled: true, blocked: false },
      { name: 'prod-guard', version: '2.0.0', source: 'builtin' as const, description: 'Denies run_command against prod hosts', contributes: ['hooks'], enabled: false, blocked: false },
    ],
  };
  const devGithub: {
    repo: string | null;
    hasToken: boolean;
    tokenSource: string | null;
    repos: Array<{ repo: string; hasToken: boolean; tokenSource: string | null; active: boolean; label?: string | null; source?: string | null; connectorId?: string | null }>;
    caBundle: string | null;
  } = {
    repo: 'kinqsradiollc/BrainRouter',
    hasToken: true,
    tokenSource: 'config',
    repos: [
      { repo: 'kinqsradiollc/BrainRouter', hasToken: true, tokenSource: 'config', active: true },
      { repo: 'kubernetes/kubernetes', hasToken: false, tokenSource: null, active: false },
      { repo: 'kinqsradiollc/brainrouter-desktop', hasToken: true, tokenSource: 'connector-env', active: false, label: 'BrainRouter repos', source: 'connector', connectorId: 'conn_demo_github' },
    ],
    caBundle: null,
  };
  const devConnectorCatalog: ConnectorCatalogEntry[] = [
    {
      source: 'github',
      title: 'GitHub',
      description: 'Ingest issues, pull requests, files, and permissions from GitHub.',
      flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
      credentialModes: ['static', 'dynamic', 'oauth'],
      configFields: [
        { key: 'owner', label: 'Owner or organization', type: 'string', required: true },
        { key: 'repositories', label: 'Repositories', type: 'string-list' },
        { key: 'includeIssues', label: 'Include issues', type: 'boolean', defaultValue: true },
        { key: 'includePullRequests', label: 'Include pull requests', type: 'boolean', defaultValue: true },
        { key: 'includeFiles', label: 'Include files', type: 'boolean', defaultValue: false },
        { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' },
      ],
      credentialFields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }],
    },
    { source: 'gitlab', title: 'GitLab', description: 'Index issues, merge requests, and repository files from GitLab projects or groups.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'owner', label: 'Group or namespace', type: 'string' }, { key: 'projects', label: 'Projects', type: 'string-list' }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'token', label: 'GitLab token', type: 'secret', required: true }] },
    { source: 'slack', title: 'Slack', description: 'Index selected channels and threads for team/project recall.', flows: ['checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'channels', label: 'Channels', type: 'string-list' }, { key: 'includeThreads', label: 'Include threads', type: 'boolean', defaultValue: true }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'botToken', label: 'Bot token', type: 'secret', required: true }] },
    { source: 'google-drive', title: 'Google Drive', description: 'Index Drive folders, shared docs, and sheets for workspace knowledge.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'folderIds', label: 'Folder ids', type: 'string-list' }, { key: 'includeSharedDrives', label: 'Include shared drives', type: 'boolean', defaultValue: true }, { key: 'includeSheets', label: 'Include spreadsheets', type: 'boolean', defaultValue: true }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }] },
    { source: 'confluence', title: 'Confluence', description: 'Index Confluence spaces, pages, comments, and page hierarchy.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'baseUrl', label: 'Confluence base URL', type: 'string' }, { key: 'spaces', label: 'Spaces', type: 'string-list' }, { key: 'includeComments', label: 'Include comments', type: 'boolean', defaultValue: true }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'apiToken', label: 'API token', type: 'secret', required: true }] },
    { source: 'jira', title: 'Jira', description: 'Index Jira projects, issues, comments, labels, and status metadata.', flows: ['checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'baseUrl', label: 'Jira base URL', type: 'string' }, { key: 'projects', label: 'Projects', type: 'string-list' }, { key: 'jql', label: 'JQL filter', type: 'string' }, { key: 'includeComments', label: 'Include comments', type: 'boolean', defaultValue: true }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'apiToken', label: 'API token', type: 'secret', required: true }] },
    { source: 'filesystem', title: 'Filesystem', description: 'Index local folders, docs, notes, and generated artifacts from the workspace.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['none'], configFields: [{ key: 'roots', label: 'Folders', type: 'string-list' }, { key: 'includeGlobs', label: 'Include globs', type: 'string-list' }, { key: 'excludeGlobs', label: 'Exclude globs', type: 'string-list' }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [] },
    { source: 'web', title: 'Web', description: 'Index product docs, public sites, sitemap pages, and release notes.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['none', 'static'], configFields: [{ key: 'baseUrl', label: 'Base URL', type: 'string' }, { key: 'mode', label: 'Scrape mode', type: 'string' }, { key: 'depth', label: 'Max depth', type: 'number' }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'headerToken', label: 'Header token', type: 'secret' }] },
    { source: 'mcp', title: 'MCP Resources', description: 'Index resources exposed by a configured MCP tool server.', flows: ['checkpoint', 'slim'], credentialModes: ['none'], configFields: [{ key: 'serverId', label: 'MCP server id', type: 'string' }, { key: 'resourceUris', label: 'Resource URIs', type: 'string-list' }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [] },
    { source: 'notion', title: 'Notion', description: 'Index Notion pages, databases, and wikis for search and recall.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'databaseIds', label: 'Database ids', type: 'string-list' }, { key: 'includeComments', label: 'Include comments', type: 'boolean', defaultValue: false }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'token', label: 'Integration token', type: 'secret', required: true }] },
    { source: 'linear', title: 'Linear', description: 'Index Linear issues, projects, and comments.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'teamKeys', label: 'Teams', type: 'string-list' }, { key: 'includeComments', label: 'Include comments', type: 'boolean', defaultValue: true }, { key: 'includeArchived', label: 'Include archived', type: 'boolean', defaultValue: false }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }] },
    { source: 'gmail', title: 'Gmail', description: 'Index Gmail threads and messages.', flows: ['load', 'checkpoint', 'slim'], credentialModes: ['static', 'oauth'], configFields: [{ key: 'query', label: 'Search query', type: 'string' }, { key: 'pollMinutes', label: 'Auto run minutes', type: 'number' }], credentialFields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }] },
  ];
  let devConnectors: ConnectorRecord[] = [
    {
      id: 'conn_demo1',
      source: 'github',
      name: 'BrainRouter GitHub',
      status: 'active',
      config: { owner: 'kinqsradiollc', repositories: ['BrainRouter', 'brainrouter-desktop'], includeIssues: true, includePullRequests: true, includeFiles: false },
      credential: { mode: 'dynamic', ref: 'gh', label: 'GitHub CLI' },
      flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
      workspaceRoot: '/Users/dev/BrainRouter',
      lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
      lastSuccessAt: new Date(Date.now() - 3600_000).toISOString(),
      checkpoint: { cursor: 'demo', documentCount: 3 },
      createdAt: new Date(Date.now() - 86400_000).toISOString(),
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    },
  ];
  const devConnectorDocuments = [
    { id: 'github:demo:issue:1', connectorId: 'conn_demo1', source: 'github', kind: 'issue', repository: 'kinqsradiollc/BrainRouter', title: '#1 Demo issue', snippet: 'Demo issue from the GitHub connector.', metadata: { number: 1 } },
    { id: 'github:demo:pull:2', connectorId: 'conn_demo1', source: 'github', kind: 'pull-request', repository: 'kinqsradiollc/BrainRouter', title: '#2 Demo PR', snippet: 'Demo PR from the GitHub connector.', metadata: { number: 2 } },
    { id: 'github:demo:file:README.md', connectorId: 'conn_demo1', source: 'github', kind: 'file', repository: 'kinqsradiollc/BrainRouter', title: 'README.md', snippet: '# Demo connector readme.', metadata: { path: 'README.md' } },
  ];
  const devSlimDocuments = (connectorId?: string, limit = 20) =>
    devConnectorDocuments
      .filter((doc) => !connectorId || doc.connectorId === connectorId)
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((doc) => ({ ...doc, score: 1 }));
  const devConnectorPermissionCounts: Record<string, number> = { conn_demo1: 2 };
  const devConnectorRuns: Record<string, Array<{ id: string; connectorId: string; source: string; flow: string; status: string; startedAt: string; completedAt?: string; documentsSeen?: number; documentsIndexed?: number; permissionsSeen?: number; permissionsIndexed?: number; failures?: number }>> = {};
  // WS9 — carry identity/type so the grouped MCP layout (Brains vs Tools) and the
  // single-active-brain affordance render in browser-only dev.
  const devServers: Array<{ id: string; online: boolean; detail?: string; identity?: 'brainrouter' | 'third-party'; type?: 'stdio' | 'http'; url?: string | null; command?: string | null }> = [
    { id: 'brainrouter', online: true, identity: 'brainrouter', type: 'stdio', command: 'npx -y @kinqs/brainrouter-mcp' },
    { id: 'brainrouter-staging', online: false, identity: 'brainrouter', type: 'http', url: 'https://staging.brain.example/mcp' },
    { id: 'github', online: false, identity: 'third-party', type: 'http', url: 'https://api.githubcopilot.com/mcp' },
    { id: 'filesystem', online: true, identity: 'third-party', type: 'stdio', command: 'npx -y @modelcontextprotocol/server-filesystem .' },
  ];
  let devActiveServer = 'brainrouter';
  let devShellAlive = true; // WS2 2.4 — a background dev-server shell the Stop control can kill

  // T5 — a tiny in-memory FS so the editor (open/edit/save/stale-write) is
  // exercisable in the browser preview without a real host.
  const devFiles: Record<string, { content: string; mtimeMs: number }> = {
    'README.md': { content: '# BrainRouter\n\nA **memory-first** AI coding agent.\n\n## Features\n\n- 4-stage recall pipeline\n- Multi-agent orchestration\n- Visual workflow canvas\n\nSee the [getting-started guide](docs/guide.md) or the [website](https://brainrouter.dev).\n\n> Docs mode lets you edit Markdown with a live preview.\n', mtimeMs: 1_000 },
    'docs/guide.md': { content: '# Getting started\n\nThis opened **in the Docs editor** — not a new window.\n\nBack to the [README](../README.md).\n', mtimeMs: 1_100 },
    'src/memory/recall.ts': { content: 'export function recall(query: string) {\n  // 4-stage pipeline: retrieve -> rerank -> judge -> expand\n  const ranked = rerank(retrieve(query));\n  return expand(judge(ranked));\n}\n', mtimeMs: 1_000 },
    'src/state/completionInbox.ts': { content: '/** Completion inbox - detached workers report back here. */\nimport { randomUUID } from "node:crypto";\n\nexport interface Completion {\n  id: string;\n  parentSessionKey: string;\n  summary: string;\n}\n', mtimeMs: 1_000 },
    'assets/logo.png': { content: 'binary-bytes', mtimeMs: 1_000 },
  };
  const devWorkflows: Record<string, Record<string, unknown>> = {};
  const devShortcuts: Record<string, string> = {}; // §5.9 — in-memory shortcut overrides
  const devFileRead = (p: string): unknown => {
    const f = devFiles[p];
    if (!f) return { path: p, kind: 'file', content: '', error: 'ENOENT: no such file (dev bridge)' };
    if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip)$/i.test(p)) return { path: p, kind: 'file', content: '', binary: true, size: f.content.length, mtimeMs: f.mtimeMs };
    return { path: p, kind: 'file', content: f.content, size: f.content.length, mtimeMs: f.mtimeMs };
  };

  type DevAttachment = {
    id: string; name: string; kind: string; mimeType: string; byteSize: number;
    extractedText?: string; workspaceRoot: string; sessionKey: string; createdAt: string;
  };
  let devAttachmentSeq = 1;
  const devAttachments = new Map<string, DevAttachment>();
  const attachmentKind = (name: string): string => {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
    if (/\.pdf$/i.test(name)) return 'pdf';
    return 'text';
  };
  const attachmentMime = (name: string, kind: string): string => {
    if (kind === 'pdf') return 'application/pdf';
    if (kind === 'image') return name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/*';
    return 'text/plain';
  };
  const decodePreview = (dataBase64: string, kind: string): string | undefined => {
    if (kind !== 'text') return undefined;
    try {
      const decoded = atob(dataBase64.slice(0, 16_384));
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return undefined;
      return decoded.slice(0, 3_000);
    } catch {
      return undefined;
    }
  };
  const attachmentContext = (a: DevAttachment): string => {
    const lines = [
      `### Attachment: ${a.name}`,
      `- id: ${a.id}`,
      `- kind: ${a.kind}`,
      `- mime: ${a.mimeType}`,
      `- bytes: ${a.byteSize}`,
    ];
    if (!a.extractedText) return lines.join('\n');
    const text = a.extractedText.replace(/```/g, "'''").trim();
    return `${lines.join('\n')}\n\n\`\`\`text\n${text}\n\`\`\``;
  };
  return {
    get termBuf() { return termBuf; }, set termBuf(v) { termBuf = v; },
    get seq() { return seq; }, set seq(v) { seq = v; },
    get activeSession() { return activeSession; }, set activeSession(v) { activeSession = v; },
    get devModel() { return devModel; }, set devModel(v) { devModel = v; },
    get bootAnnounced() { return bootAnnounced; }, set bootAnnounced(v) { bootAnnounced = v; },
    get devCtxUsed() { return devCtxUsed; }, set devCtxUsed(v) { devCtxUsed = v; },
    get wsCurrent() { return wsCurrent; }, set wsCurrent(v) { wsCurrent = v; },
    get wsRecents() { return wsRecents; }, set wsRecents(v) { wsRecents = v; },
    get devReview() { return devReview; }, set devReview(v) { devReview = v; },
    get devDefaultProvider() { return devDefaultProvider; }, set devDefaultProvider(v) { devDefaultProvider = v; },
    get devConnectors() { return devConnectors; }, set devConnectors(v) { devConnectors = v; },
    get devActiveServer() { return devActiveServer; }, set devActiveServer(v) { devActiveServer = v; },
    get devShellAlive() { return devShellAlive; }, set devShellAlive(v) { devShellAlive = v; },
    get schedSeq() { return schedSeq; }, set schedSeq(v) { schedSeq = v; },
    get reqSeq() { return reqSeq; }, set reqSeq(v) { reqSeq = v; },
    get annotSeq() { return annotSeq; }, set annotSeq(v) { annotSeq = v; },
    get artSeq() { return artSeq; }, set artSeq(v) { artSeq = v; },
    get devTrackN() { return devTrackN; }, set devTrackN(v) { devTrackN = v; },
    get devNotesN() { return devNotesN; }, set devNotesN(v) { devNotesN = v; },
    get devSprintN() { return devSprintN; }, set devSprintN(v) { devSprintN = v; },
    get devModuleN() { return devModuleN; }, set devModuleN(v) { devModuleN = v; },
    get devViewN() { return devViewN; }, set devViewN(v) { devViewN = v; },
    get devAutoN() { return devAutoN; }, set devAutoN(v) { devAutoN = v; },
    get devPlanSeq() { return devPlanSeq; }, set devPlanSeq(v) { devPlanSeq = v; },
    get devAttachmentSeq() { return devAttachmentSeq; }, set devAttachmentSeq(v) { devAttachmentSeq = v; },
    listeners,
    recentsListeners,
    runningSessions,
    emit,
    DEMO_DIFF,
    prefs,
    sessionModes,
    effectivePrefs,
    devSessionModels,
    resolvedModel,
    trustedRoots,
    onboarding,
    SESSIONS_BY_ROOT,
    devMeta,
    mergeMeta,
    devGroups,
    devSchedules,
    devWorktrees,
    nowIso,
    devRequirements,
    devAnnotations,
    devAnnotMarkdown,
    devArtifacts,
    devPlanState,
    trackCat,
    mkItem,
    devTrack,
    devSprints,
    devModules,
    devViews,
    devFindItem,
    devAutomations,
    devPlanDecisions,
    DEV_DIFF_HASH,
    devRunReview,
    devGate,
    devRules,
    devProviders,
    devCliKnobs,
    devExtensions,
    devGithub,
    devConnectorCatalog,
    devConnectorDocuments,
    devSlimDocuments,
    devConnectorPermissionCounts,
    devConnectorRuns,
    devServers,
    devFiles,
    devWorkflows,
    devShortcuts,
    devFileRead,
    devAttachments,
    attachmentKind,
    attachmentMime,
    decodePreview,
    attachmentContext,
  };
}

export type DevState = ReturnType<typeof createDevState>;
