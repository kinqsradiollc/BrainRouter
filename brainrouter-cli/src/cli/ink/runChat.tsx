import React from 'react';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import type { Agent } from '../../agent/agent.js';
import type { McpClientPool as McpClientWrapper } from '../../runtime/mcpPool.js';
import type { Config } from '../../config/config.js';
import { getCliKnobs, setCliKnobOverride } from '../../config/config.js';
import type { WorkspaceInfo } from '../../config/workspace.js';
import { resolveTheme } from '../theme.js';
import { buildBannerInputs, renderBanner } from '../banner.js';
import { isKnownSegment, renderSegments } from '../statusline.js';
import { resolveTierLadder, currentTier } from '../../runtime/tierLadder.js';
import { readPreferences } from '../../state/preferencesStore.js';
import { resolveSandboxConfig, runShell } from '../../runtime/exec/sandbox.js';
import { parseBangCommand, parseNoteCommand } from '../../runtime/exec/bangCommand.js';
import { runHooks } from '../../state/hooksStore.js';
import { listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { childrenSettled, buildChildResumePrompt, shouldResumeOnChildComplete } from '../../runtime/childResume.js';
import { toolPairKey } from '../../runtime/toolPairing.js';
import { InputQueue } from '../../runtime/inputQueue.js';
import { reconcileOrphanWorktrees } from '../../orchestration/worktreeIsolation.js';
import { reconcileStaleWorkers, listWorkers } from '../../state/workerStore.js';
import { beginTurnCheckpoint, endTurnCheckpoint, queueOfflinePrompt, isConnectivityError, readRecoverable, clearOfflineQueue, shouldAutoReplayOffline } from '../../state/checkpointStore.js';
import { shouldAutoExtractSkill, buildSessionSummary } from '../../runtime/autoSkill.js';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import { reconcileStaleRuns, listRuns } from '../../state/workflowRun.js';
import { collectRunningTasks } from '../../runtime/backgroundTasks.js';
import { newlyTerminal, formatCompletionNotice, type CompletionItem } from '../../runtime/completionNotices.js';
import { expandMentions } from '../../memory/mentions.js';
import {
  addGoalTokens,
  buildGoalContinuationPrompt,
  formatBudget,
  goalHasBudgetLeft,
  readGoal,
  tickGoalIteration,
  usageLimitGoal,
} from '../../state/goalStore.js';
import { setActiveReadline } from '../cliPrompt.js';
import { ChatApp, type ChatController, type PushScrollback } from './ChatApp.js';
import type { SlashCommandDef } from './SlashPalette.js';
import { handleSlashCommand, lookupSlashDescription, SLASH_COMMANDS } from '../repl.js';
import { startScheduleTicker, type ScheduleTickerHandle } from '../../runtime/scheduleTicker.js';
import { formatToolCall } from './toolFormat.js';
import { setAmbientChat } from './ambientChat.js';
import { captureConsoleOutput } from './consoleCapture.js';
import { renderWithResizeClear } from './renderWithResizeClear.js';

/**
 * Mount the full Ink-based chat REPL and run it until the user exits.
 *
 * The CLI's only chat surface as of 0.3.7 — the old readline-based REPL
 * was removed in favour of this single Ink tree. The Ink REPL owns stdin
 * for the entire CLI lifetime — no handoff back to readline — so unlike
 * `runWizard` / `runPicker` we don't call `resetStdinForReadline` after
 * unmount; the process exits the moment Ink does.
 *
 * Orchestration:
 *   1. Build the banner, slash catalog, and theme.
 *   2. Mount ChatApp, grabbing its imperative controller via `onReady`.
 *   3. ChatApp's `onSubmit` dispatches each line:
 *        - slash command → `handleSlashCommand` (via a shim readline
 *          that satisfies the type but no-ops the readline-specific
 *          surface area).
 *        - free text     → `runChatTurn` (the agent.runTurn adapter).
 *   4. Post-turn surface behaviours run inside `runChatTurn`'s finally:
 *      goal continuation queue, footer refresh, idle hint re-arm.
 *   5. Ctrl+C / Ctrl+D inside Ink (via ChatApp's useInput) triggers
 *      Ink's `exit()`, which resolves `instance.waitUntilExit()` →
 *      we close the mcpClient and let the process drain.
 */
export interface RunChatOptions {
  agent: Agent;
  mcpClient: McpClientWrapper;
  config: Config;
  workspace?: WorkspaceInfo;
  /**
   * Optional federation handle from `attachFederation`. When provided,
   * `runChat` swaps its `onInboxText` to push incoming /dm + broadcast
   * banners through `controller.push.notice` — so they land in the
   * persistent scrollback ABOVE the composer instead of as raw stdout
   * writes that Ink stomps on the next redraw.
   */
  federation?: import('../../runtime/federationRegistration.js').FederationHandle | null;
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { agent, mcpClient, config, federation } = opts;
  // Fire user-registered session-start hooks. Previously these were
  // accepted by `/hooks add session-start <cmd>` and persisted to
  // hooks.json but never actually executed — silent dead config. Hooks
  // run synchronously with a 5s timeout (see hooksStore.runHooks).
  try {
    runHooks(agent.workspaceRoot, 'session-start', {
      payload: { sessionKey: agent.sessionKey, model: (agent as any).llmConfig?.model },
    });
  } catch { /* hook errors must not block the REPL boot */ }
  const theme = resolveTheme(agent.workspaceRoot);
  // Boxed banner is disabled as it is no longer needed (kept here for reference)
  // const banner = renderBanner(buildBannerInputs(config, agent, mcpClient), theme);
  const banner = '';
  // Track the last rendered banner so slash commands that change banner-
  // visible state (model, MCP profile, session, workflow, goal) can push
  // a fresh one into scrollback rather than leaving stale values on
  // screen. Diff-based: a command that didn't change anything banner
  // surfaces doesn't re-print. See dispatchSlash's finally below.
  let lastRenderedBanner = banner;

  const offlineWarning = mcpClient.isConnected()
    ? undefined
    : theme.warning('  ⚠️  OFFLINE MODE — MCP server unreachable. Memory recall, skills, and capture are disabled.')
      + '\n' + theme.muted('       Local tools (file edits, shell, web fetch, spawn_agent) still work.')
      + '\n' + theme.muted('       Start the MCP server and restart the CLI to restore full functionality.');

  const hint = theme.muted('  Type ') + theme.info('/help')
    + theme.muted(' for commands · ') + theme.info('/where')
    + theme.muted(' for current state · just start typing your prompt.');

  // Build the slash command catalog from the registry in repl.ts so the
  // inline palette suggestions match the readline REPL's autocomplete list.
  const slashCatalog: SlashCommandDef[] = SLASH_COMMANDS.map((cmd) => ({
    cmd,
    description: lookupSlashDescription(cmd),
  }));

  // Closure-shared state — equivalent to the readline REPL's local closures
  // in startREPL. Captured into `onSubmit` / shim listeners so the orchestrator
  // remains a single owner of the turn lifecycle.
  let isProcessing = false;
  let pendingContinuation = false;
  // C2 — messages typed while a turn is running are queued here (not dropped) and
  // drained one at a time after each turn settles.
  const inputQueue = new InputQueue();
  // C1 — interval that polls timed-out children and auto-resumes once they settle.
  let childResumeTimer: ReturnType<typeof setInterval> | null = null;
  const cancelChildResume = (): boolean => {
    if (!childResumeTimer) return false;
    clearInterval(childResumeTimer);
    childResumeTimer = null;
    return true;
  };
  // Anti-spin corrective: give /goal ONE retry with a stronger nudge before
  // halting on a prose-only turn. Resets on any tool-call turn or goal clear.
  let goalNoToolStrikes = 0;
  let idleHintFired = false;
  let idleHintTimer: NodeJS.Timeout | undefined;
  let controller: ChatController | undefined;
  let exited = false;

  const isQuiet = (): boolean => {
    if (getCliKnobs().quiet) return true;
    try { return readPreferences(agent.workspaceRoot).quiet === true; } catch { return false; }
  };

  // Idle help hint — port of the readline REPL's 30s discoverability nudge.
  // Single-fire per session; user input cancels.
  const armIdleHint = () => {
    if (idleHintFired || !process.stdout.isTTY) return;
    if (idleHintTimer) clearTimeout(idleHintTimer);
    idleHintTimer = setTimeout(() => {
      if (idleHintFired || isProcessing || pendingContinuation || exited) return;
      idleHintFired = true;
      controller?.push.notice(
        `Tip: press ? or /help for commands, /where for current state.`,
      );
    }, 30_000);
    if (typeof (idleHintTimer as any).unref === 'function') {
      (idleHintTimer as any).unref();
    }
  };
  const clearIdleHint = () => {
    if (idleHintTimer) { clearTimeout(idleHintTimer); idleHintTimer = undefined; }
  };

  // Footer refresh — derives model · session · branch from current agent
  // state and prefs. Re-run after each turn so the bar reflects post-turn
  // model swaps, branch changes, etc.
  const refreshFooter = () => {
    if (!controller) return;
    const prefs = readPreferences(agent.workspaceRoot);
    const requested = prefs.statusline.split(',').map((s) => s.trim()).filter(Boolean);
    const segments = requested.filter(isKnownSegment).filter((segment) => segment !== 'effort');
    // FOOTER-TELEMETRY — precompute the model tier (only when the user opted the
    // segment in, to avoid the ladder lookup every refresh).
    let tier: string | null = null;
    if (segments.includes('tier')) {
      try {
        const provider = (agent.getLlmConfig?.()?.provider ?? 'openai').toLowerCase();
        tier = currentTier(agent.getModel(), resolveTierLadder({ provider }));
      } catch { tier = null; }
    }
    const rendered = renderSegments(segments, {
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      accessMode: agent.getAccessMode(),
      model: agent.getModel(),
      lastTurnUsage: agent.lastTurnUsage,
      tier,
      repairTotals: agent.getRepairTotals?.(),
      offloadTotals: agent.getOffloadTotals?.(),
      prDetector: () => detectGitHubPR(agent.workspaceRoot),
    });
    let branch: string | undefined;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: agent.workspaceRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
    } catch { /* not a git repo */ }
    controller.setFooter({
      model: agent.getModel(),
      session: agent.sessionKey,
      branch,
      effort: prefs.effort,
      accessMode: agent.getAccessMode() as 'read' | 'write' | 'shell',
      rightExtra: rendered.length > 0 ? rendered.join(' · ') : undefined,
      // Surface background-child count so the footer says "· N working"
      // even after the parent turn yields back to idle. Without this the
      // user had to run /where to discover that delegate_agent / fire-
      // and-forget children were still alive in the session store.
      runningChildren: getRunningChildCount(),
    });
    refreshTerminalTitle();
  };

  const refreshTerminalTitle = () => {
    try {
      const prefs = readPreferences(agent.workspaceRoot);
      const cfg = prefs.terminalTitle ?? 'model,session';
      if (cfg.toLowerCase() === 'off') return;
      const segs = cfg.split(',').map((s) => s.trim()).filter(Boolean);
      const parts: string[] = [];
      for (const seg of segs) {
        if (seg === 'model') parts.push(agent.getModel());
        else if (seg === 'session') parts.push(agent.sessionKey);
        else if (seg === 'mode') parts.push(agent.getAccessMode());
        else if (seg === 'branch') {
          try {
            parts.push(execSync('git rev-parse --abbrev-ref HEAD', {
              cwd: agent.workspaceRoot,
              stdio: ['ignore', 'pipe', 'ignore'],
            }).toString().trim());
          } catch { /* not a git repo */ }
        }
      }
      if (parts.length === 0) return;
      const awaitingCount = (pendingContinuation ? 1 : 0) + getRunningChildCount();
      const prefix = awaitingCount > 0 ? `(${awaitingCount}) ` : '';
      process.stdout.write(`\x1b]0;${prefix}brainrouter · ${parts.join(' · ')}\x07`);
    } catch { /* terminal doesn't support OSC titles */ }
  };

  const getRunningChildCount = (): number => {
    try {
      // Reconcile first so child records from prior CLI processes (dead
      // pids) don't get counted as "working". Without this the footer
      // showed phantom "· N working" forever for zombies left over by an
      // earlier crash / Ctrl-C exit. reconcileStale is idempotent and
      // only writes the JSON file when there were actual stale entries
      // to flip — subsequent calls are pure reads.
      reconcileStale(agent.workspaceRoot);
      // Snapshot the LIVE (running/pending) children AFTER reconcileStale has flipped
      // any dead-pid sessions — these ids guard their worktrees from the GC below.
      const sessions = listSessions(agent.workspaceRoot);
      const liveChildIds = sessions.filter((s) => s.status === 'pending' || s.status === 'running').map((s) => s.id);
      // CODEX-WORKTREE-CLEANUP — GC orphan child worktrees left under the worktree
      // base by a crashed prior process (git worktree prune + rm untracked dirs).
      // `keepChildIds` ensures a RUNNING child's worktree is never deleted out from
      // under it (the live-child GC bug). Best-effort + idempotent.
      try { reconcileOrphanWorktrees(agent.workspaceRoot, { keepChildIds: liveChildIds }); } catch { /* best-effort */ }
      // MAS-P5-T3: same treatment for worker threads — a `running` worker
      // from a dead CLI process can't resume mid-turn, so flip it to failed.
      reconcileStaleWorkers(agent.workspaceRoot);
      // PARITY-W1: durable workflow runs left `running` by a dead process are
      // flipped to `interrupted` so the /workflows viewer is honest on restart.
      reconcileStaleRuns(agent.workspaceRoot);
      return liveChildIds.length;
    } catch {
      return 0;
    }
  };

  // PARITY-W3 — idle background-completion notifications. Each tick we diff the
  // set of terminal background actors (child agents, workers, workflow runs)
  // against what we've already announced; anything new is surfaced as a
  // print-above-prompt notice when the composer is idle. Seeded at startup so
  // we never dump history on the first tick.
  const notifiedCompletions = new Set<string>();
  const getRunningWorkerCount = (): number => {
    try { return listWorkers(agent.workspaceRoot).filter((w) => w.status === 'running').length; }
    catch { return 0; }
  };
  const getRunningWorkflowCount = (): number => {
    try { return listRuns(agent.workspaceRoot).filter((r) => r.status === 'running').length; }
    catch { return 0; }
  };
  // BG-TASKS-PANEL — push the live running-tasks list into the panel.
  const refreshBackgroundTasks = (): void => {
    try { controller?.setBackgroundTasks(collectRunningTasks(agent.workspaceRoot)); }
    catch { /* panel refresh must never break the REPL */ }
  };
  const collectTerminalCompletions = (): CompletionItem[] => {
    const items: CompletionItem[] = [];
    try {
      for (const s of listSessions(agent.workspaceRoot)) {
        if (s.status === 'completed' || s.status === 'failed') {
          const label = s.label ? `"${s.label}"` : s.id;
          items.push({ id: `agent:${s.id}`, label: `agent ${label} ${s.status}`, ok: s.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    try {
      for (const w of listWorkers(agent.workspaceRoot)) {
        if (w.status === 'completed' || w.status === 'failed') {
          items.push({ id: `wkr:${w.id}`, label: `worker ${w.id} (${w.role}) ${w.status}`, ok: w.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    try {
      for (const r of listRuns(agent.workspaceRoot)) {
        if (r.status === 'completed' || r.status === 'failed' || r.status === 'interrupted') {
          items.push({ id: `run:${r.slug}`, label: `workflow ${r.slug} ${r.status}`, ok: r.status === 'completed' });
        }
      }
    } catch { /* ignore */ }
    return items;
  };
  const notifyIdleCompletions = (): void => {
    const fresh = newlyTerminal(notifiedCompletions, collectTerminalCompletions());
    for (const item of fresh) {
      // Only announce (and mark seen) when idle — a completion observed
      // mid-turn stays unseen so it surfaces once the user is back at the
      // prompt rather than scrolling past under the active turn.
      if (isProcessing || pendingContinuation || exited || !controller) continue;
      notifiedCompletions.add(item.id);
      controller.push.notice(formatCompletionNotice(item), item.ok ? 'info' : 'warn');
      try { if (getCliKnobs().notifyBell && process.stdout.isTTY) process.stdout.write(''); } catch { /* bell is best-effort */ }
    }
  };
  // Establish the baseline of already-terminal actors so only completions that
  // happen AFTER this session opened are announced.
  try { for (const item of collectTerminalCompletions()) notifiedCompletions.add(item.id); } catch { /* noop */ }

  // gh-PR detector cache — same 30s TTL as the readline REPL so the
  // statusline doesn't pay 300ms per prompt redraw.
  let prCache: { value: string | null; cachedAt: number } | null = null;
  const PR_CACHE_TTL_MS = 30_000;
  function detectGitHubPR(cwd: string): string | null {
    const now = Date.now();
    if (prCache && now - prCache.cachedAt < PR_CACHE_TTL_MS) return prCache.value;
    let value: string | null = null;
    try {
      const out = execSync('gh pr view --json number,title 2>/dev/null', {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      }).toString().trim();
      if (out) {
        const parsed = JSON.parse(out) as { number?: number };
        if (typeof parsed.number === 'number') value = `#${parsed.number}`;
      }
    } catch { /* gh missing or no PR */ }
    prCache = { value, cachedAt: now };
    return value;
  }

  // Shim readline.Interface — satisfies the type required by
  // `handleSlashCommand` so existing slash handlers (extracted into
  // cli/commands/*) work unchanged under the Ink REPL. The shim is an
  // EventEmitter (because readline.Interface extends it) and stubs the
  // prompt/write/pause/resume surface as no-ops. `close()` exits Ink
  // gracefully — used by /quit and /exit.
  //
  // Limits to be aware of:
  //   - `question(q, cb)` is implemented but ROUTES through the
  //     composer-as-input pattern: it temporarily replaces the submit
  //     handler so the next line submission is delivered to `cb`. Used
  //     by askYesNo. NOT a replacement for the ask_user_choice mid-turn
  //     picker — that path will degrade to NoTTYError until we wire a
  //     dedicated Ink picker into the chat tree (follow-up).
  //   - `write(text)` injects into the composer (mirrors readline.write).
  const shim = createReadlineShim({
    closeChat: () => { exited = true; controller?.exit(); },
    onWriteToComposer: (text) => controller?.setComposer(text),
    waitForLine: (cb) => {
      questionCallback = cb;
    },
  });
  let questionCallback: ((line: string) => void) | undefined;

  // Goal continuation. After each turn ends successfully, schedule the
  // next continuation iff the goal is still active and made progress.
  // The user's next keystroke cancels the queued continuation.
  const scheduleGoalContinuation = (afterPrompt: string, afterAnswer: string) => {
    let goalAfter = readGoal(agent.workspaceRoot, agent.sessionKey);
    if (goalAfter && goalAfter.budget.maxTokens) {
      const delta = (agent.lastTurnUsage?.promptTokens ?? 0) + (agent.lastTurnUsage?.completionTokens ?? 0);
      if (delta > 0) {
        const updated = addGoalTokens(agent.workspaceRoot, agent.sessionKey, delta);
        if (updated) goalAfter = updated;
      }
      if (
        goalAfter &&
        goalAfter.status === 'active' &&
        typeof goalAfter.budget.maxTokens === 'number' &&
        (goalAfter.budget.tokensUsed ?? 0) >= goalAfter.budget.maxTokens
      ) {
        const limited = usageLimitGoal(
          agent.workspaceRoot,
          agent.sessionKey,
          `Token budget reached: ${(goalAfter.budget.tokensUsed ?? 0).toLocaleString()} of ${goalAfter.budget.maxTokens.toLocaleString()} used.`,
        );
        if (limited) goalAfter = limited;
      }
    }

    // Reset the strike counter the moment the model actually emits tool calls.
    if (agent.lastTurnToolCalls > 0) goalNoToolStrikes = 0;

    const goalActive = !!goalAfter && goalAfter.status === 'active' && goalHasBudgetLeft(goalAfter) && agent.lastGoalTransition === undefined;
    const correctiveAvailable = goalActive && agent.lastTurnToolCalls === 0 && goalNoToolStrikes < 1;

    const shouldContinue =
      goalActive &&
      (agent.lastTurnToolCalls > 0 || correctiveAvailable);

    if (goalAfter && goalAfter.status === 'complete') {
      controller?.push.notice(`🎯 Goal achieved — ${goalAfter.blockedReason ?? 'evidence on record.'}`, 'info');
    } else if (goalAfter && goalAfter.status === 'blocked') {
      controller?.push.notice(`🚧 Goal blocked: ${goalAfter.blockedReason ?? '(no reason)'}`, 'warn');
      controller?.push.notice(`Resolve the blocker, then /goal resume to continue.`, 'info');
    } else if (goalAfter && goalAfter.status === 'usage_limited') {
      controller?.push.notice(`⏸ Goal hit usage limit: ${goalAfter.blockedReason ?? 'budget exhausted'}.`, 'warn');
      controller?.push.notice(`Raise the cap with /goal budget <n> or /goal tokens <n>, then /goal resume.`, 'info');
    } else if (goalAfter && goalAfter.status === 'active' && !goalHasBudgetLeft(goalAfter)) {
      const reason = `Iteration budget exhausted (${goalAfter.budget.iterationsUsed}/${formatBudget(goalAfter.budget.maxIterations)}).`;
      const limited = usageLimitGoal(agent.workspaceRoot, agent.sessionKey, reason);
      controller?.push.notice(`⏸ ${reason} Extend with /goal budget <n> and /goal resume, mark /goal complete, or /goal clear.`, 'warn');
      if (limited) goalAfter = limited;
    } else if (goalAfter && goalAfter.status === 'active' && agent.lastTurnToolCalls === 0 && !correctiveAvailable) {
      controller?.push.notice(`(goal continuation halted: two prose-only turns in a row — type a message or /goal clear to continue)`, 'warn');
    } else if (correctiveAvailable) {
      controller?.push.notice(`(prose-only turn — sending one corrective retry; emit tool calls or call goal_blocked)`, 'info');
    }

    if (shouldContinue && goalAfter) {
      pendingContinuation = true;
      const next = goalAfter.budget.iterationsUsed + 1;
      if (correctiveAvailable) goalNoToolStrikes += 1;
      controller?.push.notice(`(goal continuation queued — iteration ${next}/${formatBudget(goalAfter.budget.maxIterations)}; type anything to cancel)`, 'info');
      const baseFollowUp = buildGoalContinuationPrompt(goalAfter, afterPrompt, afterAnswer);
      const followUp = correctiveAvailable
        ? `${baseFollowUp}\n\n**CORRECTIVE NOTICE:** your previous turn emitted zero tool calls — that violates the goal contract. THIS turn MUST emit at least one tool call (start exploration with parallel \`list_dir\` + \`glob_files\` + \`read_file\` of AGENT.md/README.md in a single message) OR call \`goal_blocked\` with a concrete reason. Prose-only is not an option.`
        : baseFollowUp;
      setImmediate(() => {
        if (!pendingContinuation || isProcessing) return;
        pendingContinuation = false;
        tickGoalIteration(agent.workspaceRoot, agent.sessionKey);
        void runChatTurn(followUp);
      });
    }
  };

  // C1 — auto-resume after a turn whose child drain TIMED OUT. Poll the timed-out
  // children; once they all settle, fire a synthetic continue prompt (drain +
  // synthesize) so the stranded result is delivered without a manual /continue. The
  // user's next keystroke cancels it (handled in onSubmit). A goal continuation, if
  // queued, takes precedence (it owns the next turn).
  const CHILD_RESUME_POLL_MS = 2500;
  const CHILD_RESUME_MAX_WAIT_MS = 10 * 60 * 1000;
  const scheduleChildResume = () => {
    const ids = [...agent.lastTurnPendingChildIds];
    if (ids.length === 0 || pendingContinuation) return;
    cancelChildResume();
    const startedAt = Date.now();
    controller?.push.notice(
      `(auto-resume armed — watching ${ids.length} background agent${ids.length === 1 ? '' : 's'}; type anything to cancel)`,
      'info',
    );
    childResumeTimer = setInterval(() => {
      if (exited) { cancelChildResume(); return; }
      if (isProcessing) return; // a turn is running — wait for it to settle
      const statusById = new Map(listSessions(agent.workspaceRoot).map((s) => [s.id, s.status]));
      if (!childrenSettled(ids, (id) => statusById.get(id))) {
        if (Date.now() - startedAt > CHILD_RESUME_MAX_WAIT_MS) {
          cancelChildResume();
          controller?.push.notice('(auto-resume gave up after 10m — type /continue when the agents finish)', 'warn');
        }
        return;
      }
      cancelChildResume();
      controller?.push.notice('(background agents finished — resuming)', 'info');
      void runChatTurn(buildChildResumePrompt(ids));
    }, CHILD_RESUME_POLL_MS);
  };

  // MAR-2 — event-driven delivery. When a background child COMPLETES while the REPL
  // is idle, deliver its result NOW (fire the same synthesize-continue the C1 poll
  // would) instead of waiting for the next poll tick — and crucially still deliver it
  // after the poll has given up. The poll stays as the fallback; the next keystroke
  // cancels both (handled in onSubmit).
  const maybeResumeOnChildComplete = () => {
    const ids = [...agent.lastTurnPendingChildIds];
    const statusById = ids.length
      ? new Map(listSessions(agent.workspaceRoot).map((s) => [s.id, s.status]))
      : new Map<string, string>();
    const allSettled = childrenSettled(ids, (id) => statusById.get(id));
    if (!shouldResumeOnChildComplete({ exited, isProcessing, pendingContinuation, pendingIds: ids, allSettled })) return;
    cancelChildResume();
    controller?.push.notice('(background agent finished — resuming)', 'info');
    void runChatTurn(buildChildResumePrompt(ids));
  };

  // C2 — `/queue` view + manage the messages typed while busy. Handled inline (like
  // `?` and `!`) so it works mid-turn without going through the turn dispatcher.
  const queuePreview = (t: string) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
  const handleQueueCommand = (args: string[]) => {
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'clear') {
      const n = inputQueue.clear();
      controller?.push.notice(n ? `Cleared ${n} queued message${n === 1 ? '' : 's'}.` : 'Queue already empty.', 'info');
      return;
    }
    if (sub === 'remove' || sub === 'rm') {
      const pos = Number.parseInt(args[1] ?? '', 10);
      const removed = Number.isInteger(pos) ? inputQueue.removeAt(pos) : undefined;
      controller?.push.notice(
        removed ? `Removed queued message ${pos}: "${queuePreview(removed.text)}"` : `No queued message at position "${args[1] ?? ''}". Use /queue to list.`,
        removed ? 'info' : 'warn',
      );
      return;
    }
    const items = inputQueue.list();
    if (items.length === 0) { controller?.push.notice('Input queue is empty.', 'info'); return; }
    controller?.push.notice(`Queued (${items.length}) — drained after the current turn · /queue remove <n> · /queue clear:`, 'info');
    items.forEach((it, i) => controller?.push.notice(`  ${i + 1}. ${queuePreview(it.text)}`, 'info'));
  };

  // C2 — after a turn settles, run the next queued message iff nothing else owns the
  // next turn (a goal continuation or a child auto-resume takes precedence).
  const drainInputQueue = () => {
    setImmediate(() => {
      if (isProcessing || pendingContinuation || childResumeTimer || exited) return;
      const next = inputQueue.dequeue();
      if (!next) return;
      const remaining = inputQueue.size;
      controller?.push.notice(`(running queued message${remaining ? ` — ${remaining} more queued` : ''})`, 'info');
      void runChatTurn(next.text);
    });
  };

  // Run a single agent turn through the Ink chat REPL. Mirrors
  // cli/repl.ts:runAgentTurn but pushes events through the Ink
  // scrollback controller instead of console.log + ora spinner.
  const runChatTurn = async (rawInput: string): Promise<void> => {
    if (!controller) return;
    if (isProcessing) {
      controller.push.notice('A previous turn is still running.');
      return;
    }
    // A fresh turn supersedes any armed auto-resume watch.
    cancelChildResume();
    isProcessing = true;
    clearIdleHint();
    // CLI-21 — crash checkpoint: record the in-flight prompt before the turn so
    // a mid-turn crash can be recovered on the next launch. Cleared in finally.
    beginTurnCheckpoint(agent.workspaceRoot, agent.sessionKey, rawInput, new Date().toISOString());
    let turnToolCalls = 0; // MEM-33b — multi-step signal for auto skill extraction

    const { expanded, mentions } = expandMentions(rawInput, agent.workspaceRoot);
    if (mentions.length > 0 && !isQuiet()) {
      controller.push.notice(`📎 Attached ${mentions.length} file${mentions.length === 1 ? '' : 's'}: ${mentions.map((m) => m.token).join(', ')}`);
    }

    const startedAt = Date.now();
    controller.push.setPhase('turn-running');
    controller.push.setStatus('Agent starting...');

    let parentDone = false;
    const tickStatus = (status: string) => {
      if (parentDone) return;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = agent.lastTurnUsage;
      const tokens = u.calls > 0 ? `  ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓` : '';
      // When children are alive — typically because the parent is in a
      // wait_agent / wait_agents / R1 guardrail auto-drain — append a
      // compact "running children" row so the parent never looks frozen.
      // Compact tail in the status line ("· 3 parallel"); the pinned
      // child-fleet scrollback row carries the full per-agent detail so
      // we don't need to cram every name in here.
      const n = runningChildren.size;
      const childrenRow = n > 0 ? `  · ${n} parallel` : '';
      controller!.push.setStatus(`${status}  ${elapsed}s${tokens}${childrenRow}`);
    };

    // Per-tool start time + args — agent.runTurn fires onToolStart with
    // full args but onToolEnd only sees name + result, so we stash the
    // args here so the end-of-call scrollback row can render the
    // formatted call (`Read(src/foo.ts)`) instead of just the bare name.
    // The map key is the LLM tool_call id when present (so parallel same-name calls
    // pair to their OWN start row), falling back to the tool name when a provider
    // omits ids. See runtime/toolPairing.ts (toolPairKey).
    const toolStartTimes = new Map<string, number>();
    const toolArgsSnapshot = new Map<string, Record<string, any>>();
    // In-flight LOCAL tool calls, so a parallel batch shows ALL of them running
    // at once instead of the status line being overwritten by whichever
    // onToolStart fired last. Mirrors the child-fleet row treatment below —
    // parallelism is the point, so surface it. Labels are the formatted calls
    // (`Read(README.md)`); same-label parallel calls are tracked as duplicates.
    const inFlightToolLabels: string[] = [];
    const renderInFlightStatus = () => {
      if (isQuiet()) return;
      if (inFlightToolLabels.length === 0) { tickStatus('Thinking'); return; }
      if (inFlightToolLabels.length === 1) { controller!.push.setStatus(inFlightToolLabels[0]); return; }
      const shown = inFlightToolLabels.slice(0, 4).join(', ');
      const more = inFlightToolLabels.length > 4 ? ` +${inFlightToolLabels.length - 4} more` : '';
      controller!.push.setStatus(`${inFlightToolLabels.length} tools running in parallel: ${shown}${more}`);
    };
    // Stash child tool args between onChildToolStart and onChildToolEnd so the
    // end row can render `Read(foo.ts)` instead of just `read_file`. Keyed by
    // `${childId}:${tool}` so two children running the same tool don't collide.
    const childToolArgs = new Map<string, Record<string, any>>();
    // Currently-running children for the compact "running children" status row.
    // Maintained from onChildToolStart / onChildComplete (the only signals the
    // REPL gets about child lifecycle that don't require re-reading sessions).
    const runningChildren = new Map<string, { role: string; tool?: string }>();
    // Debounce pushes of the child-fleet row update so a burst of N
    // onChildToolStart events (which all fire within milliseconds when
    // spawn_agents launches a batch) coalesces into ONE render. Without
    // this, the row flips through "1 running" → "2 running" → "3 running"
    // in quick succession and the user sees flicker instead of "3 parallel".
    let fleetFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFleetFlush = () => {
      if (fleetFlushTimer) return;
      fleetFlushTimer = setTimeout(() => {
        fleetFlushTimer = null;
        const snapshot = [...runningChildren.entries()].map(([childId, info]) => ({
          childId, role: info.role, tool: info.tool,
        }));
        controller!.push.setChildFleet(snapshot);
      }, 50);
    };
    // Batch-spawn detection — when 2+ NEW children appear within a short
    // window, emit a single "🚀 Spawned N agents in parallel: …" notice
    // instead of N individual "▶ X running" lines.
    const pendingSpawns: Array<{ childId: string; role: string }> = [];
    let pendingSpawnTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingSpawns = () => {
      pendingSpawnTimer = null;
      if (pendingSpawns.length === 0) return;
      controller!.push.spawnBatch(pendingSpawns.slice());
      pendingSpawns.length = 0;
    };
    const enqueueSpawnNotice = (childId: string, role: string) => {
      pendingSpawns.push({ childId, role });
      if (pendingSpawnTimer) clearTimeout(pendingSpawnTimer);
      pendingSpawnTimer = setTimeout(flushPendingSpawns, 120);
    };
    try {
      const answer = await agent.runTurn(expanded, {
        onStatusUpdate: tickStatus,
        // TIER A live streaming hooks. The agent calls these as SSE
        // frames arrive so the chat shows text character-by-character.
        // assistantDeltaEnd() clears the transient
        // row; the final scrollback entry is pushed below.
        onAssistantTurnStart: () => {
          controller!.push.assistantDeltaStart();
        },
        onAssistantDelta: (chunk) => {
          controller!.push.assistantDelta(chunk);
        },
        onAssistantTurnEnd: () => {
          controller!.push.assistantDeltaEnd();
        },
        onReasoningDelta: (chunk) => {
          controller!.push.reasoningDelta(chunk);
        },
        onCompactionEvent: (event) => {
          controller!.push.compaction(event);
          tickStatus('Thinking');
        },
        onToolStart: (name, args, callId) => {
          // Surface the in-flight tool via the spinner status line — the
          // scrollback entry is pushed at onToolEnd so each tool call is
          // a single block (header + result), not two rows.
          turnToolCalls++;
          const key = toolPairKey(name, callId);
          toolStartTimes.set(key, Date.now());
          toolArgsSnapshot.set(key, args ?? {});
          // Track this call as in-flight and render the WHOLE set, so a
          // parallel batch shows "4 tools running in parallel: …" rather than
          // the last call clobbering the status line.
          inFlightToolLabels.push(formatToolCall(name, args));
          renderInFlightStatus();
        },
        onToolEnd: (name, result, callId) => {
          // Quiet mode hides successes (the prose response covers them).
          if (isQuiet() && result.success) {
            tickStatus('Thinking');
            return;
          }
          const key = toolPairKey(name, callId);
          const startedAt = toolStartTimes.get(key);
          const args = toolArgsSnapshot.get(key);
          toolStartTimes.delete(key);
          toolArgsSnapshot.delete(key);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          const header = formatToolCall(name, args);
          // Drop this call from the in-flight set, then refresh the status so a
          // parallel batch visibly counts down (4 running → 3 → … → Thinking)
          // instead of jumping straight to idle while siblings are still going.
          const fi = inFlightToolLabels.indexOf(header);
          if (fi >= 0) inFlightToolLabels.splice(fi, 1);
          controller!.push.tool(header, result.success, {
            preview: !isQuiet() ? result.preview : undefined,
            durationMs,
          });
          renderInFlightStatus();
        },
        onPlanUpdate: (items, explanation) => {
          // Explanation rides on the plan entry itself (renders as a dim-italic
          // line above the checklist) rather than as a separate memory event,
          // so the explanation visually anchors to the plan it describes.
          controller!.push.plan(items, explanation);
          tickStatus('Thinking');
        },
        onChildToolStart: (event) => {
          const key = `${event.childId}:${event.tool}`;
          childToolArgs.set(key, event.args ?? {});
          const prior = runningChildren.get(event.childId);
          runningChildren.set(event.childId, { role: event.role, tool: event.tool });
          // Update the pinned child-fleet scrollback row (debounced) so
          // ALL running children are visible at once. Multi-agent
          // parallelism is the point — the old transient setStatus only
          // showed the most recent event.
          scheduleFleetFlush();
          // First-tool notice: queue the child for the batch-spawn
          // detector. If 2+ NEW children appear within the debounce
          // window they collapse into a single "🚀 Spawned N agents in
          // parallel: …" notice; a single late arrival still renders
          // as one line.
          if (!prior && !isQuiet()) {
            enqueueSpawnNotice(event.childId, event.role);
          }
          // Surface the new child in the footer ("· N working") even if the
          // parent is in the middle of a tool batch — getRunningChildCount
          // reads session-store status so the count is authoritative.
          refreshFooter();
          // FLEET-SIDEBAR — push the live running set into the sidebar's
          // Sub-agents section NOW, and keep the 3s ticker alive during the
          // turn. Without this the sidebar only refreshed post-turn, so
          // task_agent / spawn_agents children that spawn AND finish inside the
          // parent turn never appeared as running.
          refreshBackgroundTasks();
          ensureChildRefreshTimer();
        },
        onChildToolEnd: (event) => {
          const key = `${event.childId}:${event.tool}`;
          const args = childToolArgs.get(key);
          childToolArgs.delete(key);
          // Tool finished — null out the tool field so the fleet row
          // stops showing a stale tool name, and re-flush so the user
          // sees the live transition (running Read → running Bash, etc.).
          const cur = runningChildren.get(event.childId);
          if (cur) runningChildren.set(event.childId, { role: cur.role, tool: undefined });
          scheduleFleetFlush();
          const idShort = event.childId.slice(0, 8);
          const idLabel = event.childId.startsWith('agent-') ? event.childId.slice(0, 14) : 'agent-' + idShort;
          const inner = formatToolCall(event.tool, args);
          const header = `[${idLabel} ${event.role}] ${inner}`;
          // Quiet-mode rule (carried from R1): hide noisy success previews,
          // but still print the paired row so the user has a visible signal
          // that the child made progress.
          controller!.push.tool(header, event.ok, {
            preview: !isQuiet() ? event.preview : undefined,
            durationMs: event.durationMs,
          });
          tickStatus('Thinking');
        },
        onChildComplete: (event) => {
          runningChildren.delete(event.childId);
          scheduleFleetFlush();
          const ok = event.status === 'completed';
          // Multi-line block so the agent's full headline/summary survives
          // instead of being clipped to terminal width. Falls back to the
          // error string when the child failed.
          const body = ok ? (event.preview ?? '') : (event.error ?? 'agent failed without an error message');
          controller!.push.agentResult({
            childId: event.childId,
            role: event.role,
            status: event.status,
            body,
          });
          tickStatus('Thinking');
          // Decrement the footer "· N working" pill as soon as a child
          // settles — without this it'd stay stuck at the pre-completion
          // number until the next user input refreshes the footer.
          refreshFooter();
          // FLEET-SIDEBAR — keep the sidebar's Sub-agents section in sync as
          // children settle (mirror of the footer refresh above).
          refreshBackgroundTasks();
          // MAR-2 — this completed child may be the last one the main agent was
          // waiting on; deliver its result now rather than only on the poll tick.
          maybeResumeOnChildComplete();
        },
        onMemoryEvent: (event) => {
          if (isQuiet() && event.kind !== 'contradiction') return;
          let line: string | undefined;
          let level: 'info' | 'warn' = 'info';
          if (event.kind === 'briefing') {
            const src = event.sources.length > 0 ? event.sources.join(', ') : '(none)';
            line = `🧠 Briefing: ${event.recordCount} record${event.recordCount === 1 ? '' : 's'} from ${src}`;
          } else if (event.kind === 'capture') {
            const sensory = event.sensoryRecorded ?? event.messageCount;
            const extracted = event.extractedCount;
            const triggered = event.extractionTriggered;
            const sk = event.sessionKey;
            if (event.extractionWarning) {
              line = `💾 Captured ${sensory} sensory msg(s) in ${sk} — ⚠️ ${event.extractionWarning}`;
              level = 'warn';
            } else if (triggered && typeof extracted === 'number') {
              line = extracted > 0
                ? `💾 Captured ${sensory} msg(s) → ${extracted} cognitive record(s) extracted (${sk})`
                : `💾 Captured ${sensory} msg(s) → no new memories worth promoting (${sk})`;
            } else if (triggered === false) {
              line = `💾 Captured ${sensory} msg(s) → sensory buffer (${sk})`;
            } else {
              line = `💾 Captured ${sensory} msg(s) → memory (${sk})`;
            }
          } else if (event.kind === 'citation' && event.recordIds.length > 0) {
            line = `📌 Reinforced ${event.recordIds.length} record${event.recordIds.length === 1 ? '' : 's'}: ${event.recordIds.slice(0, 3).join(', ')}${event.recordIds.length > 3 ? '…' : ''}`;
          } else if (event.kind === 'contradiction') {
            line = `⚠️ Memory contradiction: ${event.warning.slice(0, 140)}`;
            level = 'warn';
          }
          if (line) controller!.push.memory(level, line);
          tickStatus('Thinking');
        },
        // §truncation — a persistent provider-truncation notice rendered as a
        // durable system row (not a transient status line).
        onNotice: (notice) => {
          if (notice?.message) controller!.push.memory(notice.level ?? 'info', `✂️ ${notice.message}`);
        },
      });

      parentDone = true;
      // Flush any pending batch-spawn notice + final fleet snapshot so
      // the last bits of state aren't stranded behind a 50ms / 120ms
      // debounce when the turn finishes faster than that.
      if (pendingSpawnTimer) {
        clearTimeout(pendingSpawnTimer);
        flushPendingSpawns();
      }
      if (fleetFlushTimer) {
        clearTimeout(fleetFlushTimer);
        fleetFlushTimer = null;
      }
      controller!.push.setChildFleet([...runningChildren.entries()].map(([childId, info]) => ({
        childId, role: info.role, tool: info.tool,
      })));
      const elapsed = Date.now() - startedAt;
      const u = agent.lastTurnUsage;
      // Pass the raw answer to ChatApp; ChatApp's ScrollbackRow renders
      // it through marked-terminal unless `raw: true` is set. Honors the
      // user's rawScrollback preference exactly like the readline path.
      const prefsForRender = readPreferences(agent.workspaceRoot);
      controller.push.assistant(answer, {
        raw: prefsForRender.rawScrollback === true,
        durationMs: elapsed,
        tokensIn: u.promptTokens,
        tokensOut: u.completionTokens,
        calls: u.calls,
      });
      const warning = agent.takeContradictionWarning();
      if (warning) {
        controller.push.memory('warn', `Memory: ${warning}`);
        controller.push.memory('info', `Use /memory or /briefing to investigate, /forget <id> to archive obsolete records.`);
      }

      // Goal continuation lives at the bottom of the success path so a
      // failed turn doesn't trigger it (we don't want auto-retry loops).
      scheduleGoalContinuation(rawInput, answer);

      // C1 — if this turn ended with timed-out children, arm the auto-resume watch
      // (skipped when a goal continuation already owns the next turn).
      scheduleChildResume();

      // MEM-33b — after a successful MULTI-STEP turn, fire-and-forget distil a
      // reusable skill (the brain's <no-skill/> gate drops trivial runs). Opt-in
      // (cli.autoExtractSkills, off by default — one LLM call per turn). Fully
      // self-contained so it can never disturb the session.
      if (shouldAutoExtractSkill({ enabled: getCliKnobs().autoExtractSkills, toolCalls: turnToolCalls, answerLength: (answer ?? '').length })) {
        const summary = buildSessionSummary(rawInput, answer, turnToolCalls);
        void (async () => {
          try { await callMcpTool(mcpClient, 'memory_extract_skill', { sessionSummary: summary, sessionKey: agent.sessionKey, activeSkill: agent.activeSkill }); }
          catch { /* best-effort — never disturb the session */ }
        })();
      }
    } catch (err: any) {
      parentDone = true;
      controller.push.notice(`✗ Execution failed: ${err?.message ?? err}`, 'error');
      // CLI-21 — a connectivity failure means the prompt wasn't really handled;
      // queue it so it isn't lost (offered for replay on reconnect / relaunch).
      if (isConnectivityError(err)) {
        queueOfflinePrompt(agent.workspaceRoot, agent.sessionKey, rawInput, new Date().toISOString());
        controller.push.notice('↺ Saved to the offline queue — it was a connectivity error.', 'info');
      }
    } finally {
      isProcessing = false;
      // CLI-21 — turn settled (success or normal error): clear the in-flight
      // checkpoint so only a true crash leaves one behind.
      endTurnCheckpoint(agent.workspaceRoot, agent.sessionKey);
      controller.push.setPhase('idle');
      controller.push.setStatus('');
      agent.activeSkill = undefined;
      agent.refreshSystemPrompt();
      refreshFooter();
      // If background children survived the parent turn (delegate_agent
      // fire-and-forget pattern), arm the polling ticker so the footer
      // count decrements when they finish — without this the "· N working"
      // pill would stick until the user types something.
      ensureChildRefreshTimer();
      refreshBackgroundTasks(); // immediate panel update post-turn (don't wait for the 3s tick)
      // PARITY-W3: now that the turn is over (isProcessing=false), surface any
      // background actor that finished WHILE the turn was running — those were
      // held back so they didn't scroll past under the active turn.
      notifyIdleCompletions();
      armIdleHint();
      // C2 — run the next queued message (if any) now the turn has settled and
      // nothing else (goal continuation / child auto-resume) owns the next turn.
      drainInputQueue();
    }
  };

  // Lightweight footer ticker — keeps the "· N working" indicator in sync
  // with the session-store agent registry even when child events don't
  // route back through the parent's callbacks (e.g. delegate_agent
  // fire-and-forget runs that outlive the parent turn, or children
  // finishing while the user is idle at the composer). Runs only while
  // there's something to count; goes silent when the registry is empty
  // so we're not waking up every 3s on idle sessions.
  let childRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let lastChildCount = 0;
  let refreshTickN = 0;
  // Live-refresh cadence for the fleet sidebar. The sidebar path
  // (collectRunningTasks) is just plain JSON reads, so it runs every second for
  // real-time appearance / elapsed ticking. The EXPENSIVE count
  // (getRunningChildCount → reconcile + git-worktree GC) is throttled to every
  // Nth tick so we never spawn git every second.
  const SIDEBAR_REFRESH_MS = 1000;
  const GC_EVERY_N_TICKS = 3;
  // Cheap "is anything live?" probe (no reconcile / worktree GC) for the
  // ticker's own start/stop lifecycle.
  const hasLiveActors = (): boolean => {
    try {
      if (listSessions(agent.workspaceRoot).some((s) => s.status === 'running' || s.status === 'pending')) return true;
    } catch { /* ignore */ }
    return getRunningWorkerCount() > 0 || getRunningWorkflowCount() > 0;
  };
  const tickChildRefresh = () => {
    // Cheap, EVERY tick → live sidebar (sub-agents appear/clear) + elapsed ticks.
    refreshBackgroundTasks();
    // PARITY-W3: announce any background actor that finished since last tick.
    notifyIdleCompletions();
    // Expensive (reconcile + worktree GC), THROTTLED → footer "· N working".
    // Gated so a childless turn never spawns git: only runs while actors are
    // live, or to wind the count back down to 0 after they finish.
    refreshTickN = (refreshTickN + 1) % GC_EVERY_N_TICKS;
    if (refreshTickN === 0 && (lastChildCount > 0 || hasLiveActors())) {
      const count = getRunningChildCount();
      if (count !== lastChildCount) {
        lastChildCount = count;
        refreshFooter();
      }
    }
    // Keep ticking while a turn is ACTIVE (children may spawn at any moment) or
    // while any background actor is live. Stop only once the turn is over AND
    // nothing is left running (cheap check — no GC).
    if (!isProcessing && !hasLiveActors() && childRefreshTimer) {
      clearInterval(childRefreshTimer);
      childRefreshTimer = null;
      refreshBackgroundTasks(); // final sweep → clears the panel when all done
    }
  };
  const ensureChildRefreshTimer = () => {
    if (childRefreshTimer) return;
    // Run while a turn is active (so mid-turn spawns show up live) OR when
    // something is already running in the background.
    if (!isProcessing && !hasLiveActors()) return;
    childRefreshTimer = setInterval(tickChildRefresh, SIDEBAR_REFRESH_MS);
  };

  // Background `/schedule` ticker. Single in-process timer; fires due
  // cron/one-shot jobs by re-injecting their slash command through the
  // same dispatcher the user uses. Filtered by sessionKey so a tick
  // only fires jobs owned by THIS REPL — schedules registered in a
  // different session sit idle until that session is open. Stops in
  // the `waitUntilExit` handlers below so /exit and ^C clean up.
  let scheduleTicker: ScheduleTickerHandle | null = null;
  const startTicker = () => {
    if (scheduleTicker) return;
    scheduleTicker = startScheduleTicker({
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      fire: (command, sched) => {
        if (!controller) return;
        if (isProcessing) {
          // Catch-up rule: only fire ONCE per missed window. The ticker
          // has already advanced nextRun past `now`, so silently
          // dropping a busy-session fire is correct — it won't refire
          // for the same minute.
          controller.push.notice(`(schedule ${sched.id} fired while a turn was in flight — skipped)`, 'warn');
          return;
        }
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        controller.push.notice(`⏰ Schedule ${sched.id} → ${command}`, 'info');
        void dispatchSlash(cmd, args, shim);
      },
      onError: (msg) => controller?.push.notice(`[schedule] ${msg}`, 'warn'),
    });
  };

  // Mount Ink. We DON'T set `patchConsole: false` — Ink's default
  // (patchConsole enabled) is exactly what we want: legacy slash
  // commands that still write via chalk + console.log have their
  // output promoted ABOVE Ink's redraw region instead of clobbering it.
  return new Promise<void>((resolve) => {
    const { instance, cleanupResizeClear } = renderWithResizeClear(
      <ChatApp
        initialBanner={'\n' + banner}
        initialOfflineWarning={offlineWarning}
        initialHint={hint}
        workspaceRoot={agent.workspaceRoot}
        slashCommands={slashCatalog}
        promptLabel={`brainrouter[${agent.getAccessMode()}]`}
        initialAccessMode={agent.getAccessMode() as 'read' | 'write' | 'shell'}
        initialFooter={{
          model: agent.getModel(),
          session: agent.sessionKey,
          effort: readPreferences(agent.workspaceRoot).effort,
        }}
        bannerInputs={buildBannerInputs(config, agent, mcpClient)}
        onReady={(ctrl) => {
          controller = ctrl;
          // Publish the shim so cliPrompt's askYesNo can find an "active
          // readline" while the Ink REPL owns stdin. Without this, every
          // mid-turn yes/no prompt returns its default silently.
          setActiveReadline(shim as unknown as readline.Interface);
          // Publish the controller so runPicker / runTextField route their
          // UI through the chat's overlay slot instead of mounting a
          // second Ink instance (which would race for stdin + terminal
          // state). See ambientChat.ts for the rationale.
          setAmbientChat({
            showOverlay: ctrl.showOverlay,
            clearOverlay: ctrl.clearOverlay,
          });
          // Federation Stage 3 — upgrade the inbox renderer from the
          // stdout-fallback (which Ink stomps on the next redraw) to
          // controller.push.notice so /dm and /broadcast banners land
          // in persistent scrollback ABOVE the composer. Any messages
          // that arrived during the startup gap replay on swap.
          if (federation) {
            void import('../incomingBanner.js').then(({ formatIncomingBanner }) => {
              federation.setOnInboxText((messages) => {
                for (const m of messages) {
                  ctrl.push.notice(formatIncomingBanner(m), 'info');
                }
              });
            });
          }
          refreshFooter();
          armIdleHint();
          startTicker();
          // 0.3.9 — when the active LLM endpoint is a local LM Studio,
          // fire-and-forget the native /api/v1/models fetch so
          // `contextWindowFor`, `/status`, `/where`, and future model
          // pickers can use real `max_context_length` / `trained_for_tool_use`
          // signals instead of guessing from the shipped JSON. Failure is
          // silent — the cache just stays empty and the JSON fallback
          // continues to drive the footer.
          (async () => {
            try {
              const endpoint = (agent as any).llmConfig?.endpoint;
              if (endpoint) {
                const { refreshLmStudioCache } = await import('../../runtime/lmStudioApi.js');
                const count = await refreshLmStudioCache(endpoint);
                if (count > 0) {
                  refreshFooter();
                }
              }
            } catch {
              // ignore — LM Studio probably isn't running
            }
          })();
          // CLI-22 — fire-and-forget "update available" notice (throttled +
          // cached; offline / npm-missing fails silent). Self-contained
          // try/catch so it can never surface as an unhandled rejection.
          if (getCliKnobs().updateCheck) {
            (async () => {
              try {
                const { checkForUpdate, formatUpdateBanner } = await import('../../runtime/updateCheck.js');
                const upd = await checkForUpdate();
                if (upd?.behind && controller) {
                  const banner = formatUpdateBanner(upd.current, upd.latest, upd.command);
                  if (banner) controller.push.notice(banner, 'info');
                }
              } catch {
                // best-effort — never disturb the session
              }
            })();
          }
          // CLI-21 / CLI-21b — recover what a previous run left behind. A crash
          // checkpoint (an UNFINISHED turn) is only surfaced for manual resend —
          // never auto-run (it may have been mid-mutation). The offline queue
          // (prompts that failed on connectivity) is AUTO-REPLAYED on reconnect
          // when enabled, else surfaced. Best-effort throughout.
          try {
            const rec = readRecoverable(agent.workspaceRoot, agent.sessionKey);
            if (rec.crashed && controller) {
              controller.push.notice(`⏮ A prompt from a previous session didn't finish — resend if still needed:\n  • ${rec.crashed.prompt.replace(/\s+/g, ' ').slice(0, 120)}`, 'info');
              endTurnCheckpoint(agent.workspaceRoot, agent.sessionKey);
            }
            const offline = rec.offline.slice(0, 3);
            if (offline.length > 0) {
              // Clear first so a still-offline replay re-queues cleanly (no doubling).
              clearOfflineQueue(agent.workspaceRoot, agent.sessionKey);
              if (shouldAutoReplayOffline({ enabled: getCliKnobs().autoReplayOffline, connected: mcpClient.isConnected(), count: offline.length }) && controller) {
                controller.push.notice(`↺ Replaying ${offline.length} prompt(s) queued while offline…`, 'info');
                void (async () => {
                  for (const q of offline) {
                    try { await runChatTurn(q.prompt); } catch { /* a re-failure is re-queued by runChatTurn */ }
                  }
                })();
              } else if (controller) {
                const lines = offline.map((p) => `  • ${p.prompt.replace(/\s+/g, ' ').slice(0, 120)}`);
                controller.push.notice(`↺ ${offline.length} prompt(s) were queued while offline — resend when ready:\n${lines.join('\n')}`, 'info');
              }
            }
          } catch {
            // recovery is best-effort
          }
        }}
        onAccessModeCycle={() => {
          const cycle: Array<'read' | 'write' | 'shell'> = ['read', 'write', 'shell'];
          const current = agent.getAccessMode() as 'read' | 'write' | 'shell';
          const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
          agent.setAccessMode(next);
          refreshFooter();
          return next;
        }}
        onSubmit={async (text, push) => {
          // Any in-flight goal continuation is cancelled by user input,
          // regardless of whether the input is a slash or a prompt.
          if (pendingContinuation) {
            pendingContinuation = false;
            push.notice('(goal continuation cancelled by user input)');
          }
          // C1 — likewise cancel an armed child auto-resume watch.
          if (cancelChildResume()) {
            push.notice('(auto-resume cancelled by user input)');
          }
          clearIdleHint();

          // If a slash command's handler had called `rl.question(cb)`,
          // the very next submission belongs to `cb` — not the dispatcher.
          if (questionCallback) {
            const cb = questionCallback;
            questionCallback = undefined;
            cb(text);
            return;
          }

          // Bare `?` → help (mirrors the readline REPL — the idle hint
          // advertises it, so make it actually work).
          if (text === '?') {
            await dispatchSlash('/help', [], shim);
            return;
          }

          // CC-P4.4 — `# <note>` quick memory capture: save a note straight to the
    // brain without an LLM turn (Claude Code's # memorize shortcut). Sent as a
    // user-note + synthetic ack pair so the extractor sees its usual shape;
    // shows the brain's capture verdict (or a clear offline notice).
    const noteCmd = parseNoteCommand(text);
    if (noteCmd.isNote) {
      if (!noteCmd.note) {
        push.notice('Usage: # <note to remember>   (e.g.  # deploys happen Fridays only)', 'warn');
        return;
      }
      try {
        const res = await mcpClient.callTool('memory_capture_turn', {
          sessionKey: agent.sessionKey,
          messages: [
            { role: 'user', content: `[user note — remember this] ${noteCmd.note}`, timestamp: Date.now() },
            { role: 'assistant', content: 'Noted and saved to memory.', timestamp: Date.now() },
          ],
        });
        const raw = (res as any)?.content?.[0]?.text ?? '';
        let captured = '';
        try { const p = JSON.parse(raw); captured = p?.cognitiveRecords !== undefined ? ` (${p.cognitiveRecords} record(s))` : ''; } catch { /* non-JSON ack */ }
        push.notice(`💾 Remembered${captured}: ${noteCmd.note.slice(0, 80)}${noteCmd.note.length > 80 ? '…' : ''}`, 'info');
      } catch (err: any) {
        push.notice(`✗ Could not save the note (brain offline?): ${err?.message ?? err}`, 'warn');
      }
      return;
    }

    // `! <command>` shell escape (PARITY-B1) — run a shell command
          // directly from the composer, mirroring Claude Code's bang prefix.
          // The user typed the command explicitly, so there's no askYesNo
          // gate (that guards model-initiated commands); the `cli.sandbox`
          // knob still wraps it for blast-radius control. Output lands in
          // scrollback as raw monospace text. Synchronous + bounded by the
          // runShell timeout — a backgrounded variant ships with /bg.
          const bang = parseBangCommand(text);
          if (bang.isBang) {
            if (!bang.command) {
              push.notice('Usage: ! <shell command>   (e.g.  ! git status)', 'warn');
              return;
            }
            push.notice(`! ${bang.command}`, 'info');
            try {
              const prefs = readPreferences(agent.workspaceRoot);
              const sandboxConfig = resolveSandboxConfig(agent.workspaceRoot, {
                readPaths: prefs.sandboxReadPaths,
                writePaths: prefs.sandboxWritePaths,
              });
              const result = await runShell(bang.command, sandboxConfig);
              if (result.notice) push.notice(result.notice, 'warn');
              const body = [result.stdout, result.stderr]
                .filter((s) => s && s.trim().length)
                .join('\n')
                .replace(/\s+$/, '');
              if (body.length) {
                push.raw(body, { noWrap: true });
              } else if (result.exitCode === 0) {
                push.notice('(no output)', 'info');
              }
              if (result.exitCode !== 0) {
                const badge = result.sandboxed ? `, sandboxed via ${result.sandboxTool}` : '';
                push.notice(`(exit ${result.exitCode}${badge})`, 'warn');
              }
            } catch (err: any) {
              push.notice(`✗ shell failed: ${err?.message ?? err}`, 'error');
            }
            return;
          }

          if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);
            // C2 — `/queue` is handled inline so it works mid-turn (the slash
            // dispatcher itself is fine to run while a turn is in flight).
            if (command === '/queue') { handleQueueCommand(args); return; }
            await dispatchSlash(command, args, shim);
            return;
          }

          // C2 — a prompt typed while a turn is running is QUEUED (not dropped); it
          // runs after the current turn settles (see drainInputQueue). Manage it with
          // /queue. (Slash commands above still dispatch immediately.)
          if (isProcessing) {
            const { position } = inputQueue.enqueue(text);
            push.notice(`(queued #${position} — runs after the current turn; /queue to view, /queue remove ${position} to drop)`, 'info');
            return;
          }

          await runChatTurn(text);
        }}
      />,
      { exitOnCtrlC: true, patchConsole: true },
    );

    instance.waitUntilExit().then(async () => {
      exited = true;
      setActiveReadline(undefined);
      setAmbientChat(undefined);
      cleanupResizeClear();
      clearIdleHint();
      try { scheduleTicker?.stop(); } catch { /* noop */ }
      scheduleTicker = null;
      if (childRefreshTimer) { clearInterval(childRefreshTimer); childRefreshTimer = null; }
      try { await mcpClient.close(); } catch { /* already closed */ }
      try {
        runHooks(agent.workspaceRoot, 'session-end', {
          payload: { sessionKey: agent.sessionKey, exitReason: 'clean' },
        });
      } catch { /* hook errors must not block REPL shutdown */ }
      // Goodbye line is intentionally printed AFTER Ink unmounts so it
      // doesn't get caught inside the redraw region.
      process.stdout.write(chalk.bold.hex('#CC9166')('Goodbye!\n'));
      resolve();
    }).catch(async () => {
      exited = true;
      setActiveReadline(undefined);
      setAmbientChat(undefined);
      cleanupResizeClear();
      clearIdleHint();
      try { scheduleTicker?.stop(); } catch { /* noop */ }
      scheduleTicker = null;
      if (childRefreshTimer) { clearInterval(childRefreshTimer); childRefreshTimer = null; }
      try { await mcpClient.close(); } catch { /* already closed */ }
      try {
        runHooks(agent.workspaceRoot, 'session-end', {
          payload: { sessionKey: agent.sessionKey, exitReason: 'error' },
        });
      } catch { /* hook errors must not block REPL shutdown */ }
      resolve();
    });
  });

  async function dispatchSlash(command: string, args: string[], rl: any): Promise<void> {
    if (!controller) return;
    try {
      const captured = await captureConsoleOutput(() =>
        handleSlashCommand(command, args, agent, mcpClient, config, rl as readline.Interface, {
          refreshPromptForMode: refreshFooter,
          replaceBanner: (text: string) => controller?.replaceBanner(text),
          isProcessing: () => isProcessing,
          runAgentTurn: (prompt: string) => { void runChatTurn(prompt); },
          runAgentTurnAsync: (prompt: string) => runChatTurn(prompt),
        }),
      );
      const output = captured.output.trimEnd();
      if (output) {
        controller.push.raw(output);
      }
    } catch (err: any) {
      controller.push.notice(`Slash command "${command}" failed: ${err?.message ?? err}`, 'error');
    } finally {
      // Pull any preferences / model / branch / effort changes the
      // command made (e.g. /effort, /model, /theme, /statusline) so
      // the footer reflects them immediately rather than waiting for
      // the next chat turn to refresh.
      refreshFooter();
      // Refresh the boxed banner in place when slash commands changed
      // banner-visible state (model, MCP profile, workflow, goal).
      // Diff-based so /theme, /effort, /quiet, etc. stay silent.
      // Uses controller.replaceBanner — overwrites the original banner
      // entry in scrollback rather than pushing a new copy, so there's
      // only ever one banner box on screen.
      // Banner updates disabled since the boxed banner is no longer needed
      /*
      try {
        const fresh = renderBanner(buildBannerInputs(config, agent, mcpClient), theme);
        if (fresh !== lastRenderedBanner) {
          controller.replaceBanner('\n' + fresh);
          lastRenderedBanner = fresh;
        }
      } catch { }
      */
      // BG-TASKS-PANEL — commands like /bg, /spawn, /workflow, /loop start
      // background actors WITHOUT a chat turn, so arm the ticker + refresh the
      // panel here too (the turn path does this in runChatTurn's finally).
      ensureChildRefreshTimer();
      refreshBackgroundTasks();
    }
  }
}

// --- Readline shim ----------------------------------------------------

/**
 * Minimum-surface readline.Interface implementation that satisfies the
 * existing slash command handlers. The handlers were written assuming a
 * real readline — they call rl.prompt() / rl.write() / rl.pause() /
 * rl.close() / rl.on(...) at various points. Under the Ink REPL there
 * is no readline; we route the calls that have a sensible analog
 * (write → composer.setComposer, close → ink.exit) and no-op the rest.
 */
interface ReadlineShimHooks {
  closeChat: () => void;
  onWriteToComposer: (text: string) => void;
  /** Register a one-shot callback for the next user submission (askYesNo). */
  waitForLine: (cb: (line: string) => void) => void;
}

function createReadlineShim(hooks: ReadlineShimHooks): EventEmitter & {
  close: () => void;
  prompt: (preserveCursor?: boolean) => void;
  pause: () => any;
  resume: () => any;
  write: (text: string) => void;
  setPrompt: (text: string) => void;
  question: (q: string, cb: (line: string) => void) => void;
  line: string;
  cursor: number;
} {
  const emitter = new EventEmitter();
  const shim = emitter as any;
  shim.close = () => { hooks.closeChat(); };
  shim.prompt = (_preserveCursor?: boolean) => { /* no-op: composer is always shown */ };
  shim.pause = () => shim;
  shim.resume = () => shim;
  shim.write = (text: string) => { hooks.onWriteToComposer(text); };
  shim.setPrompt = (_text: string) => { /* no-op: prompt label is the footer pill */ };
  // Promise-shaped `question` for askYesNo: print the prompt text via
  // console.log (Ink's patchConsole bubbles it above the redraw region)
  // and stash the callback for the next submission.
  shim.question = (q: string, cb: (line: string) => void) => {
    process.stdout.write(q);
    hooks.waitForLine(cb);
  };
  shim.line = '';
  shim.cursor = 0;
  return shim;
}
