// devBridge/queries.ts — the dev bridge's query handler map. Extracted verbatim from
// installDevBridge(); each handler closes over the shared dev state (./state) via the
// destructured helpers below and S.<scalar> for reassignable scalars. Behavior-identical.
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { devAtlasEnriched, devAtlasGraph } from './atlas.js';
import type { DevState } from './state.js';

// Record shapes reused by a few handlers, derived from the live state so the
// text stays in one place (state.ts) — structurally identical to the originals.
type DevReq = DevState['devRequirements'][number];
type DevAnnot = DevState['devAnnotations'][number];
type DevArtifact = DevState['devArtifacts'][number];
type DevPlanDecision = DevState['devPlanDecisions'][number];
type DevAttachment = DevState['devAttachments'] extends Map<string, infer V> ? V : never;

export function createQueries(S: DevState): Record<string, (args: Record<string, unknown>) => unknown> {
  const {
    DEMO_DIFF, prefs, sessionModes, effectivePrefs, resolvedModel, SESSIONS_BY_ROOT, devMeta, mergeMeta, devGroups, devSchedules, devWorktrees, devRequirements, devAnnotations, devAnnotMarkdown, devArtifacts, devPlanState, trackCat, mkItem, devTrack, devSprints, devModules, devViews, devFindItem, devAutomations, devPlanDecisions, DEV_DIFF_HASH, devRunReview, devGate, devRules, devProviders, devCliKnobs, devExtensions, devGithub, devConnectorCatalog, devSlimDocuments, devConnectorPermissionCounts, devConnectorRuns, devServers, devFiles, devWorkflows, devShortcuts, devFileRead, devAttachments, attachmentKind, attachmentMime, decodePreview, attachmentContext,
  } = S;
  // MC-DESK Batch 2 — mutable dev fixtures for the runtime/automation monitor
  // cards (browser preview + Preview server). Real data comes from node-fs core
  // APIs host-side; here we mock enough to render + exercise the actions.
  const devRuntimes = [
    { id: 'rt_ab12cd34', backend: 'worktree', status: 'ready', pid: 4821, worktree: '/Users/dev/.brainrouter/runtime/worktrees/rt_ab12cd34', createdAt: '2026-07-04T09:12:00Z', updatedAt: '2026-07-04T09:40:00Z' },
    { id: 'rt_ef56gh78', backend: 'process', status: 'parked', pid: null, worktree: null, createdAt: '2026-07-03T21:05:00Z', updatedAt: '2026-07-04T02:11:00Z' },
  ];
  let devArchives = [
    { id: 'rt_zz99yy88', branch: 'feat/login', baseCommit: 'a1b2c3d4e5', bytes: 184_320, changedFiles: 7, status: 'ok', createdAt: '2026-07-02T14:20:00Z', note: null, workspaceRoot: '/Users/dev/BrainRouter' },
    { id: 'rt_qq11ww22', branch: 'HEAD', baseCommit: 'f6e5d4c3b2', bytes: 96_640_000, changedFiles: 210, status: 'partial', createdAt: '2026-06-30T08:00:00Z', note: 'tarball skipped: oversize payload', workspaceRoot: '/Users/dev/BrainRouter' },
  ];
  const devPreviewsLive = [
    { runtimeId: 'rt_ab12cd34', name: 'web', url: 'http://127.0.0.1:5173', port: 5173 },
  ];
  const devTriggerServe = { running: false, host: null as string | null, port: null as number | null, startedAt: null as string | null, providers: [] as string[], recentEvents: [] as string[], lastError: null as string | null };
  const devRouterServe = { running: false, host: null as string | null, port: null as number | null, startedAt: null as string | null, url: null as string | null, recentEvents: [] as string[], lastError: null as string | null };
  const devAgentModels: Array<{ role: string; provider: string | null; model: string | null }> = [
    { role: 'explorer', provider: 'groq', model: null },
    { role: 'reviewer', provider: null, model: 'gpt-5.3-codex' },
  ];
  const devAutomationRules = [
    { id: 'label-fix', name: 'Fix labeled bugs', on: 'github.issue.labeled', when: "label == 'bug'", do: 'build', enabled: true, sourcePath: '/Users/dev/BrainRouter/.brainrouter/automations/label-fix.md' },
    { id: 'ci-repair', name: 'Repair failing CI', on: 'github.workflow_run.completed', when: "conclusion == 'failure'", do: 'fix-ci', enabled: false, sourcePath: '/Users/dev/BrainRouter/.brainrouter/automations/ci-repair.md' },
  ];
  const devRouterCatalog = () => {
    const canonical = devProviders.flatMap((p) => {
      const models = p.cachedModels?.length
        ? (p.models.length ? p.cachedModels.filter((m) => p.models.includes(m)) : p.cachedModels)
        : (p.models.length ? p.models : [p.model]);
      return models.map((model) => ({
        id: `${p.name}/${model}`,
        slug: `${p.name}/${model}`,
        model,
        provider: p.name,
        providers: [p.name],
        endpoint: p.endpoint ?? undefined,
        cachedAt: p.cachedAt ?? undefined,
      }));
    });
    const bareMap = new Map<string, { id: string; model: string; providers: string[]; endpoint?: string; cachedAt?: string }>();
    for (const entry of canonical) {
      const row = bareMap.get(entry.model) ?? { id: entry.model, model: entry.model, providers: [], endpoint: entry.endpoint, cachedAt: entry.cachedAt };
      row.providers.push(entry.provider);
      bareMap.set(entry.model, row);
    }
    const router = (devCliKnobs.router ?? {}) as { chain?: string[] };
    // Router-first: routing is always on (no `enabled` gate).
    return { enabled: true, primaryChain: Array.isArray(router.chain) ? router.chain : [], canonical, bare: [...bareMap.values()], aliases: [] };
  };
  const queries: Record<string, (args: Record<string, unknown>) => unknown> = {
    'list-sessions': () => mergeMeta(S.wsCurrent),
    'runtime-runner-info': () => ({ mode: 'in-process', remoteUrl: null }),
    'runtime-runner-status': (a) => ({ runtimeId: String(a.runtimeId ?? ''), status: 'unknown', live: false }),
    'runtime-previews-list': () => ({
      reservations: [{ name: 'app', port: 5173, url: 'http://127.0.0.1:5173' }],
      previews: [],
    }),
    'runtime-preview-register': (a) => ({
      ok: true,
      preview: {
        runtimeId: String(a.runtimeId ?? 'rt_dev'),
        name: String(a.name ?? 'app'),
        port: Number(a.port ?? 5173),
        host: '127.0.0.1',
        protocol: 'http',
        url: `http://127.0.0.1:${Number(a.port ?? 5173)}`,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
    'runtime-preview-remove': () => ({ ok: true }),
    'schedule-list': () => devSchedules,
    'schedule-add': (a) => {
      const kind = a.kind === 'once' ? 'once' : 'cron';
      const expr = String(a.expr ?? ''); const command = String(a.command ?? '');
      const nextRun = kind === 'once' ? new Date(expr).toISOString() : new Date(Date.now() + 900_000).toISOString();
      const rec = { id: `sch_dev${++S.schedSeq}`, kind: kind as 'cron' | 'once', expr, command, owner: S.activeSession, enabled: true, createdAt: new Date().toISOString(), nextRun };
      devSchedules.push(rec); return { ok: true, schedule: rec };
    },
    'schedule-remove': (a) => { const i = devSchedules.findIndex((s) => s.id === a.id); if (i >= 0) devSchedules.splice(i, 1); return { ok: i >= 0 }; },
    'schedule-toggle': (a) => { const s = devSchedules.find((x) => x.id === a.id); if (s) s.enabled = a.enabled !== false; return { ok: !!s, enabled: a.enabled !== false }; },
    // T13 — mock git worktrees (raw porcelain, parsed in the renderer).
    'git-worktrees': () => ({ raw: devWorktrees.map((w) => `worktree ${w.path}\nHEAD ${'a'.repeat(40)}\n${w.detached ? 'detached' : `branch refs/heads/${w.branch}`}\n`).join('\n'), gitRoot: '/Users/dev/BrainRouter', current: S.wsCurrent }),
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
      const id = `req_dev${++S.reqSeq}`;
      const rec: DevReq = {
        id, title: String(a.title ?? '').trim() || 'Untitled requirement', status: 'draft', priority: 'medium',
        acceptanceCriteria: [], clarifyingQuestions: [], workspaceRoot: S.wsCurrent, sessionKey: S.activeSession,
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
        id: `ann_dev${++S.annotSeq}`, type: String(a.type), body, workspaceRoot: S.wsCurrent, sessionKey: S.activeSession,
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
      r.comments = [...(r.comments ?? []), { id: `cmt_${(S.annotSeq++).toString(16).padStart(8, '0')}`, body, createdAt: new Date().toISOString() }];
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
        id: `art_dev${++S.artSeq}`, kind: String(a.kind), title,
        status: typeof a.status === 'string' && ['draft', 'final', 'archived'].includes(a.status) ? a.status : 'draft',
        format: typeof a.format === 'string' && formats.includes(a.format) ? a.format : 'markdown',
        workspaceRoot: S.wsCurrent, sessionKey: S.activeSession, linkedMemoryIds: [],
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
    'review-current': () => ({ run: S.devReview, gate: devGate(), diffHash: DEV_DIFF_HASH, files: 2 }),
    'review-gate': () => ({ run: S.devReview, gate: devGate(), diffHash: DEV_DIFF_HASH, files: 2 }),
    'review-status': () => { const g = devGate(); return { status: g.status, blocked: g.blocked, reason: g.reason }; },
    'review-dismiss-finding': (a) => { const f = S.devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'dismissed'; return { ok: !!f }; },
    'review-resolve-finding': (a) => { const f = S.devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'fixed'; return { ok: !!f }; },
    'review-set-finding-status': (a) => { const ok = ['open','applied','dismissed','fixed','stale','acknowledged','disputed','out-of-scope'].includes(String(a.status)); if (!ok) return { ok: false, error: 'bad status' }; const f = S.devReview?.findings.find((x) => x.id === a.id); if (f) f.status = String(a.status); return { ok: !!f }; },
    'review-apply-suggestion': (a) => { const f = S.devReview?.findings.find((x) => x.id === a.id); if (f && f.patch) { f.status = 'applied'; return { ok: true }; } return { ok: false, error: 'This finding has no applicable patch — use "Ask agent to fix".' }; },
    // T3 — scoped fix agent (mock): mark fixed, return the re-run review.
    'review-fix-finding': (a) => { const f = S.devReview?.findings.find((x) => x.id === a.id); if (f) f.status = 'fixed'; return { ok: !!f, findingId: a.id, files: 2, run: S.devReview }; },
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
      const src = (SESSIONS_BY_ROOT[S.wsCurrent] as Array<{ sessionKey: string; firstUserMessage?: string }> | undefined)?.find((s) => s.sessionKey === key);
      const newKey = `${key.split(':')[0]}:fork-${Math.floor(Date.now() % 1e6).toString(36)}`;
      (SESSIONS_BY_ROOT[S.wsCurrent] as unknown[]).unshift({ sessionKey: newKey, firstUserMessage: `${src?.firstUserMessage ?? key} (fork)`, modifiedAt: new Date().toISOString(), turnCount: src ? 1 : 0, lastRole: 'assistant', forkedFrom: key });
      return { ok: true, newKey };
    },
    'action:session-groups': () => ({ groups: devGroups() }),
    'action:open-external': (a) => ({ ok: true, what: String(a.what ?? '') }),
    'git-pr': () => (S.wsCurrent === '/Users/dev/BrainRouter'
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
      ...(S.devShellAlive ? [{ kind: 'shell', id: 'bgsh_devsrv', label: 'npm run dev — http://localhost:5173', startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), parentSessionKey: 'dev:fix-recall-blend' }] : []),
    ],
    'action:kill-bgshell': (a) => { if (String(a.id ?? '') === 'bgsh_devsrv') S.devShellAlive = false; return { ok: true }; },
    // §3 — durable task list (scoped). Mirrors the host's tasks-list shape.
    'tasks-list': () => [
      { id: 'btask_a1', kind: 'plan-revision', status: 'running', title: 'Revise plan — requested changes', phase: 'writing-plan', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 22_000).toISOString(), startedAt: new Date(Date.now() - 22_000).toISOString(), updatedAt: new Date().toISOString(), progress: [], linkedMemoryIds: [] },
      // recently-finished verification runs — completed + failed, for the panel's "Recently finished" section
      { id: 'btask_v7', kind: 'verification', status: 'completed', title: 'Verify — npm run typecheck', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), completedAt: new Date(Date.now() - 4 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(), progress: [], linkedMemoryIds: [], transcript: { kind: 'task', id: 'btask_v7', parentSessionKey: 'internal:verify:btask_v7' } },
      { id: 'btask_v8', kind: 'verification', status: 'failed', title: 'Verify — npm test', error: '2 tests failed', sessionKey: 'dev:fix-recall-blend', createdAt: new Date(Date.now() - 9 * 60_000).toISOString(), startedAt: new Date(Date.now() - 9 * 60_000).toISOString(), completedAt: new Date(Date.now() - 8 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 8 * 60_000).toISOString(), progress: [], linkedMemoryIds: [], transcript: { kind: 'task', id: 'btask_v8', parentSessionKey: 'internal:verify:btask_v8' } },
    ],
    'suggested-tasks': () => ({
      repo: 'kinqsradiollc/BrainRouter',
      warnings: [],
      tasks: [
        {
          kind: 'failing-checks',
          title: 'PR #42 ("phase 3 reflexes") has failing checks: typecheck',
          repo: 'kinqsradiollc/BrainRouter',
          number: 42,
          url: 'https://github.com/kinqsradiollc/BrainRouter/pull/42',
          suggestedPrompt: 'Fix the failing checks on PR #42 in kinqsradiollc/BrainRouter ("phase 3 reflexes"): typecheck. Check out the PR branch, reproduce each failure locally, fix it, and push the fixes to the same branch.',
        },
        {
          kind: 'labeled-issue',
          title: 'Issue #77 ("wire desktop suggested starters") is labeled "brainrouter"',
          repo: 'kinqsradiollc/BrainRouter',
          number: 77,
          url: 'https://github.com/kinqsradiollc/BrainRouter/issues/77',
          suggestedPrompt: 'Work on issue #77 in kinqsradiollc/BrainRouter ("wire desktop suggested starters"). Implement it on a fresh branch and open a pull request that references the issue.',
        },
      ],
    }),
    'attachment-ingest': (a) => {
      const name = String(a.name || a.path || 'file').split('/').pop() || 'file';
      const kind = attachmentKind(name);
      const dataBase64 = typeof a.dataBase64 === 'string' ? a.dataBase64 : '';
      const rec: DevAttachment = {
        id: `att_dev${S.devAttachmentSeq++}`,
        name,
        kind,
        mimeType: attachmentMime(name, kind),
        byteSize: dataBase64 ? Math.floor((dataBase64.length * 3) / 4) : 0,
        extractedText: decodePreview(dataBase64, kind),
        workspaceRoot: S.wsCurrent,
        sessionKey: S.activeSession,
        createdAt: new Date().toISOString(),
      };
      devAttachments.set(rec.id, rec);
      return { ok: true, attachment: rec, contextMarkdown: attachmentContext(rec) };
    },
    'attachment-list': () => [...devAttachments.values()].filter((a) => a.workspaceRoot === S.wsCurrent && a.sessionKey === S.activeSession),
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
    'session-info': () => ({ sessionKey: 'dev:demo', model: resolvedModel(S.activeSession), workspaceRoot: S.wsCurrent, username: 'anhdang' }),
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
      workspaceRoot: S.wsCurrent, gitRoot: '/Users/dev/BrainRouter', repoRelativePath: 'brainrouter-desktop', isSubdir: true,
    }),
    'git-log': () => ({ subjects: ['feat(desktop): DESK-4l — interactive views rail, tabbed bottom terminal', 'feat(desktop): DESK-4k — modern skin', 'feat(desktop): DESK-5c — file tree, real terminal'] }),
    // Models a 128k-window model with a 256k auto-compact knob (knob > window) —
    // the renderer clamps compactAt down to the window so the two bars share a max.
    'context-usage': () => ({ used: S.devCtxUsed, window: 128_000, compactAt: 256_000, limit: 256_000, pct: Math.min(1, S.devCtxUsed / 256_000) }),
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
      devTrack.items.unshift(mkItem(`BR-${S.devTrackN++}`, String(a.type ?? 'task'), String(a.title ?? 'Untitled'), status, 'medium'));
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
      if (it) it.comments = [...(Array.isArray(it.comments) ? it.comments : []), { id: `cmt_${S.devTrackN++}`, author: 'anhdang', body: String(a.body ?? ''), createdAt: new Date().toISOString() }];
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
      devSprints.push({ id: `sp_${S.devSprintN++}`, workspaceRoot: S.wsCurrent, name: String(a.name ?? 'Sprint'), goal: a.goal ? String(a.goal) : undefined, state: 'future', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return [...devSprints];
    },
    'track-sprint-state': (a) => {
      const sp = devSprints.find((s) => s.id === a.id);
      if (sp) sp.state = String(a.state ?? 'future');
      return [...devSprints];
    },
    'track-modules': () => [...devModules],
    'track-create-module': (a) => {
      devModules.unshift({ id: `mod_${S.devModuleN++}`, workspaceRoot: S.wsCurrent, name: String(a.name ?? 'Module'), description: a.description ? String(a.description) : undefined, status: 'planned', members: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
        const rec = { id: existing?.id ?? `view_${S.devViewN++}`, workspaceRoot: S.wsCurrent, name, layout: input.layout ?? 'board', query: input.query || undefined, filters: input.filters || undefined, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, rec); else devViews.push(rec);
      }
      return [...devViews];
    },
    'track-delete-view': (a) => { const i = devViews.findIndex((v) => v.id === a.id); if (i >= 0) devViews.splice(i, 1); return [...devViews]; },
    'track-automations': () => [...devAutomations],
    'track-create-automation': (a) => {
      devAutomations.push({ id: `auto_${S.devAutoN++}`, name: String(a.name ?? 'Rule'), enabled: true, trigger: String(a.trigger ?? 'created'), condition: a.condition ? String(a.condition) : undefined, actions: Array.isArray(a.actions) ? a.actions : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
      root: S.wsCurrent,
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
          root: S.wsCurrent,
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
      const url = `https://github.com/kinqsradiollc/BrainRouter/pull/${42 + S.devTrackN++}`;
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
      const decision: DevPlanDecision = { id: `pdec_${S.devPlanSeq++}`, verdict, planSnapshot: devPlanState.items.map((i) => ({ ...i })), explanation: devPlanState.explanation, createdAt: new Date().toISOString(), linkedMemoryIds: [] };
      if (feedback) decision.feedback = feedback;
      devPlanDecisions.push(decision);
      return { ok: true, decision };
    },
    'git-branches': () => ({ current: 'release/0.4.15', branches: ['release/0.4.15', 'main', 'feat/desk-4j-reference-patterns', 'release/0.4.14'] }),
    // Dev-only mock of an endpoint's GET /models. Echoes `provider` so the
    // settings' per-provider model pickers can be exercised in the preview.
    'list-models': (a) => a?.provider
      ? ({ current: '', provider: String(a.provider), models: [`${a.provider}-fast`, `${a.provider}-pro`, `${a.provider}-reasoning`] })
      : ({ current: resolvedModel(S.activeSession), models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-5.5', 'gpt-5.3-codex', 'qwen3-coder-32b', 'deepseek-v4', 'glm-5-air', 'text-embedding-nomic-embed-text-v1.5', 'whisper-large-v3'] }),
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
    'term-open': () => { S.termBuf = '\u001b[1;32mdemo-shell\u001b[0m on \u001b[1;34m/Users/dev/BrainRouter\u001b[0m\r\n$ '; return { id: 'tdemo', shell: '/bin/zsh (demo)' }; },
    'term-write': (a) => {
      const d = String(a.data ?? '');
      S.termBuf += d.replace('\r', '');
      if (d.includes('\r')) S.termBuf += '\r\n(demo) executed in the workspace\r\n$ ';
      return { ok: true };
    },
    'term-read': (a) => { const from = Number(a.from) || 0; return { chunk: S.termBuf.slice(from), next: S.termBuf.length, alive: true }; },
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
      all: ['/help', '/status', '/model', '/profile', '/mcp', '/theme', '/vim', '/spawn', '/bg', '/workers', '/ps'],
    }),
    'config-snapshot': () => ({
      model: 'claude-opus-4-8', provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', fallbackModel: null,
      // Mock of config/providers.json — the main-provider picker source.
      providerCatalog: [
        { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', local: false },
        { id: 'anthropic', label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', local: false },
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
        items: S.devConnectors.map((entry) => ({ ...entry, config: { ...entry.config }, credential: { ...entry.credential }, flows: [...entry.flows] })),
        documentCounts: Object.fromEntries(S.devConnectors.map((entry) => [entry.id, Number((entry.checkpoint as { documentCount?: number } | undefined)?.documentCount ?? 0)])),
        permissionCounts: Object.fromEntries(S.devConnectors.map((entry) => [entry.id, devConnectorPermissionCounts[entry.id] ?? 0])),
        runPreviews: Object.fromEntries(S.devConnectors.map((entry) => [entry.id, devConnectorRuns[entry.id] ?? []])),
        documentPreviews: Object.fromEntries(S.devConnectors.map((entry) => [entry.id, devSlimDocuments(entry.id, 3)])),
      },
      workspacePrefs: { ...prefs },
      sessionMode: { ...(sessionModes[S.activeSession] ?? {}) },
      modeScope: 'session',
      permissionRules: { allow: [...devRules.allow], deny: [...devRules.deny] },
      hooks: [
        { id: 'h1', event: 'pre-tool', command: './hooks/guard-prod.sh', enabled: true, match: 'run_command' },
        { id: 'h2', event: 'user-prompt-submit', command: './hooks/inject-ticket.sh', enabled: false },
      ],
      servers: devServers.map((s) => ({ ...s })),
      activeServer: S.devActiveServer, // WS9 — the single active brain
      // §multi-provider — named providers (mutable in dev) + per-role routing.
      providers: devProviders.map((p) => ({ ...p })),
      routerCatalog: devRouterCatalog(),
      routerStatus: {
        providers: [{ provider: 'groq', until: Date.now() + 42_000, step: 1, reason: 'provider_retryable' }],
        models: [],
        recentEvents: [{ at: Date.now() - 12_000, message: 'groq/llama-3.3-70b unavailable (provider_retryable 429), routed to openrouter/llama-3.3-70b', from: 'groq/llama-3.3-70b', to: 'openrouter/llama-3.3-70b', reason: 'provider_retryable', status: 429 }],
      },
      routerServe: { ...devRouterServe, recentEvents: [...devRouterServe.recentEvents] },
      routerSecretsSet: { serveKey: typeof ((devCliKnobs.router as { serveKey?: string } | undefined)?.serveKey) === 'string' },
      defaultProviderName: S.devDefaultProvider,
      defaultProviderModelMatches: true,
      agentModels: devAgentModels.map((entry) => ({ ...entry })),
      triggerSecretsSet: {
        github: typeof (devCliKnobs.triggers as { githubSecret?: string } | undefined)?.githubSecret === 'string',
        slack: typeof (devCliKnobs.triggers as { slackSigningSecret?: string } | undefined)?.slackSigningSecret === 'string',
        gitlab: typeof (devCliKnobs.triggers as { gitlabSecret?: string } | undefined)?.gitlabSecret === 'string',
        jira: typeof (devCliKnobs.triggers as { jiraSecret?: string } | undefined)?.jiraSecret === 'string',
      },
      runtimes: devRuntimes.map((r) => ({ ...r })),
      runtimeArchives: devArchives.map((a) => ({ ...a })),
      runtimePreviewsLive: devPreviewsLive.map((p) => ({ ...p })),
      automationRules: devAutomationRules.map((r) => ({ ...r })),
      triggerServe: { ...devTriggerServe, providers: [...devTriggerServe.providers], recentEvents: [...devTriggerServe.recentEvents] },
    }),
    'action:triggers-serve-start': () => {
      const trig = devCliKnobs.triggers as { enabled?: boolean; host?: string; port?: number } | undefined;
      if (trig?.enabled !== true) { devTriggerServe.lastError = 'Trigger ingress is disabled — turn on "Enable trigger ingress" first (cli.triggers.enabled).'; return { ok: false, error: devTriggerServe.lastError }; }
      devTriggerServe.running = true; devTriggerServe.host = trig.host ?? '127.0.0.1'; devTriggerServe.port = trig.port ?? 8787;
      devTriggerServe.startedAt = new Date().toISOString(); devTriggerServe.providers = ['github', 'slack', 'gitlab', 'jira'];
      devTriggerServe.recentEvents = [`${devTriggerServe.startedAt} listening on http://${devTriggerServe.host}:${devTriggerServe.port}`];
      devTriggerServe.lastError = null;
      return { ok: true, host: devTriggerServe.host, port: devTriggerServe.port };
    },
    'action:triggers-serve-stop': () => {
      devTriggerServe.running = false; devTriggerServe.host = null; devTriggerServe.port = null; devTriggerServe.startedAt = null; devTriggerServe.providers = [];
      return { ok: true };
    },
    'action:router-serve-start': () => {
      const router = devCliKnobs.router as { serve?: boolean; serveHost?: string; servePort?: number; serveKey?: string } | undefined;
      if (router?.serve !== true) { devRouterServe.lastError = 'Router gateway is disabled — turn on cli.router.serve first.'; return { ok: false, error: devRouterServe.lastError }; }
      if (!router.serveKey) { devRouterServe.lastError = 'Router gateway requires cli.router.serveKey.'; return { ok: false, error: devRouterServe.lastError }; }
      devRouterServe.running = true; devRouterServe.host = router.serveHost ?? '127.0.0.1'; devRouterServe.port = router.servePort ?? 8790;
      devRouterServe.url = `http://${devRouterServe.host}:${devRouterServe.port}/router/v1`;
      devRouterServe.startedAt = new Date().toISOString();
      devRouterServe.recentEvents = [`${devRouterServe.startedAt} listening on ${devRouterServe.url}`];
      devRouterServe.lastError = null;
      return { ok: true, host: devRouterServe.host, port: devRouterServe.port };
    },
    'action:router-serve-stop': () => {
      devRouterServe.running = false; devRouterServe.host = null; devRouterServe.port = null; devRouterServe.url = null; devRouterServe.startedAt = null;
      return { ok: true };
    },
    'action:runtime-remove-record': (a) => { const i = devRuntimes.findIndex((r) => r.id === a.id); if (i >= 0) devRuntimes.splice(i, 1); return { ok: i >= 0, id: String(a.id ?? '') }; },
    'action:runtime-resume-archive': (a) => ({ ok: true, id: String(a.id ?? ''), worktreeRoot: '/Users/dev/.brainrouter/runtime/worktrees/'+String(a.id ?? ''), patchApplied: true, filesRestored: true, patchError: null }),
    'action:runtime-prune-archives': (a) => { const keepN = typeof a.keepN === 'number' ? a.keepN : 1; const removed = devArchives.slice(keepN).map((x) => x.id); devArchives = devArchives.slice(0, keepN); return { ok: true, removed }; },
    'action:automation-rule-enabled': (a) => { const r = devAutomationRules.find((x) => x.id === a.id); if (r) r.enabled = a.enabled === true; return { ok: !!r, id: String(a.id ?? ''), enabled: a.enabled === true }; },
    'action:set-provider': (a) => {
      const name = String(a.name ?? '').trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return { ok: false, error: 'Provider name must be letters, digits, . _ - only.' };
      const models = Array.isArray(a.models) ? a.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : [];
      const cachedModels = Array.isArray(a.cachedModels) ? a.cachedModels.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : [];
      const model = String(a.model ?? '').trim() || models[0] || '';
      if (!model) return { ok: false, error: 'A model is required.' };
      const entry = {
        name,
        provider: String(a.provider ?? '').trim() || 'openai-compatible',
        model,
        endpoint: (String(a.endpoint ?? '').trim() || null),
        hasKey: !!String(a.apiKey ?? '').trim(),
        models,
        cachedModels,
        cachedAt: cachedModels.length ? new Date().toISOString() : null,
        apiVersion: a.apiVersion ? String(a.apiVersion) : null,
        free: a.free === true,
        passthroughUnknown: a.passthroughUnknown === true,
      };
      const i = devProviders.findIndex((p) => p.name === name);
      if (i >= 0) devProviders[i] = entry; else devProviders.push(entry);
      return { ok: true, name };
    },
    'action:remove-provider': (a) => {
      const name = String(a.name ?? '').trim();
      const i = devProviders.findIndex((p) => p.name === name);
      if (i >= 0) devProviders.splice(i, 1);
      if (S.devDefaultProvider === name) S.devDefaultProvider = null;
      return { ok: true, name };
    },
    'action:set-default-provider': (a) => {
      const name = String(a.name ?? '').trim();
      if (!devProviders.some((p) => p.name === name)) return { ok: false, error: `Unknown provider "${name}".` };
      S.devDefaultProvider = name;
      return { ok: true, name };
    },
    'action:set-agent-model': (a) => {
      const role = String(a.role ?? '').trim();
      if (!role) return { ok: false, error: 'No role.' };
      const provider = String(a.provider ?? '').trim();
      const model = String(a.model ?? '').trim();
      const i = devAgentModels.findIndex((entry) => entry.role === role);
      if (!provider && !model) {
        if (i >= 0) devAgentModels.splice(i, 1);
      } else {
        const next = { role, provider: provider || null, model: model || null };
        if (i >= 0) devAgentModels[i] = next; else devAgentModels.push(next);
      }
      return { ok: true, role };
    },
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
    // MC-DESK — mirror of the host's sibling-safe nested writer for the Runtime /
    // Automations / Profiles panels (browser preview + Preview server).
    'action:set-cli-path': (a) => {
      const path = String(a.path ?? '').trim();
      const parts = path.split('.');
      if (!path || parts.some((s) => !s || s === '__proto__' || s === 'constructor' || s === 'prototype')) return { ok: false, error: 'Invalid config path.' };
      let cur: Record<string, unknown> = devCliKnobs;
      for (const part of parts.slice(0, -1)) {
        const nextVal = cur[part];
        if (!nextVal || typeof nextVal !== 'object' || Array.isArray(nextVal)) cur[part] = {};
        cur = cur[part] as Record<string, unknown>;
      }
      const leaf = parts[parts.length - 1];
      if (a.value === null || a.value === undefined) delete cur[leaf]; else cur[leaf] = a.value;
      return { ok: true, path };
    },
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
        id: `conn_demo${S.devConnectors.length + 1}`,
        source: a.source === 'github' ? 'github' : 'github',
        name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'GitHub connector',
        status: 'active',
        config: a.config && typeof a.config === 'object' && !Array.isArray(a.config) ? a.config as never : {},
        credential: a.credential && typeof a.credential === 'object' && !Array.isArray(a.credential) ? a.credential as never : { mode: 'dynamic', ref: 'gh' },
        flows: Array.isArray(a.flows) ? a.flows as never : ['load', 'checkpoint', 'slim', 'permission-sync'],
        workspaceRoot: S.wsCurrent,
        createdAt: now,
        updatedAt: now,
      } as ConnectorRecord;
      S.devConnectors = [rec, ...S.devConnectors];
      return { ok: true, connector: rec };
    },
    'action:connector-update': (a) => {
      const id = String(a.id ?? '');
      const patch = a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch) ? a.patch as Partial<ConnectorRecord> : {};
      let updated: ConnectorRecord | null = null;
      S.devConnectors = S.devConnectors.map((rec) => {
        if (rec.id !== id) return rec;
        updated = { ...rec, ...patch, id: rec.id, source: rec.source, workspaceRoot: rec.workspaceRoot, createdAt: rec.createdAt, updatedAt: new Date().toISOString() };
        return updated;
      });
      return updated ? { ok: true, connector: updated } : { ok: false, error: 'Connector not found.' };
    },
    'action:connector-delete': (a) => {
      const id = String(a.id ?? '');
      const before = S.devConnectors.length;
      S.devConnectors = S.devConnectors.filter((rec) => rec.id !== id);
      return { ok: before !== S.devConnectors.length };
    },
    'action:connector-export-definitions': () => {
      const bundle = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        connectors: S.devConnectors.map((connector) => ({
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
          workspaceRoot: S.wsCurrent,
          createdAt: now,
          updatedAt: now,
        })) as ConnectorRecord[];
        S.devConnectors = [...imported, ...S.devConnectors];
        return { ok: true, connectors: imported };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    'action:connector-validate': (a) => {
      const id = String(a.id ?? '');
      let checked: string[] = [];
      let updated: ConnectorRecord | null = null;
      S.devConnectors = S.devConnectors.map((rec) => {
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
      const existing = S.devConnectors.find((rec) => rec.id === id);
      if (!existing) return { ok: false, error: 'Connector not found.', errors: ['Connector not found.'] };
      const runCheckpoint = { highWatermark: now, repositories: [] as unknown[], completedAt: now, documentCount: 3, failureCount: 0 };
      const connector: ConnectorRecord = { ...existing, status: 'active', lastRunAt: now, lastSuccessAt: now, lastError: undefined, checkpoint: runCheckpoint, updatedAt: now };
      S.devConnectors = S.devConnectors.map((rec) => {
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
      const connector = S.devConnectors.find((rec) => rec.id === id);
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
      S.devConnectors = S.devConnectors.map((rec) => {
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
      const next = { ...(sessionModes[S.activeSession] ?? {}) };
      for (const key of ['executionMode', 'reviewPolicy', 'effort']) {
        if (key in a) {
          if (a[key] == null || a[key] === '') delete next[key];
          else next[key] = a[key];
        }
      }
      if (Object.keys(next).length === 0) delete sessionModes[S.activeSession];
      else sessionModes[S.activeSession] = next;
      return { ok: true, sessionKey: S.activeSession, sessionMode: { ...(sessionModes[S.activeSession] ?? {}) }, activeMode: effectivePrefs() };
    },
    'action:set-hook': () => ({ ok: true }),
    'action:set-access': (a) => ({ ok: true, mode: a.mode }),
    'action:reconnect-mcp': () => ({ ok: true }),
    'action:set-active-server': (a) => { const id = String(a.id ?? ''); if (devServers.some((s) => s.id === id && s.identity === 'brainrouter')) S.devActiveServer = id; return { ok: true, id }; },
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
    // PLUGIN-MARKETPLACE P4-desktop — canned registry + installed plugins so the
    // Marketplace panel renders populated in browser-dev (no Electron host).
    'plugin-list': () => ({
      plugins: [
        { name: 'acme-devkit', scope: 'user', version: '1.2.0', description: 'Skills, agents, and a review workflow for web dev.', author: 'Acme', category: 'development', enabled: true, provides: { skills: 3, agents: 1, workflows: 1 }, requiresConsent: false, shellApproved: false, mcpApproved: false, updateAvailable: '1.3.0' },
        { name: 'sec-hooks', scope: 'user', version: '0.4.0', description: 'Pre-commit secret scanners (command hooks).', author: 'SecOps', category: 'security', enabled: false, provides: { hooks: 2, mcpServers: 1 }, requiresConsent: true, shellApproved: false, mcpApproved: false },
      ],
      skippedForSafeMode: false,
      errors: [],
    }),
    'plugin-search': (a) => {
      const all = [
        { id: 'acme-devkit', name: 'acme-devkit', repo: 'git+https://github.com/acme/devkit.git', version: '1.3.0', category: 'development', tags: ['web', 'react'], stars: 128, lastUpdated: '2026-06-30', author: 'Acme', description: 'Skills, agents, and a review workflow for web dev.', provides: { skills: 3, agents: 1, workflows: 1 } },
        { id: 'sec-hooks', name: 'sec-hooks', repo: 'git+https://github.com/secops/hooks.git', version: '0.4.0', category: 'security', tags: ['security', 'hooks'], stars: 64, lastUpdated: '2026-06-12', author: 'SecOps', description: 'Pre-commit secret scanners (command hooks).', provides: { hooks: 2, mcpServers: 1 } },
        { id: 'jira-connector', name: 'jira-connector', repo: 'git+https://github.com/atlas/jira.git', version: '2.1.0', category: 'productivity', tags: ['jira', 'connector'], stars: 42, lastUpdated: '2026-05-20', author: 'Atlas', description: 'A Jira connector plus a Track-sync workflow.', provides: { connectors: 1, workflows: 1, skills: 1 } },
      ];
      const q = String(a.query ?? '').toLowerCase().trim();
      const cat = String(a.category ?? '').toLowerCase().trim();
      const hits = all
        .filter((e) => (!cat || e.category === cat) && (!q || e.name.includes(q) || e.tags.some((t) => t.includes(q)) || (e.description ?? '').toLowerCase().includes(q)))
        .map((entry) => ({ entry, score: q && entry.name.includes(q) ? 60 : 0 }));
      return { ok: true, hits, fromCache: false };
    },
    'plugin-consent': (a) => ({
      ok: true,
      action: a.action === 'enable' ? 'enable' : 'install',
      scope: a.scope === 'workspace' ? 'workspace' : 'user',
      summary: {
        name: String(a.name ?? 'plugin'),
        version: '1.0.0',
        provides: { skills: 3, agents: 1, hooks: String(a.name) === 'sec-hooks' ? 2 : 0, mcpServers: String(a.name) === 'sec-hooks' ? 1 : 0 },
        hookCommands: String(a.name) === 'sec-hooks' ? [{ label: 'PreToolUse', command: 'node scan.js', kind: 'command' }] : [],
        mcpCommands: String(a.name) === 'sec-hooks' ? [{ label: 'scanner', command: 'node server.js' }] : [],
        requiresConsent: String(a.name) === 'sec-hooks',
        shellApproved: false,
        mcpApproved: false,
        compatibilityWarnings: [],
        disclosure: `${String(a.name ?? 'plugin')} provides 3 skills, 1 agent.`,
      },
    }),
    'action:plugin-install': (a) => ({ ok: true, name: String(a.name ?? a.source ?? 'plugin') }),
    'action:plugin-enable': () => ({ ok: true }),
    'action:plugin-consent-set': () => ({ ok: true }),
    'action:plugin-remove': () => ({ ok: true }),
  };
  return queries;
}
