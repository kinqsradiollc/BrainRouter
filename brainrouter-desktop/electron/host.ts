/**
 * DESK-1 — the agent host process (Electron utilityProcess).
 *
 * THE SETTINGS-REUSE CONTRACT LIVES HERE: this bootstrap deep-imports the
 * unchanged brainrouter-cli runtime and boots it exactly like `brainrouter
 * chat` does — `loadConfig()` reads the SAME `~/.config/brainrouter/
 * config.json` (profiles, cli.* knobs, permissions, hooks), the MCP pool
 * connects the SAME server profiles, and all workspace state
 * (.brainrouter/cli/ sessions, workers, plans, goals) is shared with the CLI.
 * Sign in once, configure once — both heads see it.
 */
import { createBrokerPort, createHostCore, type AgentLike } from './hostCore.js';
import { exec, execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent } from '@kinqs/brainrouter-cli/dist/agent/agent.js';
import { loadConfig, saveConfig, getCliKnobs } from '@kinqs/brainrouter-cli/dist/config/config.js';
import { McpClientPool } from '@kinqs/brainrouter-cli/dist/runtime/mcpPool.js';
import { listTranscripts, loadTranscript, readTranscriptTail, transcriptExists, transcriptSizeBytes, deleteSession, forkSession, type TranscriptSummary } from '@kinqs/brainrouter-cli/dist/state/sessionStore.js';
import { resolveWorkspaceGit } from '@kinqs/brainrouter-cli/dist/config/workspaceGit.js';
import { readWorkspaceEntry, isWorkspaceDirectory } from './fsRead.js';
import { readSessionMetaAll, getSessionMeta, setSessionMeta, removeSessionMeta, listSessionGroups, type SessionMeta } from '@kinqs/brainrouter-cli/dist/state/sessionMetaStore.js';
import { getSessionRuntime, setSessionRuntime, resolveSessionRuntime, type ResolvedRuntime } from '@kinqs/brainrouter-cli/dist/state/sessionRuntimeStore.js';
import { loadSchedules, addSchedule, removeSchedule, setScheduleEnabled } from '@kinqs/brainrouter-cli/dist/state/scheduleStore.js';
import { parseCron, nextCronFire } from '@kinqs/brainrouter-cli/dist/runtime/cronParser.js';
import { applyRuleEdit } from '@kinqs/brainrouter-cli/dist/config/permissionRules.js';
import { parseReviewFindings, REVIEW_OUTPUT_CONTRACT, stripReasoning } from '@kinqs/brainrouter-cli/dist/orchestration/reviewFindings.js';
import { hashDiff, reviewGate, staleIfDiffChanged, type ReviewRun, type ReviewFinding, type Severity } from '@kinqs/brainrouter-cli/dist/orchestration/reviewModel.js';
import { getLatestReview, saveReview, updateReviewFinding } from '@kinqs/brainrouter-cli/dist/state/reviewStore.js';
import { getCliStateDir } from '@kinqs/brainrouter-cli/dist/state/cliState.js';
import { buildRecap } from '@kinqs/brainrouter-cli/dist/state/sessionRecap.js';
import { collectRunningTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundTasks.js';
import { contextWindowFor } from '@kinqs/brainrouter-cli/dist/runtime/contextWindow.js';
// DESK-4c — the command/settings surfaces reuse the CLI's own modules so the
// desktop never drifts from the terminal: same catalog, same preferences
// file, same hooks store, same transcript tooling.
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-cli/dist/cli/repl.js';
import { validateCatalogParity } from '@kinqs/brainrouter-cli/dist/runtime/catalogParity.js';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-cli/dist/state/preferencesStore.js';
import { readHooks, setHookEnabled } from '@kinqs/brainrouter-cli/dist/state/hooksStore.js';
import { searchTranscript } from '@kinqs/brainrouter-cli/dist/state/transcriptSearch.js';
import { exportTranscriptMarkdown, exportTranscriptJson, exportFileName } from '@kinqs/brainrouter-cli/dist/state/transcriptExport.js';
import { listChapters } from '@kinqs/brainrouter-cli/dist/state/chapterMarks.js';
import { buildUsageBreakdown } from '@kinqs/brainrouter-cli/dist/runtime/usageBreakdown.js';
// DESK-5 — the command bridge dispatches REPL-only commands against the SAME
// stores the terminal CLI uses. No parallel state: /goal here is /goal there.
import { readGoal, setGoal, clearGoal } from '@kinqs/brainrouter-cli/dist/state/goalStore.js';
import { readPlan, formatPlan } from '@kinqs/brainrouter-cli/dist/state/taskStore.js';
import { listWorkers, readWorkerSummary, readWorkerTranscript, readWorkerMeta } from '@kinqs/brainrouter-cli/dist/state/workerStore.js';
import { listSessions } from '@kinqs/brainrouter-cli/dist/orchestration/orchestrator.js';
import { readRun } from '@kinqs/brainrouter-cli/dist/state/workflowRun.js';
import { reconcileStaleBackgroundTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundReconcile.js';
import { childSessionKey } from '@kinqs/brainrouter-cli/dist/runtime/mcpUtils.js';

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/**
 * DESK-5c — real terminal sessions: a persistent interactive shell per
 * terminal panel (default shell on mac/linux, PowerShell on Windows),
 * stdout/stderr accumulated in a ring buffer the renderer polls with
 * `term-read {id, from}` — the same offset-poll contract as the CLI's
 * background-shell store. Not a full pty (raw-mode apps like vim won't
 * run), but a real stateful shell: cwd, env and history persist.
 */
interface TermSession { proc: ChildProcessWithoutNullStreams; buf: string; alive: boolean }
const TERM_BUF_CAP = 400_000;

/**
 * DESK-5c — live model list, same endpoint contract as the CLI wizard's
 * fetchOpenAiCompatibleModels (cli/wizard/modelsApi.ts, not imported here
 * because it pulls the ink picker): derive `GET <endpoint>/models` by
 * stripping the trailing /chat/completions, Bearer auth (literal "local"
 * when no key — the LM Studio/Ollama convention), 5s timeout,
 * `{ data: [{ id }] }` response shape.
 */
async function fetchEndpointModels(endpoint: string | undefined, apiKey: string): Promise<string[]> {
  const chat = (endpoint && endpoint.trim()) || 'https://api.openai.com/v1/chat/completions';
  const modelsUrl = chat.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(modelsUrl, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim() || 'local'}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return [...new Set((body.data ?? []).map((m) => m.id).filter((x): x is string => !!x))].sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DESK-5d — a session's resting state, read from the transcript tail:
 * an assistant tail means the turn finished ("done"); a user tail means the
 * turn never completed (interrupted / crashed → "needs a reply"). Tool
 * messages and named-user tool results are skipped, mirroring the
 * transcript renderer. Tail window only — transcripts can be megabytes.
 */
function lastTranscriptRole(filePath: string): 'user' | 'assistant' | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { role?: string; name?: string };
        if (e.role === 'assistant') return 'assistant';
        if (e.role === 'user' && !e.name) return 'user';
      } catch { /* the tail window may start mid-line */ }
    }
  } catch { /* unreadable */ }
  return undefined;
}

// DESK-5w — stale-task reconcile is the CLI's shared, unit-tested function
// (brainrouter-cli/src/runtime/backgroundReconcile.ts) so the boot path here is
// the exact code covered by backgroundReconcile.test.ts.

// DESK-5p/5w — a reconstructed transcript row: prose verbatim + collapsed tool
// groups. Shared by the main-session `transcript` query and the `task-transcript`
// query (child agents + workers), so a subagent reads like a normal chat.
// DESK-6t — each row carries `ts` (epoch ms) sourced from the persisted entry's
// own timestamp, so resumed history shows the REAL relative time ("3h ago"),
// not "just now". Undefined only for legacy entries without a timestamp.
type ReconRow =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'assistant'; text: string; ts?: number }
  | { kind: 'tool-group'; items: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }>; ts?: number };

/** Parse a persisted ISO `timestamp` to epoch ms; undefined when absent/bad. */
function entryTs(e: { timestamp?: unknown }): number | undefined {
  if (typeof e.timestamp !== 'string') return undefined;
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : undefined;
}

/** Reconstruct user/assistant prose + tool-group rows from OpenAI-format entries. */
function reconstructTranscriptRows(
  entries: Array<{ role?: string; content?: unknown; name?: string; tool_calls?: unknown[]; tool_call_id?: string; isError?: boolean; timestamp?: string }>,
): ReconRow[] {
  const rows: ReconRow[] = [];
  const callMeta = new Map<string, { name: string; args: Record<string, unknown> }>();
  let group: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }> | null = null;
  let groupTs: number | undefined;
  const flush = (): void => { if (group && group.length) rows.push({ kind: 'tool-group', items: group, ts: groupTs }); group = null; groupTs = undefined; };
  const firstLine = (s: string): string => {
    const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return line.replace(/\s+/g, ' ').slice(0, 90);
  };
  const summarize = (name: string, a: Record<string, unknown>, content: string): string => {
    const arg = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
    const primary = arg('path') ?? arg('command') ?? arg('query') ?? arg('pattern') ?? arg('url') ?? arg('targetFile');
    if (primary) return primary.slice(0, 120);
    return firstLine(content) || '(no output)';
  };
  for (const e of entries) {
    const text = typeof e.content === 'string' ? e.content : '';
    const ts = entryTs(e);
    if (e.role === 'user' && text.trim() && !e.name) {
      flush();
      rows.push({ kind: 'user', text: text.slice(0, 20_000), ts });
    } else if (e.role === 'assistant') {
      if (Array.isArray(e.tool_calls)) {
        for (const c of e.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>) {
          if (!c?.id) continue;
          let parsed: Record<string, unknown> = {};
          const raw = c.function?.arguments;
          try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>) ?? {}; } catch { /* unparseable */ }
          callMeta.set(c.id, { name: String(c.function?.name ?? 'tool'), args: parsed });
        }
      }
      if (text.trim()) { flush(); rows.push({ kind: 'assistant', text: text.slice(0, 40_000), ts }); }
    } else if (e.role === 'tool') {
      const meta = e.tool_call_id ? callMeta.get(e.tool_call_id) : undefined;
      const name = e.name ?? meta?.name ?? 'tool';
      const a = meta?.args ?? {};
      const filePath = /edit|write|patch|apply/i.test(name) && typeof a.path === 'string' ? (a.path as string) : undefined;
      if (!group) group = [];
      groupTs = ts ?? groupTs; // the group's time = its last tool's time
      group.push({ tool: name, summary: summarize(name, a, text), preview: text ? text.slice(0, 3_000) : undefined, ok: !e.isError, file: filePath });
    }
  }
  flush();
  return rows;
}

/**
 * DESK-5w — map a WORKER's event-log transcript (a different shape from the
 * OpenAI-format one: {role:'system'|'tool'|'assistant', event, tool, content})
 * to the same row shape, so a worker reads like a chat too. The spawn goal
 * becomes the opening "user" turn.
 */
function workerEventsToRows(entries: Array<Record<string, unknown>>): ReconRow[] {
  const rows: ReconRow[] = [];
  let group: Array<{ tool: string; summary: string; ok: boolean }> | null = null;
  let groupTs: number | undefined;
  const flush = (): void => { if (group && group.length) rows.push({ kind: 'tool-group', items: group, ts: groupTs }); group = null; groupTs = undefined; };
  for (const e of entries) {
    const role = String(e.role ?? '');
    const event = String(e.event ?? '');
    const content = typeof e.content === 'string' ? e.content : '';
    const ts = entryTs(e as { timestamp?: unknown }) ?? (typeof e.ts === 'string' ? (Number.isFinite(Date.parse(e.ts)) ? Date.parse(e.ts) : undefined) : undefined);
    if (role === 'system' && event === 'spawn') {
      flush();
      const goal = typeof e.goal === 'string' ? e.goal : '';
      if (goal) rows.push({ kind: 'user', text: goal.slice(0, 20_000), ts });
    } else if (role === 'tool' && event === 'end') {
      if (!group) group = [];
      groupTs = ts ?? groupTs;
      group.push({ tool: String(e.tool ?? 'tool'), summary: typeof e.summary === 'string' ? e.summary : '', ok: e.ok !== false });
    } else if ((role === 'assistant' || role === 'user') && content.trim()) {
      flush();
      rows.push({ kind: role === 'user' ? 'user' : 'assistant', text: content.slice(0, 40_000), ts });
    }
  }
  flush();
  return rows;
}

/**
 * DESK-6t — run a git command ASYNCHRONOUSLY and return stdout (captured even on
 * a non-zero exit — e.g. `git diff --no-index` exits 1 with the diff on stdout).
 * Async (execFile, not execFileSync) so a slow `git` never blocks the host's
 * single message loop and stall an unrelated New-chat / resume command behind it.
 */
function git(args: string[], cwd: string, opts?: { timeout?: number; maxBuffer?: number }): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf-8', timeout: opts?.timeout ?? 5_000, maxBuffer: opts?.maxBuffer ?? 8_000_000 },
      (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/** Sidebar row payload: transcript summary + the status the icons render. */
function sessionRows(root: string, limit: number): Array<TranscriptSummary & { lastRole?: string }> {
  return listTranscripts(root).slice(0, limit).map((s) => {
    const file = s.sessionDir
      ? path.join(s.sessionDir, s.fileName)
      : path.join(getCliStateDir(root), 'transcripts', s.fileName);
    return { ...s, lastRole: lastTranscriptRole(file) };
  });
}

async function main(): Promise<void> {
  const workspaceRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd();
  // DESK-6w (T4) — resolve how this workspace relates to its owning git repo
  // once (repo name, owning git root, subdir-vs-root). Workspace-scoped status/
  // diff run in workspaceRoot with a `-- .` pathspec: that limits results to the
  // workspace subtree (so a monorepo subfolder or a nested clone like openSrc/*
  // never pulls in unrelated parent changes) AND keeps paths workspace-relative
  // for the renderer. `workspaceGitScope` is for repo-root ops (worktrees) later.
  const wsGit = resolveWorkspaceGit(workspaceRoot);
  // DESK-5w — clear phantom "running" background tasks left by a previous,
  // now-dead host BEFORE anything queries the fleet (the renderer polls it on
  // boot). In-process actors don't survive a restart; their on-disk state does.
  try {
    const r = reconcileStaleBackgroundTasks(workspaceRoot);
    if (r.sessions + r.workers + r.runs > 0) {
      console.error(`[brainrouter-desktop host] reconciled stale tasks on boot: ${r.sessions} agents, ${r.workers} workers, ${r.runs} workflows`);
    }
  } catch { /* best-effort */ }
  // utilityProcess gives us process.parentPort; plain `node host.js` (dev
  // smoke) falls back to a console sink so the bootstrap is runnable solo.
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  const send = port
    ? (msg: unknown) => port.postMessage(msg)
    : (msg: unknown) => console.log(JSON.stringify(msg));

  // Identical boot recipe to `brainrouter chat` (index.ts): config → llm →
  // pool.connectAll(profiles) → Agent. Offline MCP does not block (same
  // semantics as the CLI's non-strict mode).
  const config = loadConfig();
  const llm = config.llm || { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
  const mcpClient = new McpClientPool();
  try {
    await mcpClient.connectAll(config.servers ?? {}, llm, { timeoutMs: 5_000 });
  } catch { /* offline-mode: local tools only, same as the CLI */ }

  // DESK-3 — the approval/choice port: agent asks become interaction-request
  // events; the renderer's dialogs answer them. Shares the hostCore broker so
  // interrupt/shutdown dismiss pending dialogs fail-closed.
  const broker = new InteractionBroker();
  // DESK-5v — interaction-request events ride a separate seq namespace AND
  // carry the ASKING agent's own sessionKey, so an approval raised by a
  // background turn surfaces against the right chat (same `send` wire).
  let portSeq = 1_000_000; // offset so port events never collide with core seq
  const emitPortFor = (
    sessionKey: string,
    e: { kind: 'interaction-request'; request: import('@kinqs/brainrouter-agent-protocol').InteractionRequest },
  ): void => send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: e });
  const agent = new Agent(mcpClient, llm, {
    workspaceRoot,
    launchCwd: workspaceRoot,
    interactionPort: createBrokerPort(broker, (e) => emitPortFor(agent.sessionKey, e)),
  });
  // DESK-5v — the agent the user is currently VIEWING. hostCore keeps a pool of
  // agents (one per running/active session) and tells us which is active via
  // onActiveAgentChange; every read-only query below reports THIS agent so the
  // ring/tokens/recap/transcript track the chat on screen, not a background one.
  let activeAgent = agent;
  // DESK-5v — an independent agent for a SECOND, concurrent session: shares the
  // one MCP pool / llm / broker but keeps its own history, counters and key, so
  // two chats can run turns at the same time.
  // Item 10 — the global runtime is the config.json LLM; a session can override
  // provider/model/endpoint (sessionRuntimeStore). spawnAgent resolves THIS
  // session's runtime so concurrent chats can run different models/providers.
  const globalRuntime: ResolvedRuntime = {
    provider: llm.provider, model: llm.model, endpoint: llm.endpoint, mcpProfiles: [],
  };
  const llmForSession = (sessionKey: string): typeof llm => {
    const resolved = resolveSessionRuntime(globalRuntime, undefined, getSessionRuntime(workspaceRoot, sessionKey));
    return { ...llm, provider: resolved.provider, model: resolved.model, endpoint: resolved.endpoint };
  };
  const spawnAgent = (sessionKey: string): AgentLike => {
    const a = new Agent(mcpClient, llmForSession(sessionKey), {
      workspaceRoot,
      launchCwd: workspaceRoot,
      interactionPort: createBrokerPort(broker, (e) => emitPortFor(a.sessionKey, e)),
    });
    a.sessionKey = sessionKey;
    return a as unknown as AgentLike;
  };
  // §6 — the local reviewer runs in an ISOLATED, READ-ONLY, NON-PROMPTING agent:
  //  - a deny-all interaction port (confirm→false, choice→null) that NEVER emits
  //    an interaction-request to the UI, so review can't pop an approval dialog;
  //  - read access mode (look-only: no file writes, no shell, no mutating tools).
  // Its review: sessionKey is filtered from the picker. Even if the model ignores
  // the "don't call tools" instruction, it fails closed instead of prompting.
  const spawnReviewer = (): AgentLike => {
    const a = new Agent(mcpClient, llmForSession('review'), {
      workspaceRoot,
      launchCwd: workspaceRoot,
      interactionPort: { confirm: async () => false, choice: async () => null },
    });
    a.sessionKey = `review:${Date.now().toString(36)}`;
    try { (a as { setAccessMode?: (m: string) => void }).setAccessMode?.('read'); } catch { /* older agent */ }
    return a as unknown as AgentLike;
  };

  // DESK-5c — terminal session registry + endpoint-models cache.
  const terms = new Map<string, TermSession>();
  let termSeq = 0;
  let modelsCache: { models: string[]; at: number } | null = null;
  // DESK-5d — PR state cache (gh is a network call; the sidebar refreshes often).
  let prCache: { at: number; pr: { number: number; state: string; title?: string } | null } | null = null;
  // DESK-6t — short-lived transcript-read cache. Resuming a session reads the
  // transcript (for lazy-load bookkeeping) and the renderer immediately reads it
  // AGAIN to render — this memo makes that a single read. Also stashes a token
  // estimate so the context ring is right on a lazily-resumed (not-yet-loaded)
  // chat. 3s TTL: long enough for resume→render, short enough to stay fresh.
  type TxEntry = { role?: string; content?: unknown; name?: string; tool_calls?: unknown[]; tool_call_id?: string; isError?: boolean; timestamp?: string };
  // Short-lived dedup cache for the FULL agent-continuation read (loadHistory).
  // The context-fill estimate no longer reads this (it uses transcriptSizeBytes),
  // so there's no O(n) token loop here anymore.
  const transcriptCache = new Map<string, { entries: TxEntry[]; at: number }>();
  const readTranscriptCached = (key: string): TxEntry[] => {
    const now = Date.now();
    const hit = transcriptCache.get(key);
    if (hit && now - hit.at < 3_000) return hit.entries;
    const entries = loadTranscript(workspaceRoot, key) as TxEntry[];
    transcriptCache.set(key, { entries, at: now });
    if (transcriptCache.size > 8) transcriptCache.delete(transcriptCache.keys().next().value as string);
    return entries;
  };

  // Review v2 helpers (shared by the review-* queries + the commit/push gate).
  const isoNow = (): string => new Date().toISOString();
  const collectWorkingDiff = async (): Promise<{ diff: string; files: string[] }> => {
    const changed = (await git(['status', '--porcelain', '--', '.'], workspaceRoot)).split('\n').filter(Boolean).slice(0, 30);
    const files = changed.map((l) => l.slice(3).trim());
    let diff = '';
    for (const f of files) {
      if (diff.length > 60_000) break;
      let d = await git(['diff', 'HEAD', '--', f], workspaceRoot, { maxBuffer: 4_000_000 });
      if (!d.trim()) d = await git(['diff', '--no-index', '--', '/dev/null', f], workspaceRoot, { maxBuffer: 4_000_000 });
      diff += `\n# ${f}\n${d.slice(0, 12_000)}`;
    }
    return { diff, files };
  };
  // Map the model's free-form severities onto the v2 scale.
  const SEV_MAP: Record<string, Severity> = { security: 'critical', critical: 'critical', bug: 'high', high: 'high', perf: 'medium', medium: 'medium', style: 'low', nit: 'low', low: 'low', info: 'info' };
  const runReview = async (): Promise<ReviewRun & { files: number }> => {
    const { diff, files } = await collectWorkingDiff();
    const base: ReviewRun = {
      id: `rev_${Date.now().toString(36)}`, workspaceRoot, repoRoot: wsGit.gitRoot ?? workspaceRoot,
      baseRef: 'HEAD', headRef: 'WORKTREE', diffHash: hashDiff(diff), createdAt: isoNow(), updatedAt: isoNow(),
      status: 'completed', summary: '', findings: [],
    };
    if (files.length === 0) { const r: ReviewRun = { ...base, summary: 'No working-tree changes to review.' }; saveReview(workspaceRoot, r); return { ...r, files: 0 }; }
    const prompt = `You are reviewing the uncommitted changes in this workspace before a commit/PR. Focus on real bugs, security issues, and performance problems introduced by the diff. Be concise.\n\nDiff:\n${diff.slice(0, 60_000)}\n\n${REVIEW_OUTPUT_CONTRACT}`;
    // §6 — isolated, read-only, non-prompting reviewer (review: session filtered).
    const reviewer = spawnReviewer();
    const noop = (): void => {};
    const cb = { onStatusUpdate: noop, onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop, onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop } as never;
    let answer = '';
    try { answer = await (reviewer as { runTurn(p: string, c: unknown): Promise<string> }).runTurn(prompt, cb); }
    catch (err) { const r: ReviewRun = { ...base, status: 'failed', summary: `Review failed: ${err instanceof Error ? err.message : String(err)}` }; saveReview(workspaceRoot, r); return { ...r, files: files.length }; }
    const findings: ReviewFinding[] = parseReviewFindings(answer).map((f, i) => ({
      id: `f${i}_${Date.now().toString(36)}`, file: f.file, line: f.line ?? undefined, endLine: f.endLine ?? undefined,
      severity: SEV_MAP[String(f.severity ?? '').toLowerCase()] ?? 'medium',
      confidence: f.confidence ?? 70, summary: f.summary,
      details: f.details, suggestion: f.suggestion, codeExcerpt: f.codeExcerpt, diffHunk: f.diffHunk,
      patch: f.patch, status: 'open', canApply: !!f.patch, source: 'ai-review',
    }));
    // Strip the model's <think> reasoning so it never shows as the summary; when
    // there are no findings the empty-state covers it, so leave the summary blank.
    const visible = stripReasoning(answer).split('```')[0].trim();
    const summary = findings.length === 0 ? '' : (visible.slice(0, 400) || `${findings.length} finding(s) across ${files.length} file(s).`);
    const run: ReviewRun = { ...base, summary, findings };
    saveReview(workspaceRoot, run);
    return { ...run, files: files.length };
  };
  const reviewSnapshot = async (): Promise<{ run: ReviewRun | null; gate: ReturnType<typeof reviewGate>; diffHash: string; files: number }> => {
    const { diff, files } = await collectWorkingDiff();
    const diffHash = hashDiff(diff);
    let run = getLatestReview(workspaceRoot);
    if (run) { const staled = staleIfDiffChanged(run, diffHash); if (staled !== run) { saveReview(workspaceRoot, staled); run = staled; } }
    return { run, gate: reviewGate(run, diffHash), diffHash, files: files.length };
  };

  const core = createHostCore({
    agent,
    spawnAgent,
    onActiveAgentChange: (a) => { activeAgent = a as unknown as typeof agent; },
    send: send as never,
    broker,
    loadTranscript: (key) => readTranscriptCached(key), // FULL — agent continuation only
    transcriptExists: (key) => transcriptExists(workspaceRoot, key), // OOM-safe cheap resume count
    persistModel: (model) => {
      // Both heads read this file — a model picked in the desktop settings is
      // the CLI's model on its next launch, and vice versa.
      const fresh = loadConfig();
      fresh.llm = { ...(fresh.llm ?? llm), model };
      saveConfig(fresh);
    },
    // Item 10 — per-session model: read on (re)spawn so a chat keeps its model;
    // written when set-model arrives with persist:false ("this chat only").
    getSessionModel: (sessionKey) => getSessionRuntime(workspaceRoot, sessionKey).model || undefined,
    setSessionModel: (sessionKey, model) => { setSessionRuntime(workspaceRoot, sessionKey, { model }); },
    queries: {
      // Read-only surfaces — same pure modules the TUI commands use.
      // DESK-6m — sidebar sessions merged with their UI meta (title override,
      // pinned/archived/status/group) and sorted pinned-first; the renderer's
      // per-chat ⋮ menu reads/writes this meta.
      'list-sessions': () => {
        const meta = readSessionMetaAll(workspaceRoot);
        const rows = sessionRows(workspaceRoot, 80).map((s) => {
          const m = meta[s.sessionKey] ?? {};
          return {
            ...s,
            firstUserMessage: m.title || s.firstUserMessage, // title overrides the snippet
            pinned: !!m.pinned, archived: !!m.archived, status: m.status ?? 'active', group: m.group ?? null,
            forkedFrom: m.forkedFrom ?? null, // DESK-6u — lineage for the fork icon + back-link

          };
        });
        // pinned first, then the store's recency order (sessionRows already sorts).
        return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      },
      // DESK-5d — another project's chat history, for the sidebar's expanded
      // project folders. Read-only transcript summaries; the trust gate still
      // guards SWITCHING into the workspace.
      'workspace-sessions': (args) => {
        const root = typeof args.root === 'string' ? args.root : '';
        if (!root || !fs.existsSync(root)) return [];
        try { return sessionRows(root, 20); } catch { return []; }
      },
      // DESK-5d — current branch's PR, for the project-row status chip.
      // Quietly null when gh is missing, unauthenticated, or there is no PR.
      'git-pr': async () => {
        const now = Date.now();
        if (prCache && now - prCache.at < 60_000) return { pr: prCache.pr };
        const pr = await new Promise<{ number: number; state: string; title?: string } | null>((resolve) => {
          exec('gh pr view --json number,state,title', { cwd: workspaceRoot, timeout: 4_000, maxBuffer: 200_000 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            try {
              const j = JSON.parse(stdout) as { number?: number; state?: string; title?: string };
              resolve(typeof j.number === 'number' ? { number: j.number, state: String(j.state ?? 'OPEN'), title: j.title } : null);
            } catch { resolve(null); }
          });
        });
        prCache = { at: now, pr };
        return { pr };
      },
      'recap': (args) => {
        const key = typeof args.sessionKey === 'string' ? args.sessionKey : activeAgent.sessionKey;
        // OOM-safe: recap summarizes recent state — a bounded tail is enough.
        return buildRecap({ entries: readTranscriptTail(workspaceRoot, key, 2000), sessionKey: key });
      },
      // DESK-5w — running background tasks, each TAGGED with the chat session
      // that owns it (parentSessionKey), so the renderer can nest a task under
      // its session and never leak one session's tasks into another's view.
      'fleet': () => {
        const tasks = collectRunningTasks(workspaceRoot) as Array<{ kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean }>;
        const sessions = listSessions(workspaceRoot);
        const workers = listWorkers(workspaceRoot);
        return tasks.map((t) => {
          let parentSessionKey: string | null = null;
          if (t.kind === 'agent') parentSessionKey = sessions.find((s) => s.id === t.id)?.parentSessionKey ?? null;
          else if (t.kind === 'worker') parentSessionKey = workers.find((w) => w.id === t.id)?.parentSessionKey ?? null;
          return { ...t, parentSessionKey };
        });
      },
      // DESK-5l — live model, not the boot-time snapshot: session-info runs on
      // every sidebar refresh, and returning stale llm.model used to stomp the
      // UI back to the old model right after a switch.
      'session-info': () => ({ sessionKey: activeAgent.sessionKey, model: activeAgent.getModel?.() ?? llm.model, workspaceRoot, username: os.userInfo().username }),
      // DESK-4d — the home/greeting view: real numbers from the workspace's
      // persisted transcripts (sessions, messages, active days, streaks, and
      // a per-day activity map for the heatmap).
      'home-stats': () => {
        const transcripts = listTranscripts(workspaceRoot).slice(0, 200);
        let turns = 0;
        const perDay = new Map<string, number>();
        for (const t of transcripts) {
          turns += t.turnCount;
          const ts = new Date(t.modifiedAt);
          if (!Number.isNaN(ts.getTime())) {
            const day = ts.toISOString().slice(0, 10);
            perDay.set(day, (perDay.get(day) ?? 0) + t.turnCount);
          }
        }
        // streaks over the per-day activity map
        const today = new Date();
        const dayKey = (offset: number) => {
          const d = new Date(today);
          d.setDate(d.getDate() - offset);
          return d.toISOString().slice(0, 10);
        };
        let current = 0;
        for (let i = 0; perDay.has(dayKey(i)); i++) current++;
        let longest = 0, run = 0;
        for (let i = 0; i < 365; i++) {
          if (perDay.has(dayKey(i))) { run++; longest = Math.max(longest, run); } else run = 0;
        }
        return {
          sessions: transcripts.length,
          turns,
          activeDays: perDay.size,
          currentStreak: current,
          longestStreak: longest,
          model: activeAgent.getModel?.() ?? llm.model,
          perDay: Object.fromEntries(perDay),
        };
      },
      // DESK-4c — workspace browsing panels. (DESK-6t — async git, non-blocking.)
      'list-files': async () => {
        const tracked = await git(['ls-files'], workspaceRoot);
        const untracked = await git(['ls-files', '--others', '--exclude-standard'], workspaceRoot);
        const all = (tracked + '\n' + untracked).split('\n').filter(Boolean).sort();
        return { files: all.slice(0, 3000), truncated: all.length > 3000 };
      },
      // DESK-6w (T9) — directory-aware: a folder path returns a typed listing
      // instead of the old raw EISDIR. Pure logic lives in fsRead.ts (tested).
      'read-file': (args) => readWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : ''),
      // DESK-4j — branch picker (pattern: branch chip with dropdown in the
      // composer context row). Listing is read-only; checkout runs through
      // the same user-command path as the terminal input.
      'git-branches': async () => {
        const out = await git(['branch', '--list', '--sort=-committerdate'], workspaceRoot);
        const branches = out.split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim()).filter(Boolean).slice(0, 20);
        const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
        return { current: current || null, branches };
      },
      // DESK-4m — recent commit subjects for the Environment panel.
      'git-log': async () => ({ subjects: (await git(['log', '-5', '--pretty=%s'], workspaceRoot)).split('\n').filter(Boolean) }),
      'git-info': async () => {
        // DESK-6w (T4) — repo name from the OWNING git root (so a subdir workspace
        // shows "BrainRouter", not "brainrouter-desktop"); diff scoped to the
        // workspace subtree (`-- .`) so a monorepo subfolder doesn't report the
        // parent's churn. workspaceRoot/gitRoot/repoRelativePath feed the env panel.
        const base = {
          repo: wsGit.repoName, workspaceRoot, gitRoot: wsGit.gitRoot,
          repoRelativePath: wsGit.repoRelativePath, isSubdir: wsGit.isSubdir,
        };
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
        if (!branch) return { ...base, branch: null, files: 0, insertions: 0, deletions: 0 };
        const stat = await git(['diff', 'HEAD', '--shortstat', '--', '.'], workspaceRoot);
        return {
          ...base, branch,
          files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0),
          insertions: Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0),
          deletions: Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0),
        };
      },
      // DESK-4 — diff/review surfaces. git-backed, tolerant of non-repos.
      // DESK-6w (T4) — `-- .` scopes to the workspace subtree with workspace-
      // relative paths (so file-open/diff resolution is unchanged).
      'changed-files': async () => (await git(['status', '--porcelain', '--', '.'], workspaceRoot))
        .split('\n').filter(Boolean).slice(0, 200).map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3).trim() })),
      'file-diff': async (args) => {
        const file = typeof args.path === 'string' ? args.path : '';
        if (!file) return { path: file, diff: '' };
        // DESK-6w (T9) — a directory has no single-file diff; return a typed
        // payload rather than letting `git diff --no-index` misbehave on a folder.
        if (isWorkspaceDirectory(workspaceRoot, file)) return { path: file, kind: 'directory', diff: '' };
        // HEAD diff covers staged + unstaged; untracked files get a synthetic add-diff
        // (git diff --no-index exits 1 but its stdout — captured by `git` — IS the diff).
        let diff = await git(['diff', 'HEAD', '--', file], workspaceRoot, { maxBuffer: 4_000_000 });
        if (!diff.trim()) diff = await git(['diff', '--no-index', '--', '/dev/null', file], workspaceRoot, { maxBuffer: 4_000_000 });
        return { path: file, kind: 'file', diff: diff.slice(0, 200_000) };
      },
      // T13 — git worktrees (repo-level, so operate on the git root). The host
      // returns the raw porcelain; the renderer owns the (tested) parser.
      'git-worktrees': async () => {
        const root = wsGit.gitRoot ?? workspaceRoot;
        const raw = await git(['worktree', 'list', '--porcelain'], root);
        return { raw, gitRoot: root, current: workspaceRoot };
      },
      'worktree-diff': async (args) => {
        const wtPath = typeof args.path === 'string' ? args.path : '';
        if (!wtPath || !fs.existsSync(wtPath)) return { path: wtPath, diff: '', files: 0 };
        const diff = await git(['diff', 'HEAD'], wtPath, { maxBuffer: 4_000_000 });
        const stat = await git(['diff', 'HEAD', '--shortstat'], wtPath);
        return { path: wtPath, diff: diff.slice(0, 200_000), files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) };
      },
      'worktree-create': async (args) => {
        const name = String(args.name ?? '').trim();
        const ref = String(args.ref ?? '').trim() || 'HEAD';
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return { ok: false, error: 'Name must be letters, digits, dash, underscore or dot.' };
        const root = wsGit.gitRoot ?? workspaceRoot;
        const wtPath = path.join(root, '.worktrees', name);
        // execFile-based git() never invokes a shell, so name/ref aren't shell-expanded.
        const out = await git(['worktree', 'add', wtPath, ref], root);
        if (!fs.existsSync(wtPath)) return { ok: false, error: out.trim() || `Failed to create worktree "${name}".` };
        return { ok: true, path: wtPath };
      },
      'worktree-remove': async (args) => {
        const wtPath = String(args.path ?? '').trim();
        const root = wsGit.gitRoot ?? workspaceRoot;
        if (!wtPath) return { ok: false, error: 'No worktree path.' };
        await git(['worktree', 'remove', '--force', wtPath], root);
        await git(['worktree', 'prune'], root);
        return { ok: !fs.existsSync(wtPath) };
      },
      // T12 / Review v2 — local AI review of the working tree. Gathers the diff,
      // runs ONE ephemeral review turn in an ISOLATED review: session (filtered
      // from the session picker — never pollutes the user's chats), parses
      // structured findings into a ReviewRun keyed by the diff hash, and persists
      // it (reviewStore, shared with the CLI). Returns the run (+ files count for
      // the panel). Real LLM required; the parser/model/gate are unit-tested.
      'review-diff': async () => runReview(),
      'review-rerun': async () => runReview(),
      // Lightweight: the gate + current run for the diff on disk right now. Marks
      // a prior run stale if the working diff changed since it ran.
      'review-current': async () => reviewSnapshot(),
      'review-status': async () => { const s = await reviewSnapshot(); return { status: s.gate.status, blocked: s.gate.blocked, reason: s.gate.reason }; },
      'review-gate': async () => reviewSnapshot(),
      'review-dismiss-finding': (a) => ({ ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), 'dismissed', isoNow()) }),
      'review-resolve-finding': (a) => ({ ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), 'fixed', isoNow()) }),
      'review-apply-suggestion': async (a) => {
        // Best-effort: apply the finding's unified-diff patch with `git apply`.
        const run = getLatestReview(workspaceRoot);
        const f = run?.findings.find((x) => x.id === String(a.id ?? ''));
        if (!f?.patch) return { ok: false, error: 'This finding has no applicable patch — use "Ask agent to fix" instead.' };
        const tmp = path.join(getCliStateDir(workspaceRoot), `review-${Date.now().toString(36)}.patch`);
        try {
          fs.writeFileSync(tmp, f.patch.endsWith('\n') ? f.patch : f.patch + '\n');
          const check = await git(['apply', '--check', tmp], wsGit.gitRoot ?? workspaceRoot);
          await git(['apply', tmp], wsGit.gitRoot ?? workspaceRoot);
          fs.rmSync(tmp, { force: true });
          updateReviewFinding(workspaceRoot, f.id, 'applied', isoNow());
          return { ok: true };
        } catch (err) {
          try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
          return { ok: false, error: `Patch did not apply cleanly — use "Ask agent to fix". (${err instanceof Error ? err.message : err})` };
        }
      },
      // DESK-4c — every CLI slash command, straight from the CLI's catalog.
      'commands-catalog': () => {
        // T16 — surface catalog drift at runtime (not just in tests): the desktop
        // serves the CLI's own lists, so any drift here is a real regression.
        const parity = validateCatalogParity(SLASH_COMMANDS, HELP_CATEGORIES);
        return { categories: HELP_CATEGORIES, all: [...SLASH_COMMANDS], parityValid: parity.valid, parityErrors: parity.errors };
      },
      // T14 — scheduler: read/manage the CLI scheduleStore (same schedules.json
      // the /schedule REPL command uses). Filtered to the viewed session's owner.
      'schedule-list': () => loadSchedules(workspaceRoot).filter((s) => s.owner === activeAgent.sessionKey),
      'schedule-add': (a) => {
        const kind = a.kind === 'once' ? 'once' : 'cron';
        const expr = String(a.expr ?? '').trim();
        const command = String(a.command ?? '').trim();
        if (!command.startsWith('/')) return { ok: false, error: 'Command must start with "/".' };
        let nextRun: string;
        if (kind === 'cron') {
          const cron = parseCron(expr);
          if (!cron) return { ok: false, error: `Invalid cron expression: "${expr}" (need 5 fields).` };
          nextRun = nextCronFire(cron, new Date()).toISOString();
        } else {
          const at = new Date(expr);
          if (Number.isNaN(at.getTime())) return { ok: false, error: `Invalid date/time: "${expr}".` };
          nextRun = at.toISOString();
        }
        const rec = addSchedule(workspaceRoot, { kind, expr, command, owner: activeAgent.sessionKey, nextRun, enabled: true });
        return { ok: true, schedule: rec };
      },
      'schedule-remove': (a) => ({ ok: removeSchedule(workspaceRoot, String(a.id ?? '')) }),
      'schedule-toggle': (a) => ({ ok: setScheduleEnabled(workspaceRoot, String(a.id ?? ''), a.enabled !== false), enabled: a.enabled !== false }),
      // DESK-4c — one snapshot powering the whole Settings dialog. All values
      // come from the stores the CLI itself reads/writes.
      'config-snapshot': () => {
        const fresh = loadConfig();
        const cli = (fresh as { cli?: { permissions?: { allow?: string[]; deny?: string[] }; sandbox?: 'on' | 'off'; fallbackModel?: string | null } }).cli;
        return {
          model: fresh.llm?.model ?? llm.model,
          provider: fresh.llm?.provider ?? llm.provider,
          fallbackModel: cli?.fallbackModel ?? null,
          workspaceRoot,
          sandbox: cli?.sandbox ?? 'off',
          prefs: readPreferences(workspaceRoot),
          permissionRules: { allow: cli?.permissions?.allow ?? [], deny: cli?.permissions?.deny ?? [] },
          hooks: readHooks(workspaceRoot),
          servers: mcpClient.getStatuses().map((s) => ({ id: s.serverId, online: s.status === 'connected', detail: s.identity !== 'unknown' ? s.identity : undefined })),
        };
      },
      'usage-breakdown': () => buildUsageBreakdown({ parent: activeAgent.sessionUsage, children: [], offload: undefined }),
      // DESK-5r — context fill for the composer ring. `used` is the agent's
      // authoritative last prompt_tokens (the live context size, updated after
      // every LLM call within a turn). The ring fills toward the AUTO-COMPACT
      // threshold — the point where BrainRouter summarizes old history and the
      // context RESETS — because that's the operative limit the user feels (the
      // raw model window is shown too, for context). After a compaction the
      // agent clears lastSeenPromptTokens, so `used` drops and the ring resets.
      'context-usage': () => {
        // getCurrentContextTokens() = last authoritative prompt_tokens OR a
        // content estimate of the CURRENT chatHistory — so right after a
        // session switch (history loaded, no LLM call yet) it reflects THIS
        // session's size instead of the previous one's stale count.
        const a = activeAgent as unknown as { getCurrentContextTokens?: () => number; lastSeenPromptTokens?: number };
        // DESK-6t — with LAZY history, a freshly-resumed chat hasn't loaded its
        // transcript into the agent yet, so the agent estimate would read ~0.
        // Fall back to the resumed transcript's token estimate (from the cache
        // populated on resume) so the ring isn't wrong while you're browsing.
        const agentTokens = Number(a.getCurrentContextTokens?.() ?? a.lastSeenPromptTokens ?? 0);
        // OOM-safe ring estimate: a lazily-resumed chat hasn't loaded history into
        // the agent yet, so approximate context from the transcript's BYTE SIZE
        // (~4 bytes/token) — O(1), no content read, no cache dependency. The
        // agent's authoritative prompt_tokens takes over once a turn runs.
        const sizeEstimate = Math.round(transcriptSizeBytes(workspaceRoot, activeAgent.sessionKey) / 4);
        const used = Math.max(agentTokens, sizeEstimate);
        const model = activeAgent.getModel?.() ?? llm.model;
        const window = contextWindowFor(model) ?? 0;
        const compactAt = getCliKnobs().autoCompactTokens || 80_000;
        const limit = compactAt > 0 ? compactAt : window;
        return { used, window, compactAt, limit, pct: limit > 0 ? Math.min(1, used / limit) : 0 };
      },
      'search-transcript': (args) => {
        const query = typeof args.q === 'string' ? args.q : '';
        // OOM-safe: search a bounded recent window (50 capped results anyway).
        return searchTranscript(readTranscriptTail(workspaceRoot, activeAgent.sessionKey, 5000), query, { limit: 50 })
          .map((m) => ({ index: (m as { index?: number }).index ?? 0, role: (m as { role?: string }).role ?? '?', snippet: (m as { snippet?: string }).snippet ?? '' }));
      },
      'chapters': () => listChapters(readTranscriptTail(workspaceRoot, activeAgent.sessionKey, 2000)),
      // DESK-5p — render a resumed session's FULL history: user/assistant prose
      // verbatim AND the real tool calls (name + arg-derived summary + output
      // preview + ok), reconstructed from the persisted OpenAI-format entries
      // (assistant `tool_calls` request the call; the `tool` result message
      // carries name + content + isError). Consecutive tool activity collapses
      // into one tool-group row, exactly like the live stream — so the resumed
      // view shows the same expandable tool cards instead of a bare count.
      'transcript': (args) => {
        const key = typeof args.sessionKey === 'string' ? args.sessionKey : activeAgent.sessionKey;
        // OOM-safe: bounded TAIL read (not the full-history cache) — the UI only
        // renders the last 400 rows, so ~1200 recent entries is plenty and the
        // host never allocates a multi-megabyte transcript for rendering.
        const entries = readTranscriptTail(workspaceRoot, key, 1200) as Parameters<typeof reconstructTranscriptRows>[0];
        return { sessionKey: key, rows: reconstructTranscriptRows(entries).slice(-400) };
      },
      // DESK-5w — the conversation of a background task (a delegated child agent
      // OR a worker), reconstructed like a normal chat. The renderer opens this
      // read-only when you click a task nested under its session, so you can see
      // exactly what a subagent is doing and what it has said/done so far.
      'task-transcript': (args) => {
        const kind = typeof args.kind === 'string' ? args.kind : 'agent';
        const id = typeof args.id === 'string' ? args.id : '';
        const parent = typeof args.parentSessionKey === 'string' ? args.parentSessionKey : '';
        if (kind === 'worker') {
          const meta = readWorkerMeta(workspaceRoot, id);
          const raw = readWorkerTranscript(workspaceRoot, id, 400) as Array<Record<string, unknown>>;
          return { id, kind, role: meta?.role, goal: meta?.goal, status: meta?.status, rows: workerEventsToRows(raw) };
        }
        // Child agent: its history lives at childSessionKey(parent, id); an
        // isolated-worktree child persists under its own childWorkspaceRoot.
        const session = listSessions(workspaceRoot).find((s) => s.id === id);
        const childKey = parent ? childSessionKey(parent, id) : id;
        const readRoot = session?.childWorkspaceRoot ?? workspaceRoot;
        // OOM-safe: bounded tail (the task view renders the last 400 rows).
        const entries = readTranscriptTail(readRoot, childKey, 1200) as Parameters<typeof reconstructTranscriptRows>[0];
        return { id, kind, role: session?.role, goal: session?.prompt, status: session?.status, rows: reconstructTranscriptRows(entries).slice(-400) };
      },
      // DESK-6w — a workflow run's full breakdown for the Claude-/workflows-style
      // card: each phase with its spawned child AGENTS resolved to live stats
      // (role/label/status + tokens, tool calls, wall-clock). Step-based runs
      // (no phases) fall back to a flat step list.
      'workflow-detail': (args) => {
        const slug = typeof args.slug === 'string' ? args.slug : '';
        const run = readRun(workspaceRoot, slug);
        if (!run) return null;
        const byId = new Map(listSessions(workspaceRoot).map((s) => [s.id, s]));
        const resolveAgents = (childIds: string[]) => childIds.map((id) => {
          const s = byId.get(id);
          const tokens = (s?.usage?.promptTokens ?? 0) + (s?.usage?.completionTokens ?? 0);
          const started = s?.startedAt ? new Date(s.startedAt).getTime() : 0;
          const ended = s?.completedAt ? new Date(s.completedAt).getTime() : Date.now();
          const ms = s?.usage?.wallClockMs ?? (started ? Math.max(0, ended - started) : 0);
          return { id, label: s?.label || s?.role || id, role: s?.role ?? '?', status: s?.status ?? 'unknown', tokens, tools: s?.usage?.calls ?? 0, ms };
        });
        const phases = (run.phases ?? []).map((p) => ({ id: p.id, title: p.title, status: p.status, agents: resolveAgents(p.childIds ?? []) }));
        const steps = (!run.phases || run.phases.length === 0) ? run.steps.map((st) => ({ id: st.id, title: st.title, status: st.status })) : [];
        let totalAgents = 0, totalTokens = 0;
        for (const p of phases) { totalAgents += p.agents.length; for (const a of p.agents) totalTokens += a.tokens; }
        return { slug: run.slug, kind: run.kind, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, phases, steps, totalAgents, totalTokens };
      },
      'export-chat': (args) => {
        const format = args.format === 'json' ? 'json' : 'md';
        const entries = loadTranscript(workspaceRoot, activeAgent.sessionKey);
        const exportedAt = new Date().toISOString();
        const meta = { sessionKey: activeAgent.sessionKey, exportedAt };
        return {
          filename: exportFileName(activeAgent.sessionKey, format, exportedAt),
          content: format === 'json' ? exportTranscriptJson(entries, meta) : exportTranscriptMarkdown(entries, meta),
        };
      },
      // DESK-4e — content search (the Files panel's "?text" mode, observed).
      'search-content': async (args) => {
        const query = typeof args.q === 'string' ? args.q : '';
        if (!query.trim()) return [];
        const out = await git(['grep', '-n', '-I', '--max-count', '3', '--', query], workspaceRoot, { timeout: 8_000, maxBuffer: 4_000_000 });
        return out.split('\n').filter(Boolean).slice(0, 50).map((line) => {
          const [file, ln, ...rest] = line.split(':');
          return { file, line: Number(ln) || 0, snippet: rest.join(':').trim().slice(0, 160) };
        });
      },
      // DESK-4e — "Always allow" on inline approval cards persists a glob rule
      // into the SAME cli.permissions store the CLI's policy gate evaluates.
      'action:allow-rule': (args) => {
        const rule = typeof args.rule === 'string' ? args.rule.trim() : '';
        if (!rule) throw new Error('Empty permission rule.');
        const fresh = loadConfig() as { cli?: { permissions?: { allow?: string[]; deny?: string[] } } };
        fresh.cli = fresh.cli ?? {};
        fresh.cli.permissions = fresh.cli.permissions ?? {};
        const allow = (fresh.cli.permissions.allow = fresh.cli.permissions.allow ?? []);
        if (!allow.includes(rule)) allow.push(rule);
        saveConfig(fresh as never);
        return { ok: true, rule };
      },
      // T7 — full permission-rules editor (add/remove on allow OR deny), via the
      // pure tested applyRuleEdit. Shared config.json — the CLI gate reads it too.
      'action:rule-edit': (args) => {
        const op = args.op === 'remove' ? 'remove' : 'add';
        const kind = args.kind === 'deny' ? 'deny' : 'allow';
        const rule = typeof args.rule === 'string' ? args.rule : '';
        if (op === 'add' && !rule.trim()) throw new Error('Empty permission rule.');
        const fresh = loadConfig() as { cli?: { permissions?: { allow?: string[]; deny?: string[] } } };
        fresh.cli = fresh.cli ?? {};
        fresh.cli.permissions = applyRuleEdit(fresh.cli.permissions, op, kind, rule);
        saveConfig(fresh as never);
        return { ok: true, permissions: fresh.cli.permissions };
      },
      // DESK-4e — user-typed terminal commands (the Terminal panel's input
      // row). Equivalent to the CLI's `!` shell escape: the USER runs it, so
      // no approval gate; cwd is the workspace.
      'action:term-exec': (args) => {
        const cmd = typeof args.cmd === 'string' ? args.cmd : '';
        if (!cmd.trim()) return { out: '', code: 0 };
        return new Promise((resolve) => {
          exec(cmd, { cwd: workspaceRoot, timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
            resolve({
              out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20_000),
              code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code : err ? 1 : 0,
            });
          });
        });
      },
      // DESK-5 — the command bridge. Each case mirrors the REPL command's
      // behavior using the CLI's own store modules; output is plain lines the
      // renderer shows as a command-output block in the chat.
      'command:dispatch': async (args) => {
        const cmd = String(args.cmd ?? '');
        const rest = typeof args.args === 'string' ? args.args.trim() : '';
        switch (cmd) {
          case 'goal': {
            if (rest === 'clear') { clearGoal(workspaceRoot, activeAgent.sessionKey); return { lines: ['Goal cleared.'] }; }
            if (rest) {
              const g = setGoal(workspaceRoot, rest, activeAgent.sessionKey);
              return { lines: [`Goal set: ${g.text}`, `status: ${g.status}`] };
            }
            const g = readGoal(workspaceRoot, activeAgent.sessionKey);
            return { lines: g ? [`Goal: ${g.text}`, `status: ${g.status} · set ${g.setAt}`] : ['No active goal.', 'Usage: /goal <text> · /goal clear'] };
          }
          case 'plan': {
            const text = formatPlan(readPlan(workspaceRoot, activeAgent.sessionKey));
            return { lines: text.trim() ? text.split('\n') : ['No plan yet.'] };
          }
          case 'workers': {
            const ws = listWorkers(workspaceRoot);
            if (rest.startsWith('info ')) {
              const id = rest.slice(5).trim();
              const summary = readWorkerSummary(workspaceRoot, id);
              return { lines: summary ? summary.split('\n').slice(0, 40) : [`No summary for worker ${id}.`] };
            }
            return {
              lines: ws.length
                ? ws.slice(0, 20).map((w) => `${w.id} · ${(w as { status?: string }).status ?? '?'} · ${((w as { task?: string }).task ?? '').slice(0, 70)}`)
                : ['No workers in this workspace.'],
            };
          }
          case 'ps': {
            const tasks = collectRunningTasks(workspaceRoot) as Array<{ kind: string; id: string; label: string }>;
            return { lines: tasks.length ? tasks.map((t) => `${t.kind} · ${t.id} · ${t.label}`) : ['Nothing running.'] };
          }
          case 'tools': {
            try {
              const res = await mcpClient.listTools() as { tools?: Array<{ name?: string }> };
              const names = (res.tools ?? []).map((t) => t.name).filter(Boolean) as string[];
              return { lines: names.length ? [`${names.length} MCP tools:`, ...names.slice(0, 60)] : ['No MCP tools (offline mode — local tools only).'] };
            } catch { return { lines: ['No MCP tools (offline mode — local tools only).'] }; }
          }
          case 'status': {
            const st = mcpClient.getStatuses();
            return {
              lines: [
                `model: ${activeAgent.getModel?.() ?? llm.model} (${llm.provider})`,
                `workspace: ${workspaceRoot}`,
                `session: ${activeAgent.sessionKey}`,
                ...st.map((x) => `mcp ${x.serverId}: ${x.status}${x.identity !== 'unknown' ? ` (${x.identity})` : ''}`),
                st.length === 0 ? 'mcp: no servers configured' : '',
              ].filter(Boolean),
            };
          }
          case 'briefing': {
            const a = activeAgent as unknown as { lastBriefingSources?: string[]; lastBriefingDetails?: Record<string, unknown> };
            const sources = a.lastBriefingSources ?? [];
            const details = a.lastBriefingDetails ?? {};
            if (!sources.length && !Object.keys(details).length) return { lines: ['No briefing yet — run a turn first.'] };
            return {
              lines: [
                sources.length ? `Sources queried: ${sources.join(', ')}` : 'Sources queried: —',
                ...Object.entries(details).slice(0, 12).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 120)}`),
              ],
            };
          }
          case 'memory':
          case 'recall': {
            if (!rest) return { lines: [`Usage: /${cmd} <query>`] };
            try {
              const result = await mcpClient.callTool(cmd === 'memory' ? 'memory_search' : 'cognitive_recall', { query: rest });
              const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              return { lines: text.split('\n').slice(0, 50) };
            } catch (err) {
              return { lines: [`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`, 'Is the BrainRouter MCP server connected?'] };
            }
          }
          default:
            throw new Error(`Unknown bridge command "${cmd}".`);
        }
      },
      // DESK-5 — provider/endpoint/key editor writes the shared config.json.
      // Only the fields the user actually typed are touched; the key is never
      // echoed back (config-snapshot already omits it).
      'action:set-llm': (args) => {
        const fresh = loadConfig();
        const llmCfg = (fresh.llm = fresh.llm ?? { provider: 'openai', apiKey: '', model: '' });
        if (typeof args.provider === 'string' && args.provider.trim()) llmCfg.provider = args.provider.trim();
        if (typeof args.model === 'string' && args.model.trim()) llmCfg.model = args.model.trim();
        if (typeof args.endpoint === 'string') llmCfg.endpoint = args.endpoint.trim() || undefined;
        if (typeof args.apiKey === 'string' && args.apiKey.trim()) llmCfg.apiKey = args.apiKey.trim();
        saveConfig(fresh);
        return { ok: true, provider: llmCfg.provider, model: llmCfg.model, endpoint: llmCfg.endpoint ?? null };
      },
      // DESK-5c/5l — live model list from the configured endpoint (cached 60s).
      // Empty results are NOT cached: a transient endpoint hiccup used to pin
      // an empty list for a minute, leaving the picker with nothing to switch
      // to. Failures fall back to the last good list when there is one.
      'list-models': async () => {
        const fresh = loadConfig();
        const l = fresh.llm ?? llm;
        const now = Date.now();
        if (modelsCache && now - modelsCache.at < 60_000) return { models: modelsCache.models, current: activeAgent.getModel?.() ?? l.model };
        const models = await fetchEndpointModels(l.endpoint, l.apiKey ?? '');
        if (models.length) modelsCache = { models, at: now };
        return { models: models.length ? models : (modelsCache?.models ?? []), current: activeAgent.getModel?.() ?? l.model };
      },
      // DESK-5c — real terminal sessions (offset-poll streaming).
      'term-open': () => {
        const id = `t${++termSeq}`;
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
        const args = isWin ? ['-NoLogo'] : ['-i'];
        const proc = spawn(shell, args, {
          cwd: workspaceRoot,
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
        });
        const sess: TermSession = { proc, buf: '', alive: true };
        const append = (d: Buffer) => {
          sess.buf += d.toString('utf-8');
          if (sess.buf.length > TERM_BUF_CAP) sess.buf = sess.buf.slice(-TERM_BUF_CAP);
        };
        proc.stdout.on('data', append);
        proc.stderr.on('data', append);
        proc.on('exit', (code) => { sess.alive = false; sess.buf += `\r\n[shell exited ${code ?? '?'}]\r\n`; });
        terms.set(id, sess);
        return { id, shell };
      },
      'term-write': (args) => {
        const sess = terms.get(String(args.id));
        if (!sess?.alive) return { ok: false };
        sess.proc.stdin.write(String(args.data ?? ''));
        return { ok: true };
      },
      'term-read': (args) => {
        const sess = terms.get(String(args.id));
        if (!sess) return { chunk: '', next: 0, alive: false };
        const from = Math.max(0, Math.min(Number(args.from) || 0, sess.buf.length));
        return { chunk: sess.buf.slice(from), next: sess.buf.length, alive: sess.alive };
      },
      'term-kill': (args) => {
        const sess = terms.get(String(args.id));
        if (sess) { try { sess.proc.kill(); } catch { /* already gone */ } terms.delete(String(args.id)); }
        return { ok: true };
      },
      // Actions — host-side mutations the Settings dialog / palette trigger.
      // They ride the query channel (free-form names, result routing by id).
      'action:clear': () => { activeAgent.clearHistory(); return { ok: true }; },
      'action:compact': async () => activeAgent.compactHistory(),
      'action:set-pref': (args) => {
        const key = typeof args.key === 'string' ? args.key : '';
        const SETTABLE = new Set(['executionMode', 'reviewPolicy', 'delegationPolicy', 'autoChain', 'effort', 'personality', 'tier', 'theme', 'quiet', 'memoriesEnabled', 'personaAnchorEnabled', 'experimental', 'rawScrollback', 'editorMode']);
        if (!SETTABLE.has(key)) throw new Error(`Preference "${key}" is not settable from the desktop.`);
        return writePreferences(workspaceRoot, { [key]: args.value } as never);
      },
      'action:set-hook': (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        return { ok: setHookEnabled(workspaceRoot, id, args.enabled === true) };
      },
      'action:set-access': (args) => {
        const mode = args.mode;
        if (mode !== 'read' && mode !== 'write' && mode !== 'shell') throw new Error(`Unknown access mode "${String(mode)}".`);
        activeAgent.setAccessMode(mode);
        return { ok: true, mode };
      },
      'action:reconnect-mcp': async (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        await mcpClient.reconnectOne(id);
        return { ok: true };
      },
      // T6 — add an MCP server: write the profile to config.json (shared with the
      // CLI) and connect it now. type 'stdio' needs a command; 'http' needs a url.
      'action:add-mcp': async (args) => {
        const id = String(args.id ?? '').trim();
        const type = args.type === 'http' ? 'http' : 'stdio';
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: 'Server id must be letters, digits, dash, underscore or dot.' };
        const cfg = type === 'http'
          ? { type: 'http' as const, url: String(args.url ?? '').trim() }
          : { type: 'stdio' as const, command: String(args.command ?? '').trim(), args: typeof args.args === 'string' ? args.args.trim().split(/\s+/).filter(Boolean) : [] };
        if (type === 'http' ? !cfg.url : !cfg.command) return { ok: false, error: `A ${type} server needs a ${type === 'http' ? 'url' : 'command'}.` };
        const fresh = loadConfig() as { servers?: Record<string, unknown> };
        fresh.servers = fresh.servers ?? {};
        if (fresh.servers[id]) return { ok: false, error: `A server named "${id}" already exists.` };
        fresh.servers[id] = cfg;
        saveConfig(fresh as never);
        try { await mcpClient.connectOne(id, cfg as never, loadConfig().llm ?? llm, 5_000); } catch { /* offline — config saved, connect on next boot */ }
        return { ok: true, id };
      },
      'action:remove-mcp': async (args) => {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'No server id.' };
        try { await mcpClient.disconnectOne(id); } catch { /* already gone */ }
        const fresh = loadConfig() as { servers?: Record<string, unknown> };
        if (fresh.servers && fresh.servers[id]) { delete fresh.servers[id]; saveConfig(fresh as never); }
        return { ok: true, id };
      },
      // DESK-6m — per-chat context-menu actions (Pin / Mark completed / Rename /
      // Move to group / Archive / Delete / Fork / Open). All write the shared
      // CLI stores, so the terminal sees the same titles/pins/groups.
      'action:session-meta': (args) => {
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-meta: missing sessionKey');
        const patch = (args.patch ?? {}) as Partial<SessionMeta>;
        const meta = setSessionMeta(workspaceRoot, sessionKey, patch);
        return { ok: true, sessionKey, meta, groups: listSessionGroups(workspaceRoot) };
      },
      'action:session-delete': (args) => {
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-delete: missing sessionKey');
        const removed = deleteSession(workspaceRoot, sessionKey);
        removeSessionMeta(workspaceRoot, sessionKey);
        return { ok: removed, sessionKey };
      },
      'action:session-fork': (args) => {
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-fork: missing sessionKey');
        // DESK-6v — upToTs (epoch ms) branches from a specific message; absent = whole-conversation fork.
        const upToTs = typeof args.upToTs === 'number' ? args.upToTs : undefined;
        const newKey = forkSession(workspaceRoot, sessionKey, upToTs);
        if (newKey) {
          // Record the lineage + carry the title forward with a "(fork)" suffix so
          // it's recognizable. forkedFrom drives the sidebar fork icon and the
          // "Forked from conversation" back-link in the renderer.
          const src = getSessionMeta(workspaceRoot, sessionKey);
          setSessionMeta(workspaceRoot, newKey, { forkedFrom: sessionKey, ...(src.title ? { title: `${src.title} (fork)` } : {}) });
        }
        return { ok: !!newKey, newKey };
      },
      'action:session-groups': () => ({ groups: listSessionGroups(workspaceRoot) }),
      // DESK-6m — "Open PR" / "Open in {editor,finder,terminal}" for the workspace.
      'action:open-external': (args) => {
        const what = typeof args.what === 'string' ? args.what : '';
        const root = workspaceRoot;
        const sh = (cmd: string) => new Promise<void>((resolve) => exec(cmd, { cwd: root, timeout: 8_000 }, () => resolve()));
        const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
        const isWin = process.platform === 'win32', isMac = process.platform === 'darwin';
        if (what === 'pr') { void sh('gh pr view --web'); return { ok: true, what }; }
        if (what === 'editor') { void sh(`code ${q(root)} || cursor ${q(root)} || ${isMac ? `open ${q(root)}` : isWin ? `start "" ${q(root)}` : `xdg-open ${q(root)}`}`); return { ok: true, what }; }
        if (what === 'finder') { void sh(isMac ? `open ${q(root)}` : isWin ? `explorer ${q(root)}` : `xdg-open ${q(root)}`); return { ok: true, what }; }
        if (what === 'terminal') { void sh(isMac ? `open -a Terminal ${q(root)}` : isWin ? `start cmd /K cd /d ${q(root)}` : `x-terminal-emulator --working-directory=${q(root)} || gnome-terminal --working-directory=${q(root)}`); return { ok: true, what }; }
        return { ok: false, what };
      },
    },
    onShutdown: () => { void mcpClient.close?.(); process.exit(0); },
  });

  if (port) port.on('message', (e) => { void core.handle(e.data); });

  // DESK-5d/5u — boot announcement. Emitted AFTER the message listener is
  // attached, so a renderer that waits for it can safely start querying. The
  // renderer treats a fresh `session-changed` as "reset surfaces".
  //
  // DESK-5u — open on a FRESH NEW CHAT (the agent's randomUUID session), not
  // a restored previous one. Every past transcript is still on disk and listed
  // in the sidebar, so nothing is lost — the user picks one to resume. (This
  // reverts the 5t boot-resume: "open on a new chat" is the wanted behavior.)
  send({
    seq: 0, ts: Date.now(), sessionKey: activeAgent.sessionKey,
    event: { kind: 'session-changed', sessionKey: activeAgent.sessionKey, loadedMessages: 0, model: activeAgent.getModel?.() ?? llm.model },
  });
}

main().catch((err) => {
  console.error('[brainrouter-desktop host] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
