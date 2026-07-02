/**
 * DESK-4c — browser-dev mock bridge. In Electron the preload provides
 * `window.brainrouter`; in a plain browser (vite dev / UI work without the
 * shell) this installs a canned stand-in so every surface renders populated:
 * demo sessions, files, diff, plan, fleet, tokens, settings snapshot, the
 * command catalog, an echo turn with a tool group, and an approval dialog
 * when the prompt mentions "approve". No-op when the real bridge exists.
 */
import type { AgentCommand, AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type { AtlasGraph, ConnectorCatalogEntry, ConnectorRecord } from '@kinqs/brainrouter-types';

/** A representative synthetic codebase (small commerce app) for browser-only dev. */
function devFile(path: string, category: 'code' | 'config' | 'docs' | 'infra', complexity: 'simple' | 'moderate' | 'complex', lang = 'typescript') {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const type = category === 'config' ? 'config' : category === 'docs' ? 'document' : category === 'infra' ? 'resource' : 'file';
  return { id: `${type}:${path}`, type, name, filePath: path, language: lang, category, complexity } as AtlasGraph['nodes'][number];
}
const DEV_FILES: Array<[string, 'code' | 'config' | 'docs' | 'infra', 'simple' | 'moderate' | 'complex', string?]> = [
  ['src/gateway/server.ts', 'code', 'moderate'], ['src/gateway/routes.ts', 'code', 'moderate'], ['src/gateway/middleware.ts', 'code', 'simple'],
  ['src/cart/cart.ts', 'code', 'moderate'], ['src/cart/cartStore.ts', 'code', 'complex'],
  ['src/catalog/catalog.ts', 'code', 'moderate'], ['src/catalog/search.ts', 'code', 'complex'],
  ['src/checkout/checkout.ts', 'code', 'complex'], ['src/checkout/orchestrator.ts', 'code', 'complex'],
  ['src/payment/payment.ts', 'code', 'moderate'], ['src/payment/validate.ts', 'code', 'simple'],
  ['src/ui/App.tsx', 'code', 'moderate'], ['src/ui/ProductList.tsx', 'code', 'moderate'], ['src/ui/CartView.tsx', 'code', 'simple'],
  ['src/shared/types.ts', 'code', 'simple'], ['src/shared/http.ts', 'code', 'simple'],
  ['src/cart/cartStore.test.ts', 'code', 'simple'],
  // Typed service ports (Wave 3) — each module's facade over its internals.
  ['src/cart/service.ts', 'code', 'simple'], ['src/catalog/service.ts', 'code', 'simple'],
  ['src/payment/service.ts', 'code', 'simple'], ['src/checkout/service.ts', 'code', 'moderate'],
  ['package.json', 'config', 'simple', 'json'], ['tsconfig.json', 'config', 'simple', 'json'], ['Dockerfile', 'infra', 'simple', 'docker'],
  ['README.md', 'docs', 'simple', 'markdown'],
];
const DEV_IMPORTS: Array<[string, string]> = [
  ['src/gateway/server.ts', 'src/gateway/routes.ts'], ['src/gateway/server.ts', 'src/gateway/middleware.ts'],
  ['src/gateway/routes.ts', 'src/cart/cart.ts'], ['src/gateway/routes.ts', 'src/catalog/catalog.ts'], ['src/gateway/routes.ts', 'src/checkout/checkout.ts'],
  ['src/cart/cart.ts', 'src/cart/cartStore.ts'], ['src/cart/cart.ts', 'src/shared/types.ts'],
  ['src/catalog/catalog.ts', 'src/catalog/search.ts'], ['src/catalog/catalog.ts', 'src/shared/types.ts'],
  ['src/checkout/checkout.ts', 'src/checkout/orchestrator.ts'], ['src/checkout/orchestrator.ts', 'src/cart/cart.ts'],
  ['src/checkout/orchestrator.ts', 'src/catalog/catalog.ts'], ['src/checkout/orchestrator.ts', 'src/payment/payment.ts'],
  ['src/payment/payment.ts', 'src/payment/validate.ts'], ['src/payment/payment.ts', 'src/shared/http.ts'],
  ['src/ui/App.tsx', 'src/ui/ProductList.tsx'], ['src/ui/App.tsx', 'src/ui/CartView.tsx'], ['src/ui/App.tsx', 'src/shared/http.ts'],
  ['src/cart/cartStore.ts', 'src/shared/types.ts'], ['src/catalog/search.ts', 'src/shared/types.ts'],
  ['src/cart/cartStore.test.ts', 'src/cart/cartStore.ts'],
  // Service ports delegate to their module internals…
  ['src/cart/service.ts', 'src/cart/cartStore.ts'], ['src/catalog/service.ts', 'src/catalog/catalog.ts'],
  ['src/payment/service.ts', 'src/payment/payment.ts'],
  // …and checkout's port composes the cart/catalog/payment services (cross-module).
  ['src/checkout/service.ts', 'src/cart/service.ts'], ['src/checkout/service.ts', 'src/catalog/service.ts'],
  ['src/checkout/service.ts', 'src/payment/service.ts'],
];
function devAtlasGraph(): AtlasGraph {
  const nodes = DEV_FILES.map(([p, c, cx, lang]) => devFile(p, c, cx, lang));
  const id = (p: string): string => nodes.find((n) => n.filePath === p)!.id;
  const edges: AtlasGraph['edges'] = DEV_IMPORTS.map(([a, b]) => ({ source: id(a), target: id(b), type: 'imports', weight: 0.9 }));
  // entity (class) + function symbols for the detail card and domain entities
  const sym: Array<[string, string, 'class' | 'function', string, [number, number]]> = [
    ['class:src/cart/cartStore.ts:CartStore', 'CartStore', 'class', 'src/cart/cartStore.ts', [8, 74]],
    ['class:src/catalog/catalog.ts:Product', 'Product', 'class', 'src/catalog/catalog.ts', [3, 22]],
    ['class:src/catalog/search.ts:SearchIndex', 'SearchIndex', 'class', 'src/catalog/search.ts', [5, 48]],
    ['class:src/payment/payment.ts:Charge', 'Charge', 'class', 'src/payment/payment.ts', [4, 30]],
    ['class:src/gateway/server.ts:Server', 'Server', 'class', 'src/gateway/server.ts', [6, 40]],
    ['class:src/shared/types.ts:Order', 'Order', 'class', 'src/shared/types.ts', [1, 18]],
    ['function:src/checkout/orchestrator.ts:placeOrder', 'placeOrder', 'function', 'src/checkout/orchestrator.ts', [12, 58]],
  ];
  for (const [sid, name, type, filePath, lineRange] of sym) {
    nodes.push({ id: sid, type, name, filePath, lineRange } as AtlasGraph['nodes'][number]);
    edges.push({ source: id(filePath), target: sid, type: 'contains' as const, weight: 1 });
  }
  return {
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'commerce-demo', languages: ['typescript', 'json'], frameworks: ['React'], description: 'A small commerce app for the Atlas panel.', analyzedAt: '2026-06-22T00:00:00Z', totalFiles: DEV_FILES.length },
    nodes, edges, layers: [], tour: [],
  };
}

/** The dev graph with LLM enrichment applied — summaries, tags, layers, tour. */
function devAtlasEnriched(): AtlasGraph {
  const g = devAtlasGraph();
  const sum: Record<string, string> = {
    'src/gateway/server.ts': 'HTTP gateway entry — boots the server and mounts routes.',
    'src/gateway/routes.ts': 'Maps HTTP routes to the cart, catalog, and checkout services.',
    'src/cart/cartStore.ts': 'In-memory cart persistence with add/remove/total.',
    'src/catalog/search.ts': 'Product search and filtering over the catalog.',
    'src/checkout/orchestrator.ts': 'Coordinates cart, catalog, and payment to place an order.',
    'src/payment/payment.ts': 'Simulated card payment processing and validation.',
    'src/ui/App.tsx': 'Root React component wiring the storefront UI.',
    'src/shared/types.ts': 'Shared domain types used across services.',
  };
  g.nodes = g.nodes.map((n) => (n.filePath && sum[n.filePath] ? { ...n, summary: sum[n.filePath], tags: [n.category ?? 'code'] } : n));
  const L = (p: string): string => `file:${p}`;
  g.layers = [
    { id: 'layer:gateway', name: 'API Gateway', description: 'Inbound HTTP surface and routing.', nodeIds: ['file:src/gateway/server.ts', 'file:src/gateway/routes.ts', 'file:src/gateway/middleware.ts'] },
    { id: 'layer:cart', name: 'Cart', description: 'Shopping cart state and operations.', nodeIds: [L('src/cart/cart.ts'), L('src/cart/cartStore.ts')] },
    { id: 'layer:catalog', name: 'Catalog', description: 'Product listing and search.', nodeIds: [L('src/catalog/catalog.ts'), L('src/catalog/search.ts')] },
    { id: 'layer:checkout', name: 'Checkout & Payment', description: 'Order orchestration and payment.', nodeIds: [L('src/checkout/checkout.ts'), L('src/checkout/orchestrator.ts'), L('src/payment/payment.ts'), L('src/payment/validate.ts')] },
    { id: 'layer:ui', name: 'Storefront UI', description: 'React storefront components.', nodeIds: [L('src/ui/App.tsx'), L('src/ui/ProductList.tsx'), L('src/ui/CartView.tsx')] },
    { id: 'layer:shared', name: 'Shared', description: 'Cross-cutting types and helpers.', nodeIds: [L('src/shared/types.ts'), L('src/shared/http.ts')] },
    { id: 'layer:config', name: 'Config & Docs', description: 'Build config and documentation.', nodeIds: ['config:package.json', 'config:tsconfig.json', 'resource:Dockerfile', 'document:README.md'] },
  ];
  g.tour = [
    { order: 1, title: 'Start at the gateway', description: 'server.ts boots the app and mounts routes.ts.', nodeIds: ['file:src/gateway/server.ts', 'file:src/gateway/routes.ts'] },
    { order: 2, title: 'Browse the catalog', description: 'catalog.ts + search.ts power product discovery.', nodeIds: [L('src/catalog/catalog.ts'), L('src/catalog/search.ts')] },
    { order: 3, title: 'The cart', description: 'cartStore.ts holds cart state.', nodeIds: [L('src/cart/cartStore.ts')] },
    { order: 4, title: 'Checkout flow', description: 'orchestrator.ts coordinates cart, catalog, and payment.', nodeIds: [L('src/checkout/orchestrator.ts'), L('src/payment/payment.ts')] },
    { order: 5, title: 'The storefront', description: 'App.tsx renders the UI.', nodeIds: [L('src/ui/App.tsx')] },
  ];
  // Semantic layer relationships (LLM relationship pass) — labels the Domain
  // view shows on its inter-layer edges. Only pairs with a real cross-layer
  // import edge above are labelled.
  g.layerEdges = [
    { source: 'layer:gateway', target: 'layer:cart', label: 'routes to' },
    { source: 'layer:gateway', target: 'layer:catalog', label: 'routes to' },
    { source: 'layer:gateway', target: 'layer:checkout', label: 'routes to' },
    { source: 'layer:checkout', target: 'layer:cart', label: 'reads cart from' },
    { source: 'layer:checkout', target: 'layer:catalog', label: 'looks up in' },
    { source: 'layer:checkout', target: 'layer:shared', label: 'uses' },
    { source: 'layer:cart', target: 'layer:shared', label: 'uses' },
    { source: 'layer:catalog', target: 'layer:shared', label: 'uses' },
    { source: 'layer:ui', target: 'layer:shared', label: 'calls' },
  ];
  return g;
}

export function installDevBridge(): void {
  if (typeof window === 'undefined' || (window as { brainrouter?: unknown }).brainrouter) return;

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
    effort: 'medium', personality: 'standard', tier: null, theme: 'dark', quiet: false,
    memoriesEnabled: true, personaAnchorEnabled: true, experimental: false, rawScrollback: false, editorMode: 'emacs',
  } as Record<string, unknown>;
  const sessionModes: Record<string, Record<string, unknown>> = {};
  const effectivePrefs = () => ({ ...prefs, ...(sessionModes[activeSession] ?? {}) });

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
  const devProviders: Array<{ name: string; provider: string; model: string; endpoint: string | null; hasKey: boolean; models: string[]; apiVersion?: string | null }> = [
    { name: 'groq', provider: 'groq', model: 'llama-3.3-70b', endpoint: 'https://api.groq.com/openai/v1', hasKey: true, models: ['llama-3.3-70b', 'llama-3.1-405b', 'mixtral-8x7b'] },
    { name: 'local', provider: 'lmstudio', model: 'qwen2.5-coder-7b', endpoint: 'http://localhost:1234/v1', hasKey: false, models: [] },
  ];
  let devDefaultProvider: string | null = 'groq';
  const devCliKnobs: Record<string, unknown> = { autoCompactTokens: 80000, maxToolLoops: 60, recallMode: 'gated', contextCompaction: true, llmTimeoutMs: 120000, automation: { enabled: true, requirements: { enabled: true, autopilot: false }, sync: { enabled: true }, sprints: { enabled: true, autopilot: true } } };
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

  const queries: Record<string, (args: Record<string, unknown>) => unknown> = {
    'list-sessions': () => mergeMeta(wsCurrent),
    'schedule-list': () => devSchedules,
    'schedule-add': (a) => {
      const kind = a.kind === 'once' ? 'once' : 'cron';
      const expr = String(a.expr ?? ''); const command = String(a.command ?? '');
      const nextRun = kind === 'once' ? new Date(expr).toISOString() : new Date(Date.now() + 900_000).toISOString();
      const rec = { id: `sch_dev${++schedSeq}`, kind: kind as 'cron' | 'once', expr, command, owner: activeSession, enabled: true, createdAt: new Date().toISOString(), nextRun };
      devSchedules.push(rec); return { ok: true, schedule: rec };
    },
    'schedule-remove': (a) => { const i = devSchedules.findIndex((s) => s.id === a.id); if (i >= 0) devSchedules.splice(i, 1); return { ok: i >= 0 }; },
    'schedule-toggle': (a) => { const s = devSchedules.find((x) => x.id === a.id); if (s) s.enabled = a.enabled !== false; return { ok: !!s, enabled: a.enabled !== false }; },
    // T13 — mock git worktrees (raw porcelain, parsed in the renderer).
    'git-worktrees': () => ({ raw: devWorktrees.map((w) => `worktree ${w.path}\nHEAD ${'a'.repeat(40)}\n${w.detached ? 'detached' : `branch refs/heads/${w.branch}`}\n`).join('\n'), gitRoot: '/Users/dev/BrainRouter', current: wsCurrent }),
    'worktree-diff': () => ({ path: '', diff: DEMO_DIFF, files: 1 }),
    'worktree-create': (a) => { const name = String(a.name ?? ''); const p = `/Users/dev/BrainRouter/.worktrees/${name}`; devWorktrees.push({ path: p, branch: name, detached: false }); return { ok: true, path: p }; },
    'worktree-remove': (a) => { const i = devWorktrees.findIndex((w) => w.path === a.path); if (i >= 0) devWorktrees.splice(i, 1); return { ok: i >= 0 }; },
    // REQUIREMENT-RECORDS — mock the requirementStore wrappers (mutate in-memory).
    // ATLAS — a small synthetic codebase graph so the Atlas panel renders in
    // browser-only dev (real builds come from the host's deterministic builder).
    'atlas-graph': () => devAtlasEnriched(),
    'atlas-build': () => { const g = devAtlasGraph(); return { graph: g, stats: { files: 20, functions: 1, classes: 1, nodes: g.nodes.length, edges: g.edges.length, layers: 0, enriched: false } }; },
    'atlas-enrich': () => {
      const g = devAtlasEnriched();
      return {
        graph: g,
        stats: { files: 7, functions: 5, classes: 2, nodes: g.nodes.length, edges: g.edges.length, layers: g.layers.length, enriched: true },
        enrichResult: { summarized: g.nodes.filter((n) => n.summary).length, layers: g.layers.length, tourSteps: g.tour.length, relationships: g.layerEdges?.length ?? 0, batchesFailed: 0 },
      };
    },
    'atlas-explain-change': (a) => {
      const path = String((a as { path?: string }).path ?? '');
      return {
        path,
        assessment: {
          summary: `This change to ${path.split('/').pop()} adjusts its core logic and updates the call sites it touches.`,
          risk: path.includes('payment') || path.includes('checkout') ? 'high' : path.includes('search') ? 'medium' : 'low',
          checklist: ['Confirm the public API/signature is unchanged or all callers updated', 'Check error handling on the new path', 'Verify there is test coverage for this change'],
          concerns: path.includes('payment') ? ['Touches payment logic — validate amounts and currency handling', 'No test changes detected alongside this edit'] : [],
        },
      };
    },
    'requirement-list': () => [...devRequirements].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    'requirement-create': (a) => {
      const id = `req_dev${++reqSeq}`;
      const rec: DevReq = {
        id, title: String(a.title ?? '').trim() || 'Untitled requirement', status: 'draft', priority: 'medium',
        acceptanceCriteria: [], clarifyingQuestions: [], workspaceRoot: wsCurrent, sessionKey: activeSession,
        taskIds: [], artifactIds: [], linkedMemoryIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      devRequirements.unshift(rec); return rec;
    },
    'requirement-update': (a) => {
      const r = devRequirements.find((x) => x.id === a.id);
      if (!r) return { error: `No requirement "${String(a.id)}".` };
      if (a.status !== undefined) {
        if (!['draft', 'clarifying', 'ready', 'in-progress', 'done', 'archived'].includes(String(a.status))) return { error: 'bad status' };
        r.status = String(a.status);
      }
      if (a.priority !== undefined) {
        if (!['low', 'medium', 'high'].includes(String(a.priority))) return { error: 'bad priority' };
        r.priority = String(a.priority);
      }
      if (typeof a.criterion === 'string' && a.criterion.trim()) r.acceptanceCriteria = [...r.acceptanceCriteria, a.criterion.trim()];
      r.updatedAt = new Date().toISOString();
      return r;
    },
    'requirement-delete': (a) => {
      const index = devRequirements.findIndex((r) => r.id === a.id);
      if (index >= 0) devRequirements.splice(index, 1);
      return { ok: index >= 0 };
    },
    'requirement-seed-plan': (a) => {
      const r = devRequirements.find((x) => x.id === a.id);
      if (!r) return { error: `No requirement "${String(a.id)}".` };
      if (r.acceptanceCriteria.length === 0) return { error: 'No acceptance criteria to seed a plan from.' };
      if (['draft', 'clarifying', 'ready'].includes(r.status)) r.status = 'in-progress';
      return { ok: true, items: r.acceptanceCriteria.map((c) => ({ step: c, status: 'pending', acceptance: c })) };
    },
    'requirement-promote': (a) => {
      const r = devRequirements.find((x) => x.id === a.id);
      if (!r) return { error: `No requirement "${String(a.id)}".` };
      if (r.acceptanceCriteria.length === 0) return { error: 'No acceptance criteria yet.' };
      r.status = 'in-progress';
      return { ok: true, created: r.acceptanceCriteria.length, requirements: [...devRequirements] };
    },
    // ANNOTATION-RECORDS — mock the annotationStore + annotationExport wrappers
    // (mutate in-memory). Filtering ANDs status + targetKind, mirroring the host.
    'annotation-list': (a) => devAnnotations
      .filter((x) => (!a.status || x.status === a.status) && (!a.targetKind || x.type === a.targetKind))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
    'annotation-create': (a) => {
      const kinds = ['plan', 'requirement', 'artifact', 'markdown', 'html', 'message', 'diff', 'file', 'review-finding'];
      if (!kinds.includes(String(a.type))) return { error: `Unknown annotation target kind "${String(a.type)}".` };
      const body = String(a.body ?? '').trim();
      if (!body) return { error: 'Annotation body must be a non-empty string.' };
      const anchor = a.anchor && typeof a.anchor === 'object' ? (a.anchor as DevAnnot['anchor']) : undefined;
      const rec: DevAnnot = {
        id: `ann_dev${++annotSeq}`, type: String(a.type), body, workspaceRoot: wsCurrent, sessionKey: activeSession,
        status: 'open', linkedMemoryIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      if (typeof a.targetId === 'string' && a.targetId) rec.targetId = a.targetId;
      if (typeof a.severity === 'string') rec.severity = String(a.severity);
      if (anchor) rec.anchor = anchor;
      if (typeof a.suggestedText === 'string' && a.suggestedText) rec.suggestedText = a.suggestedText;
      devAnnotations.unshift(rec); return rec;
    },
    'annotation-set-status': (a) => {
      if (!['open', 'accepted', 'rejected', 'resolved', 'ignored'].includes(String(a.status))) return { error: `Unknown annotation status "${String(a.status)}".` };
      const r = devAnnotations.find((x) => x.id === a.id);
      if (!r) return { error: `No annotation "${String(a.id)}".` };
      r.status = String(a.status); r.updatedAt = new Date().toISOString();
      return r;
    },
    // §6 COMMENT THREADS — append a comment to the in-memory thread so the panel updates live.
    'annotation-add-comment': (a) => {
      const body = typeof a.body === 'string' ? a.body.trim() : '';
      if (!body) return { error: 'Comment body must be a non-empty string.' };
      const r = devAnnotations.find((x) => x.id === a.id);
      if (!r) return { error: `No annotation "${String(a.id)}".` };
      r.comments = [...(r.comments ?? []), { id: `cmt_${(annotSeq++).toString(16).padStart(8, '0')}`, body, createdAt: new Date().toISOString() }];
      r.updatedAt = new Date().toISOString();
      return r;
    },
    'annotation-export': (a) => ({ markdown: devAnnotMarkdown(devAnnotations.filter((x) => (!a.status || x.status === a.status) && (!a.targetKind || x.type === a.targetKind))) }),
    // ARTIFACT-RECORDS — mock the artifactStore wrappers (mutate in-memory).
    // Filtering ANDs kind + status, mirroring the host. artifact-read returns the
    // inline content, or sample file content for a path-backed artifact (the host
    // reads the real file through the safe workspace read).
    'artifact-list': (a) => devArtifacts
      .filter((x) => (!a.kind || x.kind === a.kind) && (!a.status || x.status === a.status))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
    'artifact-create': (a) => {
      const kinds = ['design-note', 'sketch', 'html-prototype', 'markdown-report', 'verification-summary', 'review-export', 'other'];
      if (!kinds.includes(String(a.kind))) return { error: `Unknown artifact kind "${String(a.kind)}".` };
      const title = String(a.title ?? '').trim();
      if (!title) return { error: 'Artifact title must be a non-empty string.' };
      const formats = ['markdown', 'html', 'text'];
      if (a.format !== undefined && !formats.includes(String(a.format))) return { error: `Unknown artifact format "${String(a.format)}".` };
      const rec: DevArtifact = {
        id: `art_dev${++artSeq}`, kind: String(a.kind), title,
        status: typeof a.status === 'string' && ['draft', 'final', 'archived'].includes(a.status) ? a.status : 'draft',
        format: typeof a.format === 'string' && formats.includes(a.format) ? a.format : 'markdown',
        workspaceRoot: wsCurrent, sessionKey: activeSession, linkedMemoryIds: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      if (typeof a.summary === 'string' && a.summary.trim()) rec.summary = a.summary;
      if (typeof a.content === 'string' && a.content.length) rec.content = a.content;
      if (typeof a.path === 'string' && a.path.trim()) rec.path = a.path.trim();
      devArtifacts.unshift(rec); return rec;
    },
    'artifact-update': (a) => {
      const r = devArtifacts.find((x) => x.id === a.id);
      if (!r) return { error: `No artifact "${String(a.id)}".` };
      if (a.status !== undefined) {
        if (!['draft', 'final', 'archived'].includes(String(a.status))) return { error: `Unknown artifact status "${String(a.status)}".` };
        r.status = String(a.status);
      }
      if (a.summary !== undefined) {
        if (typeof a.summary !== 'string') return { error: 'Artifact summary must be a string.' };
        r.summary = a.summary;
      }
      r.updatedAt = new Date().toISOString();
      return r;
    },
    'artifact-read': (a) => {
      const r = devArtifacts.find((x) => x.id === a.id);
      if (!r) return { error: `No artifact "${String(a.id)}".` };
      if (r.path) {
        // The host reads the real file via the safe workspace read; the preview
        // shows sample file content here so the path-backed case is demonstrable.
        return { id: r.id, content: `# ${r.title}\n\n_(file: ${r.path})_\n\nThe Core Identity anchor is injected **before** federation context in the CLI briefing, so the persona survives the recall blend.\n\n1. Distill Core Identity from the brain.\n2. Inject the anchor as the first briefing block.\n3. Append federation + recall context after it.\n` };
      }
      return { id: r.id, content: r.content ?? '' };
    },
    // §12 WRITE-WORKSPACE — save edited content. Inline artifacts update their
    // stored content (so the preview reflects the edit); path-backed ones report
    // ok (the host writes the real file via the safe workspace write).
    'artifact-save': (a) => {
      const content = typeof a.content === 'string' ? a.content : null;
      if (content === null) return { error: 'Artifact content must be a string.' };
      const r = devArtifacts.find((x) => x.id === a.id);
      if (!r) return { error: `No artifact "${String(a.id)}".` };
      if (!r.path) r.content = content;
      r.updatedAt = new Date().toISOString();
      return { id: r.id, ok: true, path: r.path };
    },
    // T12 — mock a local review pass over the working diff.
    // Review v2 — shared run + gate so the commit/push gate is demonstrable.
    'review-diff': () => devRunReview(),
    'review-rerun': () => devRunReview(),
    'review-current': () => ({ run: devReview, gate: devGate(), diffHash: DEV_DIFF_HASH, files: 2 }),
    'review-gate': () => ({ run: devReview, gate: devGate(), diffHash: DEV_DIFF_HASH, files: 2 }),
    'review-status': () => { const g = devGate(); return { status: g.status, blocked: g.blocked, reason: g.reason }; },
    'review-dismiss-finding': (a) => { const f = devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'dismissed'; return { ok: !!f }; },
    'review-resolve-finding': (a) => { const f = devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'fixed'; return { ok: !!f }; },
    'review-set-finding-status': (a) => { const ok = ['open','applied','dismissed','fixed','stale','acknowledged','disputed','out-of-scope'].includes(String(a.status)); if (!ok) return { ok: false, error: 'bad status' }; const f = devReview?.findings.find((x) => x.id === a.id); if (f) f.status = String(a.status); return { ok: !!f }; },
    'review-apply-suggestion': (a) => { const f = devReview?.findings.find((x) => x.id === a.id); if (f && f.patch) { f.status = 'applied'; return { ok: true }; } return { ok: false, error: 'This finding has no applicable patch — use "Ask agent to fix".' }; },
    // T3 — scoped fix agent (mock): mark fixed, return the re-run review.
    'review-fix-finding': (a) => { const f = devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'fixed'; return { ok: !!f, findingId: a.id, files: 2, run: devReview }; },
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
    // T6 — GitHub CI/CD mocks (browser preview; real gh runs in the host).
    'git-pr-list': () => ({ prs: [
      { number: 630, title: 'feat(desktop): Onyx-style Models panel with key-driven multi-select model fetch', state: 'OPEN', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/630', headRefName: 'feat/models-onyx-providers', baseRefName: 'release/0.4.16', isDraft: false, author: { login: 'luannn010' }, updatedAt: '2026-06-26T14:40:00Z', body: '## What & why\nRedesigns the Desktop Models settings panel to mimic Onyx and makes model setup key-driven.\n\n- LLMConfig gains optional models[] and apiVersion\n- New provider modules: anthropic, gemini, openrouter, zenmux, groq, azure' },
      { number: 552, title: 'BrainRouter Mobile — Phase 1-2 planning, design system & prototypes', state: 'OPEN', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/552', headRefName: 'brainrouter-mobile', baseRefName: 'main', isDraft: true, author: { login: 'luannn010' }, updatedAt: '2026-06-22T12:02:00Z', body: 'Phase 1-2 planning, a shared design system, and clickable prototypes for the BrainRouter mobile app.' },
      { number: 517, title: 'feat(desktop): native cross-platform installers (DESK-6 packaging)', state: 'OPEN', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/517', headRefName: 'feat/desktop-packaging', baseRefName: 'release/0.4.16', isDraft: false, author: { login: 'luannn010' }, updatedAt: '2026-06-21T14:28:00Z', body: 'Native cross-platform installers (mac/win/linux) via electron-builder.' },
      { number: 513, title: 'docs(spec): typed extension API + audited self-update brief', state: 'OPEN', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/513', headRefName: 'docs/typed-extension-api-spec', baseRefName: 'main', isDraft: false, author: { login: 'anhdang' }, updatedAt: '2026-06-21T10:19:00Z', body: 'Spec for a typed extension API and an audited self-update mechanism.' },
    ] }),
    'git-pr-detail': () => ({ pr: { number: 446, state: 'OPEN', title: 'feat(desktop): in-app Monaco code editor', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/446', headRefName: 'feat/0.4.15-monaco-editor', baseRefName: 'release/0.4.15', isDraft: false, mergeable: 'MERGEABLE', author: { login: 'anhdang' } } }),
    'git-pr-checks': () => ({ checks: [
      { name: 'Build & Test (Node 22.x)', bucket: 'pass', workflow: 'CI', link: 'https://github.com/kinqsradiollc/BrainRouter/actions/runs/1', startedAt: '2026-06-17T10:00:00Z', completedAt: '2026-06-17T10:03:06Z' },
      { name: 'Lint', bucket: 'pass', workflow: 'CI', startedAt: '2026-06-17T10:00:00Z', completedAt: '2026-06-17T10:00:42Z' },
      { name: 'e2e (flaky)', bucket: 'pending', workflow: 'CI' },
    ] }),
    'git-actions-runs': () => ({ runs: [
      { databaseId: 27667328723, name: 'CI', displayTitle: 'in-app Monaco code editor', status: 'completed', conclusion: 'success', workflowName: 'Build & Test', headBranch: 'feat/0.4.15-monaco-editor', event: 'pull_request', createdAt: '2026-06-17T10:00:00Z', url: 'https://github.com/kinqsradiollc/BrainRouter/actions/runs/1' },
      { databaseId: 27666466918, name: 'CI', displayTitle: 'host backend endpoints', status: 'completed', conclusion: 'failure', workflowName: 'Build & Test', headBranch: 'feat/0.4.15-host-backend-endpoints', event: 'pull_request', createdAt: '2026-06-17T09:30:00Z', url: 'https://github.com/kinqsradiollc/BrainRouter/actions/runs/2' },
      { databaseId: 99, name: 'CI', displayTitle: 'release sweep', status: 'in_progress', workflowName: 'Build & Test', headBranch: 'release/0.4.15', event: 'push', createdAt: '2026-06-17T11:00:00Z', url: 'https://github.com/kinqsradiollc/BrainRouter/actions/runs/3' },
    ] }),
    'git-actions-run-detail': (a) => ({ run: { databaseId: Number(a.id) || 1, name: 'CI', displayTitle: 'run detail', status: 'completed', conclusion: 'failure', workflowName: 'Build & Test', updatedAt: '2026-06-17T10:03:06Z', jobs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure' }] } }),
    'git-actions-run-log': (a) => ({ log: `run ${a.id} — Build & Test\n> npm test\nFAIL src/foo.test.ts\n  ✗ does the thing\n    Expected: 1\n    Received: 2\nProcess completed with exit code 1.` }),
    'action:git-actions-rerun-failed': (a) => ({ ok: true, id: String(a.id ?? '') }),
    // DESK-5w — each task tagged with the chat that owns it, so the sidebar can
    // nest it under its session and the env card scopes to the viewed chat.
    'fleet': () => [
      // §1/§2 — durable background tasks (plan revision + review) show their
      // status/phase/elapsed in the Background panel and are clickable to open
      // the task transcript.
      { kind: 'plan-revision', id: 'btask_a1', label: 'Revise plan — requested changes', durable: true, status: 'running', phase: 'writing-plan', startedAt: new Date(Date.now() - 22_000).toISOString(), parentSessionKey: 'dev:fix-recall-blend', transcript: { kind: 'task', id: 'btask_a1', parentSessionKey: 'internal:plan-revision:btask_a1' } },
      { kind: 'review', id: 'btask_b2', label: 'Review working changes', durable: true, status: 'running', phase: 'analyzing', startedAt: new Date(Date.now() - 6_000).toISOString(), parentSessionKey: 'dev:fix-recall-blend', transcript: { kind: 'task', id: 'btask_b2', parentSessionKey: 'review:btask_b2' } },
      // verification — a build/test/typecheck the current turn kicked off; runs in
      // THIS workspace and keeps going (+ stays visible) even if you switch away.
      { kind: 'verification', id: 'btask_v3', label: 'Verify — npm test', durable: true, status: 'running', phase: 'running', startedAt: new Date(Date.now() - 11_000).toISOString(), parentSessionKey: 'dev:fix-recall-blend', transcript: { kind: 'task', id: 'btask_v3', parentSessionKey: 'internal:verify:btask_v3' } },
      { kind: 'agent', id: 'agent-3f2a', label: 'explorer·3f2a — survey recall pipeline', role: 'explorer', startedAt: new Date(Date.now() - 95_000).toISOString(), worktree: false, parentSessionKey: 'dev:fix-recall-blend' },
      { kind: 'worker', id: 'wkr-91', label: 'wkr-91 · vitest suite', role: 'worker', startedAt: new Date(Date.now() - 14 * 60_000).toISOString(), worktree: true, parentSessionKey: 'dev:fix-recall-blend' },
      { kind: 'workflow', id: 'wf-build', label: 'build · Implement (2/4)', startedAt: new Date(Date.now() - 31 * 60_000).toISOString(), parentSessionKey: 'dev:grid-tui' },
      // WS2 2.4 — a background shell (dev server) with a Stop control; killing it drops it from the fleet.
      ...(devShellAlive ? [{ kind: 'shell', id: 'bgsh_devsrv', label: 'npm run dev — http://localhost:5173', startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), parentSessionKey: 'dev:fix-recall-blend' }] : []),
    ],
    'action:kill-bgshell': (a) => { if (String(a.id ?? '') === 'bgsh_devsrv') devShellAlive = false; return { ok: true }; },
    // §3 — durable task list (scoped). Mirrors the host's tasks-list shape.
    'tasks-list': () => [
      { id: 'btask_a1', kind: 'plan-revision', status: 'running', title: 'Revise plan — requested changes', phase: 'writing-plan', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 22_000).toISOString(), startedAt: new Date(Date.now() - 22_000).toISOString(), updatedAt: new Date().toISOString(), progress: [], linkedMemoryIds: [] },
      // recently-finished verification runs — completed + failed, for the panel's "Recently finished" section
      { id: 'btask_v7', kind: 'verification', status: 'completed', title: 'Verify — npm run typecheck', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), completedAt: new Date(Date.now() - 4 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(), progress: [], linkedMemoryIds: [], transcript: { kind: 'task', id: 'btask_v7', parentSessionKey: 'internal:verify:btask_v7' } },
      { id: 'btask_v8', kind: 'verification', status: 'failed', title: 'Verify — npm test', error: '2 tests failed', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 9 * 60_000).toISOString(), startedAt: new Date(Date.now() - 9 * 60_000).toISOString(), completedAt: new Date(Date.now() - 8 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 8 * 60_000).toISOString(), progress: [], linkedMemoryIds: [], transcript: { kind: 'task', id: 'btask_v8', parentSessionKey: 'internal:verify:btask_v8' } },
    ],
    'attachment-ingest': (a) => {
      const name = String(a.name || a.path || 'file').split('/').pop() || 'file';
      const kind = attachmentKind(name);
      const dataBase64 = typeof a.dataBase64 === 'string' ? a.dataBase64 : '';
      const rec: DevAttachment = {
        id: `att_dev${devAttachmentSeq++}`,
        name,
        kind,
        mimeType: attachmentMime(name, kind),
        byteSize: dataBase64 ? Math.floor((dataBase64.length * 3) / 4) : 0,
        extractedText: decodePreview(dataBase64, kind),
        workspaceRoot: wsCurrent,
        sessionKey: activeSession,
        createdAt: new Date().toISOString(),
      };
      devAttachments.set(rec.id, rec);
      return { ok: true, attachment: rec, contextMarkdown: attachmentContext(rec) };
    },
    'attachment-list': () => [...devAttachments.values()].filter((a) => a.workspaceRoot === wsCurrent && a.sessionKey === activeSession),
    'attachment-read': (a) => devAttachments.get(String(a.id ?? '')) ?? null,
    'attachment-context': (a) => {
      const rec = devAttachments.get(String(a.id ?? ''));
      return rec ? { id: rec.id, name: rec.name, markdown: attachmentContext(rec) } : null;
    },
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
      if (kind === 'task') {
        // durable task (verification / plan-revision / review) — show its result.
        const failed = id === 'btask_v8';
        return {
          id, kind, role: 'verification', status: failed ? 'failed' : (id.startsWith('btask_v') ? 'completed' : 'running'),
          goal: 'Verify — npm test',
          rows: [
            { kind: 'user', text: '$ npm test' },
            { kind: 'assistant', text: failed ? '✗ failed\n\n# tests 1387\n# pass 1385\n# fail 2' : '✓ passed\n\n# tests 1387\n# pass 1387\n# fail 0' },
          ],
        };
      }
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
    'session-info': () => ({ sessionKey: 'dev:demo', model: resolvedModel(activeSession), workspaceRoot: wsCurrent, username: 'anhdang' }),
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
      { status: 'M', path: 'src/checkout/orchestrator.ts' },
      { status: 'M', path: 'src/payment/payment.ts' },
      { status: 'A', path: 'src/payment/validate.ts' },
      { status: 'M', path: 'src/cart/cartStore.ts' },
      { status: '??', path: 'src/catalog/search.ts' },
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
    'git-info': () => ({
      repo: 'BrainRouter', branch: 'release/0.4.15', files: 4, insertions: 7670, deletions: 112,
      // T4 — demo a SUBDIR workspace so the env panel's "Git repo" row shows.
      workspaceRoot: wsCurrent, gitRoot: '/Users/dev/BrainRouter', repoRelativePath: 'brainrouter-desktop', isSubdir: true,
    }),
    'git-log': () => ({ subjects: ['feat(desktop): DESK-4l — interactive views rail, tabbed bottom terminal', 'feat(desktop): DESK-4k — modern skin', 'feat(desktop): DESK-5c — file tree, real terminal'] }),
    // Models a 128k-window model with a 256k auto-compact knob (knob > window) —
    // the renderer clamps compactAt down to the window so the two bars share a max.
    'context-usage': () => ({ used: devCtxUsed, window: 128_000, compactAt: 256_000, limit: 256_000, pct: Math.min(1, devCtxUsed / 256_000) }),
    // End-of-turn changeset — echo the turn's edited paths with plausible per-file
    // +/- so the transcript's "Edited N files" card is exercisable in preview.
    'turn-changeset': (a) => {
      const paths = Array.isArray((a as { paths?: unknown }).paths) ? ((a as { paths: unknown[] }).paths).filter((p): p is string => typeof p === 'string') : [];
      const adds = [37, 172, 22, 61, 14, 8]; const dels = [4, 0, 0, 5, 2, 0];
      const files = paths.map((p, i) => ({ path: p, status: /new|hooks|use[A-Z]/.test(p) ? 'A' : 'M', added: adds[i % adds.length], removed: dels[i % dels.length] }));
      return { files, insertions: files.reduce((s, f) => s + f.added, 0), deletions: files.reduce((s, f) => s + f.removed, 0) };
    },
    'plan-state': () => ({ items: devPlanState.items, explanation: devPlanState.explanation }),
    'action:ext-set-enabled': (a) => { const it = devExtensions.items.find((e) => e.name === a.name); if (it) it.enabled = a.enabled === true; return { ok: true, name: String(a.name ?? '') }; },
    'action:trust-workspace': (a) => { devExtensions.trusted = a.trusted === true; devExtensions.items.forEach((e) => { e.blocked = e.source === 'workspace' && !devExtensions.trusted; }); return { ok: true, trusted: devExtensions.trusted }; },
    'goal-state': () => ({ text: 'Implement a full-featured Notion clone with a block-based editor and hierarchical pages', status: 'active', budget: { maxIterations: 10, iterationsUsed: 3 }, startedAt: new Date(Date.now() - 18 * 60_000).toISOString(), updatedAt: new Date().toISOString() }),
    'action:goal-edit': (a) => ({ ok: true, goal: { text: String(a.text ?? ''), status: 'active', budget: { maxIterations: 10, iterationsUsed: 3 }, startedAt: new Date(Date.now() - 18 * 60_000).toISOString(), updatedAt: new Date().toISOString() } }),
    // TRACK mode — the mock board persists create/transition so the preview is interactive.
    'track-project': () => devTrack.project,
    'track-items': () => [...devTrack.items],
    'track-create': (a) => {
      const status = String(a.status ?? 'todo');
      devTrack.items.unshift(mkItem(`BR-${devTrackN++}`, String(a.type ?? 'task'), String(a.title ?? 'Untitled'), status, 'medium'));
      return [...devTrack.items];
    },
    'track-transition': (a) => {
      const it = devTrack.items.find((w) => w.key === a.idOrKey || w.id === a.idOrKey);
      if (it) { it.status = String(a.toStatus); it.statusCategory = trackCat(String(a.toStatus)); }
      return [...devTrack.items];
    },
    'track-update-item': (a) => {
      const it = devFindItem(a.idOrKey);
      const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {}) as Record<string, unknown>;
      if (it) {
        for (const [k, v] of Object.entries(patch)) {
          (it as Record<string, unknown>)[k] = v;
          if (k === 'status') it.statusCategory = trackCat(String(v));
          it.activity = [...(Array.isArray(it.activity) ? it.activity : []), { at: new Date().toISOString(), actor: 'user', field: k, to: v == null ? undefined : String(v) }];
        }
      }
      return [...devTrack.items];
    },
    'track-comment': (a) => {
      const it = devFindItem(a.idOrKey);
      if (it) it.comments = [...(Array.isArray(it.comments) ? it.comments : []), { id: `cmt_${devTrackN++}`, author: 'anhdang', body: String(a.body ?? ''), createdAt: new Date().toISOString() }];
      return [...devTrack.items];
    },
    'track-link': (a) => {
      const it = devFindItem(a.idOrKey);
      if (it) {
        if (Array.isArray(a.codeLinks)) it.codeLinks = [...(Array.isArray(it.codeLinks) ? it.codeLinks : []), ...a.codeLinks];
        if (Array.isArray(a.linkedMemoryIds)) it.linkedMemoryIds = [...new Set([...(Array.isArray(it.linkedMemoryIds) ? it.linkedMemoryIds : []), ...a.linkedMemoryIds])];
        if (typeof a.blocks === 'string') it.links = [...(Array.isArray(it.links) ? it.links : []), { type: 'blocks', targetId: a.blocks }];
      }
      return [...devTrack.items];
    },
    'track-assign-sprint': (a) => {
      const it = devFindItem(a.idOrKey);
      if (it) it.sprintId = a.sprintId ? String(a.sprintId) : undefined;
      return [...devTrack.items];
    },
    'track-sprints': () => [...devSprints],
    'track-create-sprint': (a) => {
      devSprints.push({ id: `sp_${devSprintN++}`, workspaceRoot: wsCurrent, name: String(a.name ?? 'Sprint'), goal: a.goal ? String(a.goal) : undefined, state: 'future', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return [...devSprints];
    },
    'track-sprint-state': (a) => {
      const sp = devSprints.find((s) => s.id === a.id);
      if (sp) sp.state = String(a.state ?? 'future');
      return [...devSprints];
    },
    'track-modules': () => [...devModules],
    'track-create-module': (a) => {
      devModules.unshift({ id: `mod_${devModuleN++}`, workspaceRoot: wsCurrent, name: String(a.name ?? 'Module'), description: a.description ? String(a.description) : undefined, status: 'planned', members: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return [...devModules];
    },
    'track-module-update': (a) => {
      const m = devModules.find((x) => x.id === a.id);
      if (m && a.patch && typeof a.patch === 'object') Object.assign(m, a.patch);
      return [...devModules];
    },
    'track-module-delete': (a) => {
      const i = devModules.findIndex((x) => x.id === a.id);
      if (i >= 0) devModules.splice(i, 1);
      for (const it of devTrack.items) if (it.moduleId === a.id) it.moduleId = undefined;
      return [...devModules];
    },
    'track-assign-module': (a) => {
      const it = devFindItem(a.idOrKey);
      if (it) it.moduleId = a.moduleId ? String(a.moduleId) : undefined;
      return [...devTrack.items];
    },
    'track-views': () => [...devViews],
    'track-save-view': (a) => {
      const input = (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>;
      const name = String(input.name ?? '').trim();
      if (name) {
        const existing = devViews.find((v) => String(v.name).toLowerCase() === name.toLowerCase());
        const rec = { id: existing?.id ?? `view_${devViewN++}`, workspaceRoot: wsCurrent, name, layout: input.layout ?? 'board', query: input.query || undefined, filters: input.filters || undefined, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, rec); else devViews.push(rec);
      }
      return [...devViews];
    },
    'track-delete-view': (a) => { const i = devViews.findIndex((v) => v.id === a.id); if (i >= 0) devViews.splice(i, 1); return [...devViews]; },
    'track-automations': () => [...devAutomations],
    'track-create-automation': (a) => {
      devAutomations.push({ id: `auto_${devAutoN++}`, name: String(a.name ?? 'Rule'), enabled: true, trigger: String(a.trigger ?? 'created'), condition: a.condition ? String(a.condition) : undefined, actions: Array.isArray(a.actions) ? a.actions : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return [...devAutomations];
    },
    'track-update-automation': (a) => {
      const r = devAutomations.find((x) => x.id === a.id);
      if (r && a.patch && typeof a.patch === 'object') Object.assign(r, a.patch);
      return [...devAutomations];
    },
    'track-delete-automation': (a) => {
      const i = devAutomations.findIndex((x) => x.id === a.id);
      if (i >= 0) devAutomations.splice(i, 1);
      return [...devAutomations];
    },
    'track-members': () => [...(devTrack.project.members as Record<string, unknown>[])],
    'track-add-member': (a) => {
      const members = devTrack.project.members as Record<string, unknown>[];
      const ex = members.find((m) => m.id === a.id);
      if (ex) { ex.role = a.role ?? 'member'; if (a.name !== undefined) ex.name = a.name; }
      else members.push({ id: String(a.id ?? ''), name: a.name, role: a.role ?? 'member', addedAt: new Date().toISOString() });
      return [...members];
    },
    'track-update-member-role': (a) => {
      const members = devTrack.project.members as Record<string, unknown>[];
      const m = members.find((x) => x.id === a.id);
      if (m) m.role = a.role ?? m.role;
      return [...members];
    },
    'track-remove-member': (a) => {
      const members = devTrack.project.members as Record<string, unknown>[];
      const i = members.findIndex((x) => x.id === a.id);
      if (i >= 0) members.splice(i, 1);
      return [...members];
    },
    'track-git-context': () => ({
      ok: true,
      hasGit: true,
      root: wsCurrent,
      currentBranch: 'release/0.4.15',
      remotes: [{ name: 'origin', url: 'git@github.com:kinqsradiollc/BrainRouter.git', githubRepo: 'kinqsradiollc/BrainRouter' }],
      githubRepo: 'kinqsradiollc/BrainRouter',
    }),
    'track-start-work': (a) => {
      const it = devFindItem(a.idOrKey);
      const slug = String(it?.title ?? 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'work';
      const branch = `track/${String(it?.key ?? 'br-0').toLowerCase()}-${slug}`;
      if (it) {
        const links = Array.isArray(it.codeLinks) ? it.codeLinks : [];
        if (!links.some((l) => l && typeof l === 'object' && (l as { kind?: string; ref?: string }).kind === 'branch' && (l as { ref?: string }).ref === branch)) {
          it.codeLinks = [...links, { kind: 'branch', ref: branch, label: 'kinqsradiollc/BrainRouter' }];
        }
        if (it.statusCategory === 'backlog' || it.statusCategory === 'unstarted') { it.status = 'in-progress'; it.statusCategory = 'started'; }
      }
      return {
        ok: !!it,
        branch,
        created: true,
        switched: true,
        context: {
          ok: true,
          hasGit: true,
          root: wsCurrent,
          currentBranch: branch,
          remotes: [{ name: 'origin', url: 'git@github.com:kinqsradiollc/BrainRouter.git', githubRepo: 'kinqsradiollc/BrainRouter' }],
          githubRepo: 'kinqsradiollc/BrainRouter',
        },
        items: [...devTrack.items],
        error: it ? undefined : `Unknown work item "${String(a.idOrKey ?? '')}".`,
      };
    },
    'track-pr-status': () => ({
      pr: {
        number: 42,
        state: 'OPEN',
        title: 'BR-3: Streaming retry fix',
        url: 'https://github.com/kinqsradiollc/BrainRouter/pull/42',
        headRefName: 'track/br-3-streaming-retry-fix',
        baseRefName: 'main',
        isDraft: false,
        mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { name: 'Build & Test', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'e2e', status: 'IN_PROGRESS' },
        ],
      },
      branch: 'track/br-3-streaming-retry-fix',
      itemKey: 'BR-3',
    }),
    'track-create-pr': (a) => {
      const it = devFindItem(a.idOrKey);
      const url = `https://github.com/kinqsradiollc/BrainRouter/pull/${42 + devTrackN++}`;
      if (it) {
        const links = Array.isArray(it.codeLinks) ? it.codeLinks : [];
        if (!links.some((l) => l && typeof l === 'object' && (l as { kind?: string; ref?: string }).kind === 'pull-request' && (l as { ref?: string }).ref === url)) {
          it.codeLinks = [...links, { kind: 'pull-request', ref: url, label: 'GitHub PR' }];
        }
      }
      return {
        ok: !!it,
        url,
        pr: it ? { number: Number(url.split('/').pop()), state: 'OPEN', title: `${String(it.key)}: ${String(it.title)}`, url, isDraft: true, mergeable: 'UNKNOWN', statusCheckRollup: [] } : null,
        branch: 'track/br-3-streaming-retry-fix',
        itemKey: it?.key,
        items: [...devTrack.items],
        error: it ? undefined : `Unknown work item "${String(a.idOrKey ?? '')}".`,
      };
    },
    'track-merge-pr': () => {
      const it = devFindItem('BR-3');
      if (it) { it.status = 'done'; it.statusCategory = 'completed'; }
      return { ok: true, pr: null, branch: 'track/br-3-streaming-retry-fix', itemKey: 'BR-3', items: [...devTrack.items] };
    },
    'track-submit-pr-review': () => ({ ok: true, pr: { number: 42, state: 'OPEN', title: 'BR-3: Streaming retry fix', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/42', headRefName: 'track/br-3-streaming-retry-fix', baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] }, branch: 'track/br-3-streaming-retry-fix', itemKey: 'BR-3' }),
    'track-fix-failing-checks': () => ({ ok: true, task: { id: 'btask_fix_ci' }, pr: { number: 42, state: 'OPEN', title: 'BR-3: Streaming retry fix', url: 'https://github.com/kinqsradiollc/BrainRouter/pull/42', headRefName: 'track/br-3-streaming-retry-fix', baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] }, branch: 'track/br-3-streaming-retry-fix', itemKey: 'BR-3' }),
    'track-sync-config': () => ({ ...devGithub }),
    'track-scan-commits': () => ({ scanned: 12, linked: [{ sha: 'abc1234', key: 'BR-3', workItemKey: 'BR-3' }], transitioned: [{ key: 'BR-3', from: 'todo', to: 'in-progress' }], items: [...devTrack.items] }),
    'track-sync-members': (a) => {
      const members = devTrack.project.members as Record<string, unknown>[];
      const incoming = [
        { id: 'octocat', name: 'The Octocat', role: 'admin' },
        { id: 'kinqsradio', name: 'Kinqs Radio', role: 'admin' },
      ];
      const added: string[] = [];
      for (const c of incoming) {
        if (members.find((m) => m.id === c.id)) continue;
        added.push(c.id);
        if (a.dryRun !== true) members.push({ ...c, addedAt: new Date().toISOString() });
      }
      return { members: [...members], added, errors: [] };
    },
    'track-gh-issues-import': () => {
      const existing = devTrack.items.find((w) => w.key === 'BR-99');
      if (!existing) devTrack.items.unshift(mkItem('BR-99', 'bug', 'Imported GitHub issue via gh', 'todo', 'high'));
      return {
        direction: 'import',
        dryRun: false,
        imported: [{ issueNumber: 99, title: 'Imported GitHub issue via gh', action: existing ? 'update' : 'create', key: 'BR-99' }],
        errors: [],
        items: [...devTrack.items],
      };
    },
    'track-sync': (a) => {
      const dir = a.direction === 'export' ? 'export' : a.direction === 'sync' ? 'sync' : 'import';
      if (dir === 'sync') {
        const first = (devTrack.items as Record<string, unknown>[])[0];
        return {
          direction: 'sync', dryRun: a.dryRun !== false,
          pushed: 2, pulled: 1, created: { local: 1, remote: 1 },
          conflicts: first ? [{ key: String(first.key), field: 'title' }] : [],
          errors: [],
        };
      }
      const rows = (devTrack.items as Record<string, unknown>[]).slice(0, 5).map((w, i) => (
        dir === 'export'
          ? { key: w.key, title: w.title, action: i % 2 === 0 ? 'create' : 'update' }
          : { issueNumber: 100 + i, title: w.title, action: i % 2 === 0 ? 'update' : 'create', key: w.key }
      ));
      return dir === 'export'
        ? { direction: 'export', dryRun: a.dryRun !== false, exported: rows, errors: [] }
        : { direction: 'import', dryRun: a.dryRun !== false, imported: rows, errors: [] };
    },
    // §7 PLAN REVIEW — history + record-decision (mutates the in-memory log so the panel updates live).
    'plan-history': () => [...devPlanDecisions],
    'plan-record-decision': (a) => {
      const verdict = a.verdict === 'approved' || a.verdict === 'changes-requested' ? a.verdict : null;
      if (!verdict) return { error: `Unknown plan verdict "${String(a.verdict)}".` };
      const feedback = typeof a.feedback === 'string' ? a.feedback.trim() : '';
      if (verdict === 'changes-requested' && !feedback) return { error: 'Requesting changes needs feedback to return to the session.' };
      if (devPlanState.items.length === 0) return { error: 'There is no plan to review in this session yet.' };
      const decision: DevPlanDecision = { id: `pdec_${devPlanSeq++}`, verdict, planSnapshot: devPlanState.items.map((i) => ({ ...i })), explanation: devPlanState.explanation, createdAt: new Date().toISOString(), linkedMemoryIds: [] };
      if (feedback) decision.feedback = feedback;
      devPlanDecisions.push(decision);
      return { ok: true, decision };
    },
    'git-branches': () => ({ current: 'release/0.4.15', branches: ['release/0.4.15', 'main', 'feat/desk-4j-reference-patterns', 'release/0.4.14'] }),
    // Dev-only mock of an endpoint's GET /models. Echoes `provider` so the
    // settings' per-provider model pickers can be exercised in the preview.
    'list-models': (a) => a?.provider
      ? ({ current: '', provider: String(a.provider), models: [`${a.provider}-fast`, `${a.provider}-pro`, `${a.provider}-reasoning`] })
      : ({ current: resolvedModel(activeSession), models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-5.5', 'gpt-5.3-codex', 'qwen3-coder-32b', 'deepseek-v4', 'glm-5-air', 'text-embedding-nomic-embed-text-v1.5', 'whisper-large-v3'] }),
    // §multi-select-models — dev mock of a draft-key /models probe. No real
    // network: a blank key + blank endpoint unlocks nothing (exercises the
    // "no models" empty state); otherwise returns a per-provider model set so the
    // dialog's checkbox list + count badge can be driven in the preview.
    'list-models-probe': async (a) => {
      // Browser dev-preview: pull the ACTUAL models the key unlocks — never a
      // canned list. Most gateways send NO CORS headers (ZenMux, OpenAI, …), so a
      // direct browser fetch is blocked; we go through the vite dev proxy
      // (/__brp/models, see vite.config.ts) which fetches server-side with no CORS
      // — exactly like the Electron app's host. Falls back to a direct fetch for
      // CORS-friendly endpoints or a production preview without the proxy.
      const provider = String(a?.provider ?? '') || null;
      const endpoint = String(a?.endpoint ?? '').trim();
      const apiKey = String(a?.apiKey ?? '');
      const apiVersion = String(a?.apiVersion ?? '').trim();
      if (!endpoint) return { models: [], count: 0, provider, probe: true };
      // 1) vite dev proxy (server-side fetch, bypasses CORS).
      try {
        const pr = await fetch('/__brp/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, apiKey, apiVersion }) });
        if (pr.ok) {
          const j = (await pr.json()) as { models?: string[]; error?: string };
          const models = j.models ?? [];
          return { models, count: models.length, provider, probe: true, ...(j.error ? { error: j.error } : {}) };
        }
      } catch { /* proxy absent (prod preview) → direct fetch below */ }
      // 2) direct fetch fallback (CORS-permitting endpoints only).
      const base = endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') + '/models';
      const url = apiVersion ? base + (base.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(apiVersion) : base;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const res = await fetch(url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim() || 'local'}` }, signal: ctrl.signal });
        if (!res.ok) return { models: [], count: 0, provider, probe: true, error: `http-${res.status}` };
        const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
        const ids = [...new Set((Array.isArray(body.data) ? body.data : []).map((r) => (r && typeof r.id === 'string') ? r.id : '').filter(Boolean))].sort();
        return { models: ids, count: ids.length, provider, probe: true };
      } catch {
        return { models: [], count: 0, provider, probe: true, error: 'unreachable' };
      } finally {
        clearTimeout(timer);
      }
    },
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
    // T5 — editor backend (in-memory): read / stat / guarded save (stale-write).
    'file-read': (a) => devFileRead(String(a.path ?? 'src/memory/recall.ts')),
    'write-save': (a) => { const p = String(a.path ?? ''); const c = String(a.content ?? ''); if (devFiles[p]) { devFiles[p].content = c; } return { ok: true, path: p }; },
    'workflow-list': () => Object.values(devWorkflows).map((g) => ({ id: g.id, name: g.name || g.id, updatedAt: g.updatedAt || '' })),
    'workflow-save': (a) => { const g = (a.graph ?? {}) as Record<string, unknown>; const id = String(g.id || g.name || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'untitled'; const rec = { ...g, id, updatedAt: new Date().toISOString() }; devWorkflows[id] = rec; return { id, name: g.name || id, updatedAt: rec.updatedAt }; },
    'workflow-load': (a) => devWorkflows[String(a.id ?? '')] ?? null,
    'workflow-delete': (a) => { const id = String(a.id ?? ''); const had = !!devWorkflows[id]; delete devWorkflows[id]; return { ok: had }; },
    'memory-search': (a) => { const q = String(a.query ?? '').toLowerCase(); const all = [{ id: 'mem_recall_blend', type: 'project', source: 'memory_vector', score: 0.91, content: 'Recall blends reranker + RRF (0.6/0.4); never hard-drop candidates.' }, { id: 'mem_no_vendor_refs', type: 'feedback', source: 'memory_keyword', score: 0.79, content: 'No vendor/planning refs in committed code or docs.' }, { id: 'mem_session_scope', type: 'project', source: 'memory_keyword', score: 0.68, content: 'Artifacts/annotations are session-scoped on capture.' }]; return { records: q ? all.filter((r) => r.content.toLowerCase().includes(q) || r.type.includes(q)) : all, raw: '' }; },
    'write-inline-ai': (a) => { const action = String(a.action ?? 'polish'); const text = String(a.text ?? ''); if (!text.trim()) return { text: '', error: 'No text selected.' }; if (action === 'continue') return { text: text + (/\s$/.test(text) ? '' : ' ') + 'Moreover, this continuation is produced by the dev-bridge stub to exercise the inline assistant.' }; const polished = text.replace(/\bvery\s+/gi, '').replace(/\bgood\b/gi, 'excellent').replace(/\butilize\b/gi, 'use').replace(/[ \t]+/g, ' ').replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + (c as string).toUpperCase()).trim(); return { text: polished || text }; },
    'write-ghost-complete': (a) => { const prefix = String(a.prefix ?? ''); if (prefix.trim().length < 3) return { text: '' }; return { text: /\s$/.test(prefix) ? 'this continuation is from the dev-bridge stub.' : ' — continued by the dev-bridge stub.' }; },
    'write-assistant': (a) => { const q = String(a.question ?? '').trim(); if (!q) return { text: '', error: 'Ask a question.' }; return { text: `(dev-bridge) On "${q.slice(0, 60)}": ground your prose in README.md — keep the memory-first framing consistent and cite the source doc.`, grounded: true }; },
    'shortcuts-get': () => { try { return { overrides: JSON.parse(localStorage.getItem('br-dev-shortcuts') || '{}') }; } catch { return { overrides: { ...devShortcuts } }; } },
    'shortcuts-save': (a) => { const raw = (a.overrides && typeof a.overrides === 'object') ? a.overrides as Record<string, unknown> : {}; const clean: Record<string, string> = {}; for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v.trim()) clean[k] = v.trim(); try { localStorage.setItem('br-dev-shortcuts', JSON.stringify(clean)); } catch { /* ignore */ } return { ok: true, overrides: clean }; },
    'file-stat': (a) => { const p = String(a.path ?? ''); const f = devFiles[p]; return f ? { path: p, exists: true, kind: 'file', mtimeMs: f.mtimeMs, size: f.content.length } : { path: p, exists: false }; },
    'action:file-save': (a) => {
      const p = String(a.path ?? ''); const content = String(a.content ?? ''); const f = devFiles[p];
      if (!f) { devFiles[p] = { content, mtimeMs: 2_000 }; return { ok: true, path: p, mtimeMs: 2_000, size: content.length }; }
      if (typeof a.expectedMtimeMs === 'number' && a.expectedMtimeMs !== f.mtimeMs) return { ok: false, path: p, conflict: true, mtimeMs: f.mtimeMs };
      f.content = content; f.mtimeMs += 1; return { ok: true, path: p, mtimeMs: f.mtimeMs, size: content.length };
    },
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
      model: 'claude-opus-4-8', provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', fallbackModel: null,
      // Mock of config/providers.json — the main-provider picker source.
      providerCatalog: [
        { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', local: false },
        { id: 'anthropic', label: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1', local: false },
        { id: 'gemini', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', local: false },
        { id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', local: false },
        { id: 'zenmux', label: 'ZenMux', endpoint: 'https://zenmux.ai/api/v1', local: false },
        { id: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', local: false },
        { id: 'azure', label: 'Azure OpenAI', endpoint: '', local: false },
        { id: 'openai-compatible', label: 'OpenAI-compatible (custom)', endpoint: '', local: false },
        { id: 'opencode', label: 'opencode (Zen gateway)', endpoint: 'https://opencode.ai/zen/v1', local: false },
        { id: 'lmstudio', label: 'LM Studio (local)', endpoint: 'http://localhost:1234/v1', local: true },
        { id: 'ollama', label: 'Ollama (local)', endpoint: 'http://localhost:11434/v1', local: true },
      ],
      workspaceRoot: '/Users/dev/BrainRouter', sandbox: 'off', prefs: effectivePrefs(),
      cliKnobs: { ...devCliKnobs },
      extensions: { trusted: devExtensions.trusted, items: devExtensions.items.map((e) => ({ ...e })) },
      integrations: { github: { ...devGithub } },
      connectors: {
        catalog: devConnectorCatalog.map((entry) => ({ ...entry })),
        items: devConnectors.map((entry) => ({ ...entry, config: { ...entry.config }, credential: { ...entry.credential }, flows: [...entry.flows] })),
        documentCounts: Object.fromEntries(devConnectors.map((entry) => [entry.id, Number((entry.checkpoint as { documentCount?: number } | undefined)?.documentCount ?? 0)])),
        permissionCounts: Object.fromEntries(devConnectors.map((entry) => [entry.id, devConnectorPermissionCounts[entry.id] ?? 0])),
        runPreviews: Object.fromEntries(devConnectors.map((entry) => [entry.id, devConnectorRuns[entry.id] ?? []])),
        documentPreviews: Object.fromEntries(devConnectors.map((entry) => [entry.id, devSlimDocuments(entry.id, 3)])),
      },
      workspacePrefs: { ...prefs },
      sessionMode: { ...(sessionModes[activeSession] ?? {}) },
      modeScope: 'session',
      permissionRules: { allow: [...devRules.allow], deny: [...devRules.deny] },
      hooks: [
        { id: 'h1', event: 'pre-tool', command: './hooks/guard-prod.sh', enabled: true, match: 'run_command' },
        { id: 'h2', event: 'user-prompt-submit', command: './hooks/inject-ticket.sh', enabled: false },
      ],
      servers: devServers.map((s) => ({ ...s })),
      activeServer: devActiveServer, // WS9 — the single active brain
      // §multi-provider — named providers (mutable in dev) + per-role routing.
      providers: devProviders.map((p) => ({ ...p })),
      defaultProviderName: devDefaultProvider,
      defaultProviderModelMatches: true,
      agentModels: [
        { role: 'explorer', provider: 'groq', model: null },
        { role: 'reviewer', provider: null, model: 'gpt-5.3-codex' },
      ],
    }),
    'action:set-provider': (a) => {
      const name = String(a.name ?? '').trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return { ok: false, error: 'Provider name must be letters, digits, . _ - only.' };
      const models = Array.isArray(a.models) ? a.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : [];
      const model = String(a.model ?? '').trim() || models[0] || '';
      if (!model) return { ok: false, error: 'A model is required.' };
      const entry = { name, provider: String(a.provider ?? '').trim() || 'openai-compatible', model, endpoint: (String(a.endpoint ?? '').trim() || null), hasKey: !!String(a.apiKey ?? '').trim(), models, apiVersion: a.apiVersion ? String(a.apiVersion) : null };
      const i = devProviders.findIndex((p) => p.name === name);
      if (i >= 0) devProviders[i] = entry; else devProviders.push(entry);
      return { ok: true, name };
    },
    'action:remove-provider': (a) => {
      const name = String(a.name ?? '').trim();
      const i = devProviders.findIndex((p) => p.name === name);
      if (i >= 0) devProviders.splice(i, 1);
      if (devDefaultProvider === name) devDefaultProvider = null;
      return { ok: true, name };
    },
    'action:set-default-provider': (a) => {
      const name = String(a.name ?? '').trim();
      if (!devProviders.some((p) => p.name === name)) return { ok: false, error: `Unknown provider "${name}".` };
      devDefaultProvider = name;
      return { ok: true, name };
    },
    'action:set-agent-model': (a) => ({ ok: true, role: String(a.role ?? '') }),
    'usage-breakdown': () => [
      'parent      48,213 in · 1,904 out · cache hit 92%',
      'explorer·3f2a   12,408 in · 822 out',
      'worker·91        8,114 in · 1,201 out',
      'TOTAL       68,735 in · 3,927 out',
      'offload: 31% of parent context avoided via child agents',
    ],
    // WS10 — synthetic daily usage so the contributions heatmap renders in
    // browser-only dev (busier weekdays, ~20% idle days, a gentle wave). Honours
    // the `days` arg so the week/month/year range selector actually changes it.
    'usage-history': (a) => {
      const span = typeof a.days === 'number' && a.days > 0 ? Math.floor(a.days) : 365;
      const days: Array<{ day: string; promptTokens: number; completionTokens: number; calls: number; turns: number }> = [];
      const total = { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0 };
      const now = Date.now();
      for (let i = span - 1; i >= 0; i--) {
        const t = now - i * 86_400_000;
        const wd = new Date(t).getUTCDay();
        const weekendDamp = wd === 0 || wd === 6 ? 0.2 : 1;
        const wave = (Math.sin(i * 0.7) + 1) / 2; // 0..1
        const turns = (i * 37) % 5 === 0 ? 0 : Math.round(weekendDamp * wave * 8);
        const promptTokens = turns * (1200 + ((i * 53) % 900));
        const completionTokens = turns * (300 + ((i * 29) % 400));
        const calls = turns * (1 + ((i * 17) % 3));
        days.push({ day: new Date(t).toISOString().slice(0, 10), promptTokens, completionTokens, calls, turns });
        total.promptTokens += promptTokens;
        total.completionTokens += completionTokens;
        total.calls += calls;
        total.turns += turns;
      }
      return { days, total };
    },
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
    'action:set-cli-knob': (a) => { if (a.value === null) delete devCliKnobs[String(a.key)]; else devCliKnobs[String(a.key)] = a.value; return { ok: true, key: String(a.key) }; },
    'action:set-track-github': (a) => {
      if (typeof a.caBundle === 'string' || a.caBundle === null) devGithub.caBundle = typeof a.caBundle === 'string' ? (a.caBundle.trim() || null) : null;
      if (typeof a.removeRepo === 'string') {
        const repo = a.removeRepo.trim();
        devGithub.repos = devGithub.repos.filter((r) => r.repo !== repo);
        if (devGithub.repo === repo) devGithub.repo = devGithub.repos[0]?.repo ?? null;
      }
      if (typeof a.repo === 'string') {
        const repo = a.repo.trim();
        if (repo) {
          let row = devGithub.repos.find((r) => r.repo === repo);
          if (!row) { row = { repo, hasToken: false, tokenSource: null, active: false, source: 'track' }; devGithub.repos.push(row); }
          if (typeof a.token === 'string' && a.token.trim()) { row.hasToken = true; row.tokenSource = 'config'; }
          if (a.clearToken === true) { row.hasToken = false; row.tokenSource = null; }
          if (a.makeActive === true || !devGithub.repo) {
            devGithub.repos.forEach((r) => { r.active = r.repo === repo; });
            devGithub.repo = repo;
            devGithub.hasToken = row.hasToken;
            devGithub.tokenSource = row.tokenSource;
          }
        }
      }
      const active = devGithub.repos.find((r) => r.active) ?? devGithub.repos[0];
      if (active) {
        devGithub.repos.forEach((r) => { r.active = r.repo === active.repo; });
        devGithub.repo = active.repo;
        devGithub.hasToken = active.hasToken;
        devGithub.tokenSource = active.tokenSource;
      } else {
        devGithub.repo = null;
        devGithub.hasToken = false;
        devGithub.tokenSource = null;
      }
      return { ok: true, ...devGithub };
    },
    'connector-slim-documents': (a) => devSlimDocuments(typeof a.connectorId === 'string' ? a.connectorId : undefined, typeof a.limit === 'number' ? a.limit : 20),
    'action:connector-create': (a) => {
      const now = new Date().toISOString();
      const rec = {
        id: `conn_demo${devConnectors.length + 1}`,
        source: a.source === 'github' ? 'github' : 'github',
        name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'GitHub connector',
        status: 'active',
        config: a.config && typeof a.config === 'object' && !Array.isArray(a.config) ? a.config as never : {},
        credential: a.credential && typeof a.credential === 'object' && !Array.isArray(a.credential) ? a.credential as never : { mode: 'dynamic', ref: 'gh' },
        flows: Array.isArray(a.flows) ? a.flows as never : ['load', 'checkpoint', 'slim', 'permission-sync'],
        workspaceRoot: wsCurrent,
        createdAt: now,
        updatedAt: now,
      } as ConnectorRecord;
      devConnectors = [rec, ...devConnectors];
      return { ok: true, connector: rec };
    },
    'action:connector-update': (a) => {
      const id = String(a.id ?? '');
      const patch = a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch) ? a.patch as Partial<ConnectorRecord> : {};
      let updated: ConnectorRecord | null = null;
      devConnectors = devConnectors.map((rec) => {
        if (rec.id !== id) return rec;
        updated = { ...rec, ...patch, id: rec.id, source: rec.source, workspaceRoot: rec.workspaceRoot, createdAt: rec.createdAt, updatedAt: new Date().toISOString() };
        return updated;
      });
      return updated ? { ok: true, connector: updated } : { ok: false, error: 'Connector not found.' };
    },
    'action:connector-delete': (a) => {
      const id = String(a.id ?? '');
      const before = devConnectors.length;
      devConnectors = devConnectors.filter((rec) => rec.id !== id);
      return { ok: before !== devConnectors.length };
    },
    'action:connector-export-definitions': () => {
      const bundle = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        connectors: devConnectors.map((connector) => ({
          source: connector.source,
          name: connector.name,
          description: connector.description,
          config: { ...connector.config },
          credential: { ...connector.credential },
          flows: [...connector.flows],
        })),
      };
      return { ok: true, bundle, json: JSON.stringify(bundle, null, 2) };
    },
    'action:connector-import-definitions': (a) => {
      const raw = typeof a.json === 'string' ? a.json : '';
      if (!raw.trim()) return { ok: false, error: 'Connector definition JSON is required.' };
      try {
        const parsed = JSON.parse(raw) as { connectors?: Array<Partial<ConnectorRecord>> };
        const now = new Date().toISOString();
        const imported = (parsed.connectors ?? []).map((definition, index) => ({
          id: `conn_import_${Date.now()}_${index}`,
          source: definition.source === 'github' ? 'github' : 'github',
          name: typeof definition.name === 'string' && definition.name.trim() ? definition.name.trim() : 'Imported connector',
          description: typeof definition.description === 'string' ? definition.description : undefined,
          status: 'active',
          config: definition.config && typeof definition.config === 'object' ? { ...definition.config } : {},
          credential: definition.credential && typeof definition.credential === 'object' ? { ...definition.credential } : { mode: 'none' },
          flows: Array.isArray(definition.flows) ? definition.flows : ['checkpoint'],
          workspaceRoot: wsCurrent,
          createdAt: now,
          updatedAt: now,
        })) as ConnectorRecord[];
        devConnectors = [...imported, ...devConnectors];
        return { ok: true, connectors: imported };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    'action:connector-validate': (a) => {
      const id = String(a.id ?? '');
      let checked: string[] = [];
      let updated: ConnectorRecord | null = null;
      devConnectors = devConnectors.map((rec) => {
        if (rec.id !== id) return rec;
        const owner = typeof rec.config.owner === 'string' ? rec.config.owner : 'kinqsradiollc';
        const repos = Array.isArray(rec.config.repositories) ? rec.config.repositories.filter((repo): repo is string => typeof repo === 'string') : ['BrainRouter'];
        checked = repos.length ? repos.map((repo) => (repo.includes('/') ? repo : `${owner}/${repo}`)) : [`${owner}/BrainRouter`];
        updated = { ...rec, status: 'active', lastError: undefined, updatedAt: new Date().toISOString() };
        return updated;
      });
      return updated ? { ok: true, checked, errors: [], connector: updated } : { ok: false, checked: [], errors: ['Connector not found.'], connector: null };
    },
    'action:connector-run': (a) => {
      const id = String(a.id ?? '');
      const now = new Date().toISOString();
      const existing = devConnectors.find((rec) => rec.id === id);
      if (!existing) return { ok: false, error: 'Connector not found.', errors: ['Connector not found.'] };
      const runCheckpoint = { highWatermark: now, repositories: [] as unknown[], completedAt: now, documentCount: 3, failureCount: 0 };
      const connector: ConnectorRecord = { ...existing, status: 'active', lastRunAt: now, lastSuccessAt: now, lastError: undefined, checkpoint: runCheckpoint, updatedAt: now };
      devConnectors = devConnectors.map((rec) => {
        if (rec.id !== id) return rec;
        runCheckpoint.repositories = Array.isArray(rec.config.repositories) ? rec.config.repositories : [];
        return connector;
      });
      const run = { id: `crun_demo${Date.now()}`, connectorId: id, source: connector.source, flow: 'checkpoint', status: 'succeeded', startedAt: now, completedAt: now, documentsSeen: 3, documentsIndexed: 3, failures: 0 };
      devConnectorRuns[id] = [run, ...(devConnectorRuns[id] ?? [])].slice(0, 10);
      return {
        ok: true,
        connector,
        run: { ...run, checkpointAfter: runCheckpoint },
        documents: [
          { id: `${connector.source}:demo:issue:1`, connectorId: id, source: connector.source, kind: 'issue', repository: connector.source, title: 'Demo issue', text: 'Demo issue', metadata: { number: 1 } },
          { id: `${connector.source}:demo:file:README.md`, connectorId: id, source: connector.source, kind: 'file', repository: connector.source, title: 'README.md', text: '# Demo', metadata: { path: 'README.md' } },
        ],
        errors: [],
      };
    },
    'action:connector-index-memory': (a) => {
      const id = String(a.id ?? '');
      const connector = devConnectors.find((rec) => rec.id === id);
      if (!connector) return { ok: false, records: 0, evidence: 0, operations: 0, error: 'Connector not found.' };
      const records = devSlimDocuments(id, 200).length;
      return {
        ok: true,
        records,
        evidence: records,
        operations: records ? 1 : 0,
        result: { importedMemories: records, importedEvidence: records, importedOperations: records ? 1 : 0 },
      };
    },
    'action:connector-sync-permissions': (a) => {
      const id = String(a.id ?? '');
      const now = new Date().toISOString();
      let updated: ConnectorRecord | null = null;
      devConnectors = devConnectors.map((rec) => {
        if (rec.id !== id) return rec;
        devConnectorPermissionCounts[id] = 2;
        updated = { ...rec, status: 'active', lastRunAt: now, lastSuccessAt: now, lastError: undefined, checkpoint: { ...(rec.checkpoint ?? {}), permissionSyncedAt: now, permissionCount: 2 }, updatedAt: now };
        return updated;
      });
      if (!updated) return { ok: false, error: 'Connector not found.', errors: ['Connector not found.'] };
      const run = { id: `crun_perm_demo${Date.now()}`, connectorId: id, source: 'github', flow: 'permission-sync', status: 'succeeded', startedAt: now, completedAt: now, permissionsSeen: 2, permissionsIndexed: 2, failures: 0 };
      devConnectorRuns[id] = [run, ...(devConnectorRuns[id] ?? [])].slice(0, 10);
      return {
        ok: true,
        connector: updated,
        run,
        permissions: [
          { id: 'github:demo:user:octo', connectorId: id, source: 'github', principalId: 'octo', principalKind: 'user', role: 'admin', repositories: ['kinqsradiollc/BrainRouter'], metadata: {} },
          { id: 'github:demo:user:dev', connectorId: id, source: 'github', principalId: 'dev', principalKind: 'user', role: 'write', repositories: ['kinqsradiollc/BrainRouter'], metadata: {} },
        ],
        errors: [],
      };
    },
    'action:set-session-mode': (a) => {
      const next = { ...(sessionModes[activeSession] ?? {}) };
      for (const key of ['executionMode', 'reviewPolicy', 'effort']) {
        if (key in a) {
          if (a[key] == null || a[key] === '') delete next[key];
          else next[key] = a[key];
        }
      }
      if (Object.keys(next).length === 0) delete sessionModes[activeSession];
      else sessionModes[activeSession] = next;
      return { ok: true, sessionKey: activeSession, sessionMode: { ...(sessionModes[activeSession] ?? {}) }, activeMode: effectivePrefs() };
    },
    'action:set-hook': () => ({ ok: true }),
    'action:set-access': (a) => ({ ok: true, mode: a.mode }),
    'action:reconnect-mcp': () => ({ ok: true }),
    'action:set-active-server': (a) => { const id = String(a.id ?? ''); if (devServers.some((s) => s.id === id && s.identity === 'brainrouter')) devActiveServer = id; return { ok: true, id }; },
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
    'action:allow-rule': (a) => { const r = String(a.rule ?? '').trim(); if (r && !devRules.allow.includes(r)) devRules.allow.push(r); return { ok: true, rule: r }; },
    'action:rule-edit': (a) => {
      const kind = a.kind === 'deny' ? 'deny' : 'allow'; const op = a.op === 'remove' ? 'remove' : 'add'; const r = String(a.rule ?? '').trim();
      const list = devRules[kind];
      if (op === 'add') { if (r && !list.includes(r)) list.push(r); } else { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); }
      return { ok: true, permissions: { allow: [...devRules.allow], deny: [...devRules.deny] } };
    },
    'action:add-mcp': (a) => { const id = String(a.id ?? '').trim(); if (!id || devServers.some((s) => s.id === id)) return { ok: false, error: 'invalid or duplicate id' }; const http = a.type === 'http'; devServers.push({ id, online: true, identity: 'third-party', type: http ? 'http' : 'stdio', url: http ? String(a.url ?? '') : null, command: http ? null : String(a.command ?? ''), detail: `${a.type ?? 'stdio'}` }); return { ok: true, id }; },
    'action:remove-mcp': (a) => { const i = devServers.findIndex((s) => s.id === a.id); if (i >= 0) devServers.splice(i, 1); return { ok: i >= 0, id: a.id }; },
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
          if (handler) {
            // Await async handlers (e.g. list-models-probe now does a REAL fetch)
            // so the renderer receives the resolved value, never a pending Promise.
            // Sync handlers resolve on the next microtask — behavior unchanged.
            Promise.resolve(handler(command.args ?? {}))
              .then((result) => emit({ kind: 'query-result', id: command.id, ok: true, result }, 30))
              .catch((e) => emit({ kind: 'query-result', id: command.id, ok: false, error: String((e as Error)?.message ?? e) }, 30));
          } else emit({ kind: 'query-result', id: command.id, ok: false, error: `Unknown query "${command.name}" (dev bridge)` }, 30);
          return;
        }
        case 'start-turn': {
          // DESK-5v — capture the session this turn belongs to. The user may
          // switch away while it runs; every event below stays tagged with THIS
          // key so it lands in the right chat, never the one now on screen.
          const ts = activeSession;
          if (runningSessions.has(ts)) return; // one turn per chat (other chats run in parallel)
          runningSessions.add(ts);
          // Wave 1 — a user message is activity, but project order is stable.
          if (!wsRecents.includes(wsCurrent)) wsRecents = [...wsRecents, wsCurrent];
          recentsListeners.forEach((l) => l({ recents: wsRecents, reason: 'user-message', workspaceRoot: wsCurrent }));
          emit({ kind: 'turn-start', prompt: command.prompt }, 0, ts);
          // Memory recalled BEFORE the model runs — renders the briefing row and
          // feeds the Context panel's "Memory recall" savings counter.
          emit({ kind: 'memory', op: 'briefing', sources: ['memory_keyword', 'memory_vector', 'memory_graph'], records: [
            { id: 'mem_core_identity_v3', type: 'identity', priority: 5, source: 'memory_graph', score: 0.98, content: 'Core identity: BrainRouter engineer; OpenAI-compatible only.' },
            { id: 'mem_recall_blend', type: 'project', priority: 4, source: 'memory_vector', score: 0.91, content: 'Recall blends reranker + RRF (0.6/0.4); never hard-drop candidates.' },
            { id: 'mem_reranker_cpu', type: 'project', priority: 3, source: 'memory_vector', score: 0.84, content: 'CPU reranker ≈1.3s/doc — keep the char budget ~9k.' },
            { id: 'mem_no_vendor_refs', type: 'feedback', priority: 4, source: 'memory_keyword', score: 0.79, content: 'No vendor/planning refs in committed code or docs.' },
            { id: 'mem_membench_split', type: 'reference', priority: 2, source: 'memory_graph', score: 0.72, content: 'MemBench + LoCoMo are the recall-accuracy splits.' },
            { id: 'mem_session_scope', type: 'project', priority: 3, source: 'memory_keyword', score: 0.68, content: 'Artifacts/annotations are session-scoped on capture.' },
          ] } as unknown as AgentEvent, 80, ts);
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
          emit({ kind: 'tool-end', tool: 'edit_file', ok: true, summary: 'Edited src/memory/recall.ts +37 -4', preview: 'applied 2 hunks' }, 1650, ts);
          emit({ kind: 'tool-end', tool: 'write_file', ok: true, summary: 'wrote src/memory/blend.ts', preview: 'new file' }, 1700, ts);
          emit({ kind: 'tool-end', tool: 'edit_file', ok: true, summary: 'Edited src/memory/store/reranker.ts +22 -0', preview: 'applied 1 hunk' }, 1750, ts);
          // LIVE token ramp — the agent emits onUsageUpdate after every LLM call;
          // we mirror that here (cumulative turn usage) so the Context panel's
          // token counter visibly climbs during the turn, not only at turn-end.
          emit({ kind: 'usage-live', promptTokens: 8_100, completionTokens: 0, calls: 1, cachedTokens: 5_900 }, 250, ts);
          emit({ kind: 'usage-live', promptTokens: 17_400, completionTokens: 140, calls: 2, cachedTokens: 13_600 }, 750, ts);
          emit({ kind: 'usage-live', promptTokens: 29_800, completionTokens: 520, calls: 3, cachedTokens: 24_100 }, 1300, ts);
          emit({ kind: 'usage-live', promptTokens: 41_200, completionTokens: 1_180, calls: 4, cachedTokens: 34_700 }, 1950, ts);
          if (wantsApproval) {
            emit({ kind: 'interaction-request', request: { id: 'ir_demo', type: 'confirm', title: 'Run shell command?', detail: 'git push origin release/0.4.15', dangerous: true, tool: 'run_command' } }, 1800, ts);
          }
          emit({ kind: 'plan-update', items: [
            { step: 'Reproduce the failing case', status: 'completed', acceptance: 'MemBench drop isolated to the blend' },
            { step: 'Patch the blend scoring', status: 'in_progress', acceptance: 'recall.ts blends 0.6·rerank + 0.4·rrf' },
            { step: 'Re-run the 6-split sweep', status: 'pending', acceptance: 'all 6 splits green' },
          ] }, 1900, ts);
          emit({ kind: 'assistant-turn-start' }, 2100, ts);
          // T10 — when the prompt asks the model to "think"/"reason", prepend a
          // leading <think> block (as DeepSeek-R1/QwQ do) so the renderer's
          // reasoning extraction + collapsible block is exercisable in preview.
          const think = /\b(think|thinking|reason|reasoning)\b/i.test(command.prompt)
            ? `<think>\nThe reranker currently REPLACES the retriever order, which hard-drops good candidates. Blending the scores and then sorting keeps them. Past sweeps liked 0.6/0.4. So: score → sort → take top-N, never hard-drop.\n</think>\n\n`
            : '';
          const answer = `${think}Here's what I found in the workspace:\n\n- The recall blend lives in \`src/memory/recall.ts\` and the reranker score **replaces** the retriever order.\n- Fix: blend with the recency/RRF score instead — *score → sort → take top-N, never hard-drop*.\n\n\`\`\`ts\nconst blended = 0.6 * rerank + 0.4 * rrf;\n\`\`\`\n\n| split | before | after |\n|---|---|---|\n| MemBench | 0.41 | **0.58** |\n| LoCoMo | 0.37 | **0.52** |`;
          answer.split(/(?<=\s)/).forEach((chunk, i) => emit({ kind: 'assistant-delta', text: chunk }, 2200 + i * 18, ts));
          const end = 2200 + answer.split(/(?<=\s)/).length * 18 + 200;
          emit({ kind: 'assistant-turn-end' }, end, ts);
          emit({ kind: 'turn-complete', answer }, end + 80, ts);
          setTimeout(() => runningSessions.delete(ts), end + 90);
          emit({ kind: 'tokens-updated', promptTokens: 48_213, completionTokens: 1_904, calls: 6, turns: 3, cachedTokens: 39_700 }, end + 120, ts);
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
          // Item 10 — a resumed chat reports ITS resolved model (per-session override or global).
          emit({ kind: 'session-changed', sessionKey: key, loadedMessages: 12, model: resolvedModel(key) }, 60, key);
          return;
        }
        case 'set-model': {
          const m = (command as { model: string }).model;
          const persist = (command as { persist?: boolean }).persist;
          // Item 10 — persist:true → global default; persist:false → this chat only.
          if (persist) { devModel = m; delete devSessionModels[activeSession]; }
          else { devSessionModels[activeSession] = m; }
          emit({ kind: 'status', text: `Model set to ${m}${persist ? ' (saved to config.json — shared with the CLI)' : ' (this chat only)'}.` }, 60, activeSession);
          emit({ kind: 'session-changed', sessionKey: activeSession, loadedMessages: -1, model: resolvedModel(activeSession) }, 80, activeSession);
          return;
        }
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
    workspaceSessions: async (root: string, limit = 80) => {
      const rows = mergeMeta(root).slice(0, Math.max(1, Math.min(120, Number(limit) || 80)));
      return { rows: rows as Array<Record<string, unknown>>, truncated: rows.length >= limit };
    },
    onRecentsChanged: (l: (d: { recents: string[]; reason: string; workspaceRoot: string }) => void) => { recentsListeners.add(l); return () => recentsListeners.delete(l); },
    markActivity: async (root: string) => {
      if (!wsRecents.includes(root)) wsRecents = [...wsRecents, root].slice(0, 10);
      recentsListeners.forEach((l) => l({ recents: wsRecents, reason: 'commit', workspaceRoot: root }));
      return { ok: true };
    },
    reorderWorkspace: async (dragged: string, target: string) => {
      const from = wsRecents.indexOf(dragged);
      const to = wsRecents.indexOf(target);
      if (from >= 0 && to >= 0 && from !== to) {
        const next = [...wsRecents];
        const [item] = next.splice(from, 1);
        next.splice(from < to ? to - 1 : to, 0, item);
        wsRecents = next;
        recentsListeners.forEach((l) => l({ recents: wsRecents, reason: 'manual-reorder', workspaceRoot: dragged }));
      }
      return { recents: wsRecents };
    },
    // T1 — cross-workspace dashboard mock: a couple of background workspaces with running tasks + gates.
    globalDashboard: async () => ({ workspaces: [
      { workspaceRoot: '/Users/dev/BrainRouter', reviewGate: { status: 'blocked', blocked: true, reason: '1 unresolved high+ finding' }, tasks: [
        { kind: 'workflow', id: 'wf-1', label: 'verify-desktop-refactor', status: 'running', startedAt: new Date(Date.now() - 42_000).toISOString(), workspaceRoot: '/Users/dev/BrainRouter' },
        { kind: 'sub-agent', id: 'ag-1', label: 'reviewer · recall.ts', status: 'running', role: 'reviewer', startedAt: new Date(Date.now() - 18_000).toISOString(), workspaceRoot: '/Users/dev/BrainRouter' },
      ] },
      { workspaceRoot: '/Users/dev/side-project', reviewGate: { status: 'clean', blocked: false, reason: '' }, tasks: [
        { kind: 'worker', id: 'wk-9', label: 'bench worker', status: 'running', worktree: true, startedAt: new Date(Date.now() - 5_000).toISOString(), workspaceRoot: '/Users/dev/side-project' },
        // a verification (typecheck) still running in this NON-active workspace —
        // its indicator + count must stay visible while another workspace is active.
        { kind: 'verification', id: 'btask_v9', label: 'Verify — npm run typecheck', status: 'running', durable: true, startedAt: new Date(Date.now() - 9_000).toISOString(), workspaceRoot: '/Users/dev/side-project', transcript: { kind: 'task', id: 'btask_v9', parentSessionKey: 'internal:verify:btask_v9' } },
      ] },
      { workspaceRoot: '/Users/dev/TradingAgents', reviewGate: null, tasks: [] },
    ] }),
    openWorkspace: async (root: string) => {
      // Mirror the real main-process swap. Opening is membership only; explicit
      // drag/drop is what changes project order.
      wsCurrent = root;
      if (!wsRecents.includes(root)) wsRecents = [...wsRecents, root].slice(0, 10);
      if (!SESSIONS_BY_ROOT[root]) SESSIONS_BY_ROOT[root] = [];
      emit({ kind: 'session-changed', sessionKey: `dev:${root.split('/').pop()}`, loadedMessages: 0, model: 'claude-opus-4-8' }, 350);
      return { opened: true };
    },
    // T1 — workspace trust mocks (real impl is the shared CLI store via main).
    isWorkspaceTrusted: async (root: string) => ({ trusted: trustedRoots.has(root) }),
    trustWorkspace: async (root: string) => { trustedRoots.add(root); return { trusted: true }; },
    untrustWorkspace: async (root: string) => { trustedRoots.delete(root); return { trusted: false }; },
    trustedWorkspaces: async () => ({ trusted: [...trustedRoots] }),
    getZoomFactor(): number {
      const saved = localStorage.getItem('br-zoom-factor');
      return saved ? parseFloat(saved) : 1.0;
    },
    setZoomFactor(factor: number): void {
      localStorage.setItem('br-zoom-factor', String(factor));
      document.body.style.zoom = String(factor);
    },
  };

  // Dev-only — fire a turn event tagged with ANY workspaceRoot (even one not on
  // screen), so the sidebar's "running elsewhere" dot (item 4) is exercisable in
  // the browser preview. Not present in the Electron preload bridge.
  (window as unknown as { __devEmitWs?: (root: string, kind: string, sessionKey?: string) => void }).__devEmitWs =
    (workspaceRoot, kind, sessionKey = 'bg:task') => {
      listeners.forEach((l) => l({ seq: ++seq, ts: Date.now(), sessionKey, event: { kind } as AgentEvent, workspaceRoot } as AgentEventMessage & { workspaceRoot: string }));
    };
}
