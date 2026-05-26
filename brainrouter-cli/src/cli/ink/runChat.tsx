import React from 'react';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import type { Agent } from '../../agent/agent.js';
import type { McpClientPool as McpClientWrapper } from '../../runtime/mcpPool.js';
import type { Config } from '../../config/config.js';
import type { WorkspaceInfo } from '../../config/workspace.js';
import { resolveTheme } from '../theme.js';
import { buildBannerInputs, renderBanner } from '../banner.js';
import { isKnownSegment, renderSegments } from '../statusline.js';
import { readPreferences } from '../../state/preferencesStore.js';
import { listSessions } from '../../orchestration/orchestrator.js';
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
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { agent, mcpClient, config } = opts;
  const theme = resolveTheme(agent.workspaceRoot);
  const banner = renderBanner(buildBannerInputs(config, agent, mcpClient), theme);

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
  let idleHintFired = false;
  let idleHintTimer: NodeJS.Timeout | undefined;
  let controller: ChatController | undefined;
  let exited = false;

  const isQuiet = (): boolean => {
    if (process.env.BRAINROUTER_QUIET === '1') return true;
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
    const rendered = renderSegments(segments, {
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      accessMode: agent.getAccessMode(),
      model: agent.getModel(),
      lastTurnUsage: agent.lastTurnUsage,
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
        else if (seg === 'session') parts.push(agent.sessionKey.slice(0, 24));
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
      const sessions = listSessions(agent.workspaceRoot);
      return sessions.filter((s) => s.status === 'pending' || s.status === 'running').length;
    } catch {
      return 0;
    }
  };

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

    const shouldContinue =
      !!goalAfter &&
      goalAfter.status === 'active' &&
      goalHasBudgetLeft(goalAfter) &&
      agent.lastTurnToolCalls > 0 &&
      agent.lastGoalTransition === undefined;

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
    } else if (goalAfter && goalAfter.status === 'active' && agent.lastTurnToolCalls === 0) {
      controller?.push.notice(`(goal continuation suppressed: last turn made no tool calls — anti-spin)`, 'info');
    }

    if (shouldContinue && goalAfter) {
      pendingContinuation = true;
      const next = goalAfter.budget.iterationsUsed + 1;
      controller?.push.notice(`(goal continuation queued — iteration ${next}/${formatBudget(goalAfter.budget.maxIterations)}; type anything to cancel)`, 'info');
      const followUp = buildGoalContinuationPrompt(goalAfter, afterPrompt, afterAnswer);
      setImmediate(() => {
        if (!pendingContinuation || isProcessing) return;
        pendingContinuation = false;
        tickGoalIteration(agent.workspaceRoot, agent.sessionKey);
        void runChatTurn(followUp);
      });
    }
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
    isProcessing = true;
    clearIdleHint();

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
      controller!.push.setStatus(`${status}  ${elapsed}s${tokens}`);
    };

    // Per-tool start time + args — agent.runTurn fires onToolStart with
    // full args but onToolEnd only sees name + result, so we stash the
    // args here so the end-of-call scrollback row can render the
    // formatted call (`Read(src/foo.ts)`) instead of just the bare name.
    // The map key is the tool name; we treat parallel same-name calls
    // as overlapping which is fine for the duration display (the older
    // start time wins, slightly under-counting concurrent invocations).
    const toolStartTimes = new Map<string, number>();
    const toolArgsSnapshot = new Map<string, Record<string, any>>();
    try {
      const answer = await agent.runTurn(expanded, {
        onStatusUpdate: tickStatus,
        onToolStart: (name, args) => {
          // Surface the in-flight tool via the spinner status line — the
          // scrollback entry is pushed at onToolEnd so each tool call is
          // a single block (header + result), not two rows.
          toolStartTimes.set(name, Date.now());
          toolArgsSnapshot.set(name, args ?? {});
          if (!isQuiet()) {
            controller!.push.setStatus(formatToolCall(name, args));
          }
        },
        onToolEnd: (name, result) => {
          // Quiet mode hides successes (the prose response covers them).
          if (isQuiet() && result.success) {
            tickStatus('Thinking');
            return;
          }
          const startedAt = toolStartTimes.get(name);
          const args = toolArgsSnapshot.get(name);
          toolStartTimes.delete(name);
          toolArgsSnapshot.delete(name);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          const header = formatToolCall(name, args);
          controller!.push.tool(header, result.success, {
            preview: !isQuiet() ? result.preview : undefined,
            durationMs,
          });
          tickStatus('Thinking');
        },
        onPlanUpdate: (items, explanation) => {
          // Explanation rides on the plan entry itself (renders as a dim-italic
          // line above the checklist) rather than as a separate memory event,
          // so the explanation visually anchors to the plan it describes.
          controller!.push.plan(items, explanation);
          tickStatus('Thinking');
        },
        onChildComplete: (event) => {
          const ok = event.status === 'completed';
          const head = ok
            ? `🏁 Agent ${event.childId} (${event.role}) completed`
            : `💥 Agent ${event.childId} (${event.role}) failed`;
          const tail = ok && event.preview
            ? ` — ${event.preview}`
            : event.error ? ` — ${event.error}` : '';
          controller!.push.notice(head + tail, ok ? 'info' : 'error');
          tickStatus('Thinking');
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
            const sk = event.sessionKey.slice(0, 12);
            if (event.extractionWarning) {
              line = `💾 Captured ${sensory} sensory msg(s) in ${sk}… — ⚠️ ${event.extractionWarning}`;
              level = 'warn';
            } else if (triggered && typeof extracted === 'number') {
              line = extracted > 0
                ? `💾 Captured ${sensory} msg(s) → ${extracted} cognitive record(s) extracted (${sk}…)`
                : `💾 Captured ${sensory} msg(s) → no new memories worth promoting (${sk}…)`;
            } else if (triggered === false) {
              line = `💾 Captured ${sensory} msg(s) → sensory buffer (${sk}…)`;
            } else {
              line = `💾 Captured ${sensory} msg(s) → memory (${sk}…)`;
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
      });

      parentDone = true;
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
    } catch (err: any) {
      parentDone = true;
      controller.push.notice(`✗ Execution failed: ${err?.message ?? err}`, 'error');
    } finally {
      isProcessing = false;
      controller.push.setPhase('idle');
      controller.push.setStatus('');
      agent.activeSkill = undefined;
      agent.refreshSystemPrompt();
      refreshFooter();
      armIdleHint();
    }
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
        slashCommands={slashCatalog}
        promptLabel={`brainrouter[${agent.getAccessMode()}]`}
        initialAccessMode={agent.getAccessMode() as 'read' | 'write' | 'shell'}
        initialFooter={{
          model: agent.getModel(),
          session: agent.sessionKey,
          effort: readPreferences(agent.workspaceRoot).effort,
        }}
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
          refreshFooter();
          armIdleHint();
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

          if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);
            await dispatchSlash(command, args, shim);
            return;
          }

          if (isProcessing) {
            push.notice('A previous turn is still running. Wait for the prompt before sending another message.');
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
      try { await mcpClient.close(); } catch { /* already closed */ }
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
      try { await mcpClient.close(); } catch { /* already closed */ }
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
