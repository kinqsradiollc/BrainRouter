// devBridge/commands.ts — installs window.brainrouter (send/onEvent/workspace APIs) and
// the __devEmitWs test hook. Extracted verbatim from installDevBridge(); closes over the
// shared dev state (./state) + the query map (./queries). Behavior-identical.
import type { AgentCommand, AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import type { DevState } from './state.js';
import {
  getDevWorkspaceManifest,
  previewDevWorkspaceOnboarding,
  saveDevWorkspaceManifest,
} from './onboarding.js';

export function installBridge(S: DevState, queries: Record<string, (args: Record<string, unknown>) => unknown>): void {
  const {
    listeners, recentsListeners, runningSessions, emit, devSessionModels, resolvedModel, trustedRoots, SESSIONS_BY_ROOT, mergeMeta,
    onboarding,
  } = S;
  (window as unknown as { brainrouter: unknown }).brainrouter = {
    // Demo workspace contexts so the activity-bar workspace switcher renders in
    // browser dev (Electron's preload provides the real org-scoped bridge).
    teams: {
      contexts: async () => [
        { orgId: 'org-dev-personal', name: 'BrainRouter Developer', isDefault: true, isPersonal: true },
        { orgId: 'org-dev-acme', name: 'Acme Corp', role: 'owner' },
      ],
      list: async () => [],
      get: async () => { throw new Error('Teams detail is unavailable in browser dev.'); },
      create: async () => { throw new Error('Teams are unavailable in browser dev.'); },
      addMember: async () => { throw new Error('Teams are unavailable in browser dev.'); },
      removeMember: async () => { throw new Error('Teams are unavailable in browser dev.'); },
      remove: async () => { throw new Error('Teams are unavailable in browser dev.'); },
    },
    getBootstrapState() {
      return {
        accountStatus: {
          signedIn: true,
          account: {
            url: 'http://localhost:3747',
            userId: 'dev-user',
            displayName: 'BrainRouter Developer',
            email: 'developer@brainrouter.local',
          },
        },
      };
    },
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
          const ts = S.activeSession;
          if (runningSessions.has(ts)) return; // one turn per chat (other chats run in parallel)
          runningSessions.add(ts);
          // Wave 1 — a user message is activity, but project order is stable.
          if (!S.wsRecents.includes(S.wsCurrent)) S.wsRecents = [...S.wsRecents, S.wsCurrent];
          recentsListeners.forEach((l) => l({ recents: S.wsRecents, reason: 'user-message', workspaceRoot: S.wsCurrent }));
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
          [600, 1100, 1700].forEach((d, i) => setTimeout(() => { S.devCtxUsed = 38_000 + (i + 1) * 18_000; }, d));
          setTimeout(() => {
            S.devCtxUsed = 92_000; // over the 80k compact threshold
            setTimeout(() => { emit({ kind: 'compaction', droppedMessages: 14, keptMessages: 6, summary: 'Summarized early exploration; kept the decision + sweep numbers.' }, 0, ts); S.devCtxUsed = 24_000; }, 250);
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
            emit({
              kind: 'child-complete',
              childId: 'agent-8b283dc5',
              role: 'worker',
              status: 'completed',
              receipt: {
                childId: 'agent-8b283dc5',
                role: 'worker',
                status: 'completed',
                completedAt: new Date().toISOString(),
              },
            }, 3200, ts);
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
          S.activeSession = 'dev:new-chat';
          S.devCtxUsed = 1_200; // DESK-5t — a fresh chat has ~no context
          emit({ kind: 'session-changed', sessionKey: 'dev:new-chat', loadedMessages: 0, model: S.devModel }, 60, 'dev:new-chat');
          return;
        case 'resume-session': {
          const key = (command as { sessionKey: string }).sessionKey;
          S.activeSession = key;
          // DESK-5t — each session has its OWN context size (per-key, mirrors
          // the host estimating the loaded history). Switching must change it.
          const perSession = 14_000 + (([...key].reduce((s, c) => s + c.charCodeAt(0), 0)) % 5) * 13_000;
          S.devCtxUsed = perSession;
          // Item 10 — a resumed chat reports ITS resolved model (per-session override or global).
          emit({ kind: 'session-changed', sessionKey: key, loadedMessages: 12, model: resolvedModel(key) }, 60, key);
          return;
        }
        case 'set-model': {
          const m = (command as { model: string }).model;
          const persist = (command as { persist?: boolean }).persist;
          if (m === 'auto') {
            delete devSessionModels[S.activeSession];
            emit({ kind: 'status', text: 'Model set to Auto (primary chain).' }, 60, S.activeSession);
            emit({ kind: 'session-changed', sessionKey: S.activeSession, loadedMessages: -1, model: resolvedModel(S.activeSession) }, 80, S.activeSession);
            return;
          }
          // Item 10 — persist:true → global default; persist:false → this chat only.
          if (persist) { S.devModel = m; delete devSessionModels[S.activeSession]; }
          else { devSessionModels[S.activeSession] = m; }
          emit({ kind: 'status', text: `Model set to ${m}${persist ? ' (saved to config.json — shared with the CLI)' : ' (this chat only)'}.` }, 60, S.activeSession);
          emit({ kind: 'session-changed', sessionKey: S.activeSession, loadedMessages: -1, model: resolvedModel(S.activeSession) }, 80, S.activeSession);
          return;
        }
        case 'interrupt':
          // DESK-5v — interrupt only the chat on screen; others keep running.
          emit({ kind: 'status', text: 'Interrupt requested.' }, 30, S.activeSession);
          emit({ kind: 'turn-error', message: 'Turn interrupted by user.' }, 200, S.activeSession);
          setTimeout(() => runningSessions.delete(S.activeSession), 210);
          return;
        default: return;
      }
    },
    onEvent(listener: (msg: AgentEventMessage) => void): () => void {
      listeners.add(listener);
      emit({ kind: 'status', text: 'Dev bridge online (browser preview — no Electron).' }, 50);
      // DESK-5u — mirror the host's boot behavior: open on a FRESH NEW CHAT
      // (a session-changed with loadedMessages 0), not a restored session.
      if (!S.bootAnnounced) {
        S.bootAnnounced = true;
        S.devCtxUsed = 1_200;
        S.activeSession = 'dev:new-chat';
        emit({ kind: 'session-changed', sessionKey: 'dev:new-chat', loadedMessages: 0, model: S.devModel }, 120, 'dev:new-chat');
      }
      return () => listeners.delete(listener);
    },
    addWorkspace: async () => ({ opened: false, workspaceRoot: '/Users/dev/new-project' }),
    workspaceRecents: async () => ({ current: S.wsCurrent, recents: S.wsRecents }),
    workspaceSessions: async (root: string, limit = 80) => {
      const rows = mergeMeta(root).slice(0, Math.max(1, Math.min(120, Number(limit) || 80)));
      return { rows: rows as Array<Record<string, unknown>>, truncated: rows.length >= limit };
    },
    onRecentsChanged: (l: (d: { recents: string[]; reason: string; workspaceRoot: string }) => void) => { recentsListeners.add(l); return () => recentsListeners.delete(l); },
    markActivity: async (root: string) => {
      if (!S.wsRecents.includes(root)) S.wsRecents = [...S.wsRecents, root].slice(0, 10);
      recentsListeners.forEach((l) => l({ recents: S.wsRecents, reason: 'commit', workspaceRoot: root }));
      return { ok: true };
    },
    reorderWorkspace: async (dragged: string, target: string) => {
      const from = S.wsRecents.indexOf(dragged);
      const to = S.wsRecents.indexOf(target);
      if (from >= 0 && to >= 0 && from !== to) {
        const next = [...S.wsRecents];
        const [item] = next.splice(from, 1);
        next.splice(from < to ? to - 1 : to, 0, item);
        S.wsRecents = next;
        recentsListeners.forEach((l) => l({ recents: S.wsRecents, reason: 'manual-reorder', workspaceRoot: dragged }));
      }
      return { recents: S.wsRecents };
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
      S.wsCurrent = root;
      if (!S.wsRecents.includes(root)) S.wsRecents = [...S.wsRecents, root].slice(0, 10);
      if (!SESSIONS_BY_ROOT[root]) SESSIONS_BY_ROOT[root] = [];
      emit({ kind: 'session-changed', sessionKey: `dev:${root.split('/').pop()}`, loadedMessages: 0, model: 'claude-opus-4-8' }, 350);
      return { opened: true };
    },
    // Browser development mirrors the main-process read/review/save contract in
    // memory, including opaque revisions and stale-write rejection.
    workspaceManifest: async (root: string) => getDevWorkspaceManifest(onboarding, root),
    previewWorkspaceOnboarding: async (root: string, payload: Record<string, unknown>) =>
      previewDevWorkspaceOnboarding(root, payload),
    saveWorkspaceManifest: async (root: string, payload: Record<string, unknown>) =>
      saveDevWorkspaceManifest(onboarding, root, payload),
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
      listeners.forEach((l) => l({ seq: ++S.seq, ts: Date.now(), sessionKey, event: { kind } as AgentEvent, workspaceRoot } as AgentEventMessage & { workspaceRoot: string }));
    };
}
