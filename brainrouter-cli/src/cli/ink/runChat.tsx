import React from 'react';
import readline from 'node:readline';
import chalk from 'chalk';
import type { Agent } from '@kinqs/brainrouter-core/agent';
import type { Config } from '@kinqs/brainrouter-core/config';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import type { WorkspaceInfo } from '@kinqs/brainrouter-core/workspace';
import { resolveTheme } from '../theme/theme.js';
import { buildBannerInputs } from '../view/banner.js';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { runHooks } from '@kinqs/brainrouter-core/hooks';
import { InputQueue } from '../../runtime/input/inputQueue.js';
import { endTurnCheckpoint, queueOfflinePrompt, readRecoverable, clearOfflineQueue, shouldAutoReplayOffline } from '@kinqs/brainrouter-core/storage';
import { type McpClientPool as McpClientWrapper } from '@kinqs/brainrouter-core/mcp';
import { setActiveReadline } from '../prompt/cliPrompt.js';
import { ChatApp, type ChatController } from './ChatApp.js';
import type { SlashCommandDef } from './prompt/SlashPalette.js';
import { lookupSlashDescription, SLASH_COMMANDS } from '../prompt/repl.js';
import { setAmbientChat } from './chat/ambientChat.js';
import { renderWithResizeClear } from './terminal/renderWithResizeClear.js';
import { createReadlineShim } from './runChat/readlineShim.js';
import { createGitHubPRDetector } from './runChat/prDetector.js';
import type { RunChatContext } from './runChat/context.js';
import { installIdleHint } from './runChat/idleHint.js';
import { installFooter } from './runChat/footer.js';
import { installChildTracking } from './runChat/childTracking.js';
import { installCompletions } from './runChat/completions.js';
import { installGoalContinuation } from './runChat/goalContinuation.js';
import { installChildResume } from './runChat/childResume.js';
import { installInputQueueHandlers } from './runChat/inputQueueHandlers.js';
import { installTurnRunner } from './runChat/turnRunner.js';
import { installScheduleTicker } from './runChat/scheduleTicker.js';
import { installDispatch, createOnSubmit } from './runChat/dispatch.js';

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
 *
 * The turn lifecycle used to live entirely inside this function as a web
 * of closures. It is now spread across cohesive `runChat/*` modules that
 * share a single mutable `RunChatContext` (see runChat/context.ts) — the
 * behaviour is identical; the state ownership is unchanged.
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
  federation?: import('../../runtime/federation/federationRegistration.js').FederationHandle | null;
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
    closeChat: () => { ctx.exited = true; ctx.controller?.exit(); },
    onWriteToComposer: (text) => ctx.controller?.setComposer(text),
    waitForLine: (cb) => {
      ctx.questionCallback = cb;
    },
  });

  // Closure-shared state — equivalent to the readline REPL's local closures
  // in startREPL, now held in a single mutable context so the turn-lifecycle
  // helpers (spread across runChat/*) remain a single coherent owner. Helper
  // functions are assigned by the `install*` calls below; the placeholder
  // no-ops keep the object shape complete until they run (they never fire
  // before installation because nothing is mounted yet).
  const noop = () => {};
  const ctx: RunChatContext = {
    agent,
    mcpClient,
    config,
    shim,
    inputQueue: new InputQueue(),
    notifiedCompletions: new Set<string>(),
    detectGitHubPR: createGitHubPRDetector(),
    isProcessing: false,
    pendingContinuation: false,
    goalNoToolStrikes: 0,
    idleHintFired: false,
    idleHintTimer: undefined,
    controller: undefined,
    exited: false,
    questionCallback: undefined,
    lastRenderedBanner: banner,
    childResumeTimer: null,
    childRefreshTimer: null,
    lastChildCount: 0,
    refreshTickN: 0,
    scheduleTicker: null,
    isQuiet: () => false,
    armIdleHint: noop,
    clearIdleHint: noop,
    refreshFooter: noop,
    refreshTerminalTitle: noop,
    getRunningChildCount: () => 0,
    getRunningWorkerCount: () => 0,
    getRunningWorkflowCount: () => 0,
    refreshBackgroundTasks: noop,
    collectTerminalCompletions: () => [],
    notifyIdleCompletions: noop,
    cancelChildResume: () => false,
    scheduleGoalContinuation: noop,
    scheduleChildResume: noop,
    maybeResumeOnChildComplete: noop,
    handleQueueCommand: noop,
    drainInputQueue: noop,
    runChatTurn: async () => {},
    hasLiveActors: () => false,
    tickChildRefresh: noop,
    ensureChildRefreshTimer: noop,
    startTicker: noop,
    dispatchSlash: async () => {},
  };

  // Wire the turn-lifecycle helpers onto the context. Order is irrelevant —
  // the helpers reference each other only through `ctx`, which resolves at
  // call time — but grouping keeps the cohesion legible.
  installIdleHint(ctx);
  installFooter(ctx);
  installChildTracking(ctx);
  installCompletions(ctx);
  installGoalContinuation(ctx);
  installChildResume(ctx);
  installInputQueueHandlers(ctx);
  installTurnRunner(ctx);
  installScheduleTicker(ctx);
  installDispatch(ctx);

  const onSubmit = createOnSubmit(ctx);

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
          ctx.controller = ctrl;
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
            void import('../view/incomingBanner.js').then(({ formatIncomingBanner }) => {
              federation.setOnInboxText((messages) => {
                for (const m of messages) {
                  ctrl.push.notice(formatIncomingBanner(m), 'info');
                }
              });
            });
          }
          ctx.refreshFooter();
          ctx.armIdleHint();
          ctx.startTicker();
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
                const { refreshLmStudioCache } = await import('@kinqs/brainrouter-core/provider');
                const count = await refreshLmStudioCache(endpoint);
                if (count > 0) {
                  ctx.refreshFooter();
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
                const { checkForUpdate, formatUpdateBanner } = await import('../../runtime/update/updateCheck.js');
                const upd = await checkForUpdate();
                if (upd?.behind && ctx.controller) {
                  const banner = formatUpdateBanner(upd.current, upd.latest, upd.command);
                  if (banner) ctx.controller.push.notice(banner, 'info');
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
            if (rec.crashed && ctx.controller) {
              ctx.controller.push.notice(`⏮ A prompt from a previous session didn't finish — resend if still needed:\n  • ${rec.crashed.prompt.replace(/\s+/g, ' ').slice(0, 120)}`, 'info');
              endTurnCheckpoint(agent.workspaceRoot, agent.sessionKey);
            }
            const offline = rec.offline.slice(0, 3);
            if (offline.length > 0) {
              // Clear first so a still-offline replay re-queues cleanly (no doubling).
              clearOfflineQueue(agent.workspaceRoot, agent.sessionKey);
              if (shouldAutoReplayOffline({ enabled: getCliKnobs().autoReplayOffline, connected: mcpClient.isConnected(), count: offline.length }) && ctx.controller) {
                ctx.controller.push.notice(`↺ Replaying ${offline.length} prompt(s) queued while offline…`, 'info');
                void (async () => {
                  for (const q of offline) {
                    try { await ctx.runChatTurn(q.prompt); } catch { /* a re-failure is re-queued by runChatTurn */ }
                  }
                })();
              } else if (ctx.controller) {
                const lines = offline.map((p) => `  • ${p.prompt.replace(/\s+/g, ' ').slice(0, 120)}`);
                ctx.controller.push.notice(`↺ ${offline.length} prompt(s) were queued while offline — resend when ready:\n${lines.join('\n')}`, 'info');
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
          ctx.refreshFooter();
          return next;
        }}
        onSubmit={onSubmit}
      />,
      { exitOnCtrlC: true, patchConsole: true },
    );

    instance.waitUntilExit().then(async () => {
      ctx.exited = true;
      setActiveReadline(undefined);
      setAmbientChat(undefined);
      cleanupResizeClear();
      ctx.clearIdleHint();
      try { ctx.scheduleTicker?.stop(); } catch { /* noop */ }
      ctx.scheduleTicker = null;
      if (ctx.childRefreshTimer) { clearInterval(ctx.childRefreshTimer); ctx.childRefreshTimer = null; }
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
      ctx.exited = true;
      setActiveReadline(undefined);
      setAmbientChat(undefined);
      cleanupResizeClear();
      ctx.clearIdleHint();
      try { ctx.scheduleTicker?.stop(); } catch { /* noop */ }
      ctx.scheduleTicker = null;
      if (ctx.childRefreshTimer) { clearInterval(ctx.childRefreshTimer); ctx.childRefreshTimer = null; }
      try { await mcpClient.close(); } catch { /* already closed */ }
      try {
        runHooks(agent.workspaceRoot, 'session-end', {
          payload: { sessionKey: agent.sessionKey, exitReason: 'error' },
        });
      } catch { /* hook errors must not block REPL shutdown */ }
      resolve();
    });
  });
}
