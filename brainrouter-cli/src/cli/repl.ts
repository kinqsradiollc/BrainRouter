import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Agent } from '../agent/agent.js';
import type { McpClientWrapper } from '../runtime/mcpClient.js';
import type { Config } from '../config/config.js';
import { expandMentions } from '../memory/mentions.js';
import { addGoalTokens, buildBudgetSteeringMessage, formatBudget, goalHasBudgetLeft, goalIsOnFinalBudgetTurn, readGoal, tickGoalIteration, usageLimitGoal } from '../state/goalStore.js';
import { readPreferences } from '../state/preferencesStore.js';
import { execSync } from 'node:child_process';
import type { WorkspaceInfo } from '../config/workspace.js';
import { listSessions } from '../orchestration/orchestrator.js';
import { isPickerActive, setActiveReadline } from './cliPrompt.js';
import { resolveTheme } from './theme.js';
import { buildBannerInputs, renderBanner } from './banner.js';
import { isKnownSegment, renderSegments } from './statusline.js';
// Category dispatch — extracted slash-command handlers. Each module exports
// a tryHandleX(ctx) that returns true iff it matched the command. Walked
// in order; first match wins, no match falls through to the legacy switch.
import { tryHandleMemoryCommand } from './commands/memory.js';
import { tryHandleUiCommand } from './commands/ui.js';
import { tryHandleWorkflowCommand } from './commands/workflow.js';
import { tryHandleObsCommand } from './commands/obs.js';
import { tryHandleOrchestrationCommand } from './commands/orchestration.js';
import { tryHandleSessionCommand } from './commands/session.js';
import { tryHandleGuardCommand } from './commands/guard.js';

const execPromise = promisify(exec);

// Setup marked terminal rendering
marked.use(markedTerminal({
  showSectionPrefix: false,
}));

/**
 * All slash commands the REPL recognizes. Used for tab autocomplete and for
 * the readline completer. Keep alphabetically grouped roughly by surface area.
 */
const SLASH_COMMANDS = [
  '/help', '/status', '/workspace', '/where', '/tools', '/skills', '/plan', '/transcript',
  '/doctor', '/config', '/diff', '/commit', '/clear', '/compact', '/exit', '/quit',
  '/roles', '/agents', '/agent', '/spawn', '/wait',
  '/spec', '/feature-dev', '/review', '/implement-plan', '/skill', '/workflows', '/approve',
  '/memory', '/recall', '/briefing', '/scenes', '/working', '/forget',
  '/init', '/sessions', '/resume', '/model', '/mcp',
  '/goal', '/copy', '/fork', '/rename', '/permissions', '/hooks', '/hookify', '/loop',
  '/continue', '/auto-review', '/vim', '/statusline', '/quiet',
  '/handover', '/explain', '/trace', '/failed', '/verify', '/audit',
  '/export', '/import', '/persona', '/skill-hints', '/diagnostics',
  '/tokens', '/watch', '/yolo', '/sandbox', '/kill',
  // workflow & ergonomics commands
  '/theme', '/title', '/personality', '/new', '/side', '/btw', '/raw',
  '/feedback', '/rollout', '/ps', '/stop', '/logout', '/apps', '/plugins',
  '/experimental', '/memories', '/debug-config', '/mention', '/keymap', '/ide',
  '/test-picker',
] as const;

export function startREPL(agent: Agent, mcpClient: McpClientWrapper, config: Config, workspace?: WorkspaceInfo) {
  const theme = resolveTheme(agent.workspaceRoot);
  const banner = renderBanner(
    buildBannerInputs(config, agent, mcpClient),
    theme,
  );
  console.log('\n' + banner);
  // Offline-mode advisory stays as a separate line below the box so the
  // colored warning isn't easy to miss when scanning past banner chrome.
  // Carries the remediation hint that used to live as a duplicate pre-banner
  // warning in the chat command's catch block.
  if (!mcpClient.isConnected()) {
    console.log(theme.warning('  ⚠️  OFFLINE MODE — MCP server unreachable. Memory recall, skills, and capture are disabled.'));
    console.log(theme.muted('       Local tools (file edits, shell, web fetch, spawn_agent) still work.'));
    console.log(theme.muted('       Start the MCP server and restart the CLI to restore full functionality.'));
  }
  console.log(
    theme.muted('  Type ') + theme.info('/help') +
    theme.muted(' for commands · ') + theme.info('/where') +
    theme.muted(' for current state · just start typing your prompt.\n'),
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Explicit `terminal: true` instead of relying on the auto-detect from
    // `input.isTTY`. The auto-detect returns `undefined` in some shells /
    // terminal multiplexers (tmux on certain platforms, VS Code's integrated
    // terminal with specific settings, ssh -t pipelines), and a falsy value
    // means readline falls back to a non-TTY interface — no keypress events,
    // no raw mode, Backspace echoes as `^?` instead of erasing.
    terminal: true,
    // Initial prompt uses the resolved theme's primary accent so light/mono
    // users get a readable prompt even on the first draw. refreshPromptForMode
    // re-renders immediately after wiring up the access-mode accent, so this
    // initial value mostly governs the millisecond before that runs.
    prompt: theme.primary('brainrouter> '),
    // Tab-completion: complete slash commands when the line begins with "/"
    // and complete workspace file paths when the user is mid-`@mention`.
    completer: (line: string): [string[], string] => {
      const atMatch = line.match(/@([^\s]*)$/);
      if (atMatch) {
        const partial = atMatch[1];
        const candidates = completeWorkspacePath(agent.workspaceRoot, partial);
        return [candidates.map((c) => `@${c}`), `@${partial}`];
      }
      if (line.startsWith('/')) {
        const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
        return [hits.length ? hits : SLASH_COMMANDS.slice(), line];
      }
      return [[], line];
    },
  });

  // Belt-and-suspenders: force-engage raw-mode keypress handling on stdin.
  // readline.createInterface does this internally for a TTY input, but its
  // auto-init is unreliable across the terminal zoo (tmux, screen, VS Code
  // integrated terminal, certain SSH setups) — when it doesn't engage, the
  // symptom is Backspace echoing `^?` and arrow keys echoing `^[[A` instead
  // of doing what they're supposed to do. Calling these here is a no-op when
  // readline already did them, and a fix in the cases where it didn't.
  if (process.stdin.isTTY) {
    try {
      readline.emitKeypressEvents(process.stdin);
      (process.stdin as any).setRawMode?.(true);
    } catch { /* not a real TTY after all */ }
  }

  // GitHub PR detection cache. `gh pr view` takes ~300ms and prompts often
  // refresh many times per turn; cache the result for 30s. Returns either
  // a string like "#42" or null when there's no PR / gh not installed.
  let prCache: { value: string | null; cachedAt: number } | null = null;
  const PR_CACHE_TTL_MS = 30_000;
  const detectGitHubPR = (cwd: string): string | null => {
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
    } catch {
      // gh missing, not a PR branch, or not a github repo — fine.
    }
    prCache = { value, cachedAt: now };
    return value;
  };

  // Reflect the current access mode and any configured statusline segments
  // in the prompt. Configurable via /statusline; default just shows the mode.
  // Segment expansion lives in ./statusline.ts so the segment vocabulary is
  // one source of truth for both /statusline and the prompt renderer.
  const renderStatusline = (): string => {
    const prefs = readPreferences(agent.workspaceRoot);
    const requested = prefs.statusline.split(',').map((s) => s.trim()).filter(Boolean);
    const segments = requested.filter(isKnownSegment);
    return renderSegments(segments, {
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      accessMode: agent.getAccessMode(),
      model: agent.getModel(),
      lastTurnUsage: agent.lastTurnUsage,
      prDetector: () => detectGitHubPR(agent.workspaceRoot),
    }).join(' · ');
  };
  const refreshPromptForMode = () => {
    const mode = agent.getAccessMode();
    // Mode-to-token mapping reads as semantic intent rather than raw color:
    //   read  → success  (least dangerous; matches the ✓ established for "ok")
    //   write → primary  (brand accent; the default writable mode)
    //   shell → danger   (escalated capability; same color as failed tools)
    // Theme tokens mean BRAINROUTER_THEME=light|mono actually affects the
    // prompt — the surface the user stares at most. Previously hard-coded
    // chalk.hex('#CC9166')/red/green ignored the user's theme entirely.
    const accent = mode === 'shell' ? theme.danger : mode === 'write' ? theme.primary : theme.success;
    const line = renderStatusline();
    rl.setPrompt(accent(`brainrouter[${line}]> `));
    // The terminal title shares the same trigger conditions as the prompt:
    // any time the prompt redraws (mode change, post-turn, post-spawn), the
    // awaiting-input count or active model may have shifted. Cheap call.
    refreshTerminalTitle();
  };

  // When a /goal is active, after each turn we schedule the NEXT turn
  // automatically. The flag tracks whether such a continuation is pending so
  // user input (next line typed) cancels it before it fires. Declared early
  // so refreshTerminalTitle() (below) can read it for the awaiting-count.
  let pendingContinuation = false;

  // Returns the number of child agents currently in `pending` or `running`
  // status — used by the tab title to surface "needs attention" counts.
  const getRunningChildCount = (): number => {
    try {
      const sessions = listSessions(agent.workspaceRoot);
      return sessions.filter((s) => s.status === 'pending' || s.status === 'running').length;
    } catch {
      return 0;
    }
  };

  // Dynamic terminal tab title. Refreshed at startup AND whenever the agent
  // count / awaiting state changes (after each turn, post-spawn). Prefixes
  // a "(N) " count when there's work requiring attention — pending
  // continuation OR a running child — so background tabs surface attention
  // without focus.
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
      // Awaiting-input prefix: pendingContinuation OR any running children.
      const awaitingCount = (pendingContinuation ? 1 : 0) + getRunningChildCount();
      const prefix = awaitingCount > 0 ? `(${awaitingCount}) ` : '';
      process.stdout.write(`\x1b]0;${prefix}brainrouter · ${parts.join(' · ')}\x07`);
    } catch { /* terminal doesn't support OSC titles */ }
  };

  // Quiet mode: hides recall tables, briefing dumps, tool-completion previews.
  // Env var (`BRAINROUTER_QUIET`, set by --quiet flag) wins for the session;
  // /quiet writes through to preferences AND mirrors into the env so toggling
  // back-and-forth keeps a single source of truth at read time.
  const isQuiet = (): boolean => {
    if (process.env.BRAINROUTER_QUIET === '1') return true;
    try {
      return readPreferences(agent.workspaceRoot).quiet === true;
    } catch {
      return false;
    }
  };

  refreshPromptForMode();
  refreshTerminalTitle();

  // Vim mode: readline supports editorMode 'vi' via setRawMode + tty.
  // We honor the persisted preference at startup so users don't have to
  // re-toggle it each session.
  const initialPrefs = readPreferences(agent.workspaceRoot);
  if (initialPrefs.editorMode === 'vi') {
    process.stdout.write(chalk.gray('Vim mode enabled (composer uses vi keybindings). Toggle with /vim.\n'));
    // Node's readline doesn't natively expose vi mode; we approximate by
    // emitting a hint and trusting the user's terminal/inputrc. A future
    // pass can swap in a custom keypress handler for full Vim semantics.
  }

  // Shift+Tab cycles the access mode.
  // Order: read → write → shell → read …
  // NOTE: a previous version called `setRawMode(false)` here, claiming it
  // was needed for keypress events. The opposite is true — readline enables
  // raw mode automatically for a TTY input, and disabling it breaks BOTH
  // (a) keypress event delivery for shift+tab (which depend on raw bytes)
  // and (b) Backspace handling at the prompt (readline expects to receive
  // the raw 0x7F itself; in cooked mode the terminal's line discipline
  // owns it and readline's internal buffer drifts out of sync). Leave the
  // default in place.
  process.stdin.on('keypress', (_str, key) => {
    // The ask_user_choice picker owns stdin while it's on screen; yield to
    // it or shift+tab would cycle the access mode mid-picker.
    if (isPickerActive()) return;
    if (key && key.name === 'tab' && key.shift) {
      const cycle: Array<'read' | 'write' | 'shell'> = ['read', 'write', 'shell'];
      const current = agent.getAccessMode() as 'read' | 'write' | 'shell';
      const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
      agent.setAccessMode(next);
      refreshPromptForMode();
      process.stdout.write(`\n${chalk.gray(`Access mode → ${next}`)}\n`);
      rl.prompt();
    }
  });

  // Publish the rl interface to cliPrompt.ts so out-of-scope helpers
  // (askYesNo, safePrintAbovePrompt) can talk to the same stdin/stdout
  // pair the REPL owns. Cleared on close.
  setActiveReadline(rl);
  rl.on('close', () => { setActiveReadline(undefined); });

  rl.prompt();

  let isProcessing = false;
  // (pendingContinuation declared earlier alongside the title refresh helpers.)

  // Idle help hint: one-time per session. 30s after the prompt appears (and
  // while neither a turn nor a pending continuation is running), print a
  // single discoverability nudge so first-time users find /help and /where.
  // Dismissed permanently as soon as it fires or the user starts typing.
  // safePrintAbovePrompt is defined further down — the actual call only
  // happens via setTimeout (30s after declaration), so by firing time
  // safePrintAbovePrompt has been bound, no TDZ in practice.
  let idleHintFired = false;
  let idleHintTimer: NodeJS.Timeout | undefined;
  const clearIdleHint = () => {
    if (idleHintTimer) {
      clearTimeout(idleHintTimer);
      idleHintTimer = undefined;
    }
  };
  const armIdleHint = () => {
    if (idleHintFired || !process.stdout.isTTY) return;
    clearIdleHint();
    idleHintTimer = setTimeout(() => {
      if (idleHintFired || isProcessing || pendingContinuation) return;
      idleHintFired = true;
      safePrintAbovePrompt(
        chalk.gray('  Tip: press ') + chalk.cyan('?') + chalk.gray(' or ') +
        chalk.cyan('/help') + chalk.gray(' for commands, ') + chalk.cyan('/where') +
        chalk.gray(' for current state.'),
      );
    }, 30_000);
    if (typeof (idleHintTimer as any).unref === 'function') {
      // unref so a fully-idle CLI can still exit cleanly on Ctrl-C / SIGTERM.
      (idleHintTimer as any).unref();
    }
  };

  /**
   * Prompt the agent receives for iterations 2..N of an active goal —
   * fired automatically by the post-turn loop after each completed turn.
   * Orients the model around the active objective, forces an evidence
   * audit, and refuses prose-only "I will continue" answers.
   *
   * Distinct from `buildGoalKickoffPrompt` (in `commands/_helpers.ts`),
   * which is the FIRST-turn prompt fired by `/goal <text>` and `/goal resume`.
   */
  const buildGoalContinuationPrompt = (
    goal: import('../state/goalStore.js').Goal,
    lastPrompt: string,
    lastAnswer: string,
  ): string => {
    const iter = goal.budget.iterationsUsed + 1;
    const cap = formatBudget(goal.budget.maxIterations);
    const remaining = cap === 'unlimited' ? 'unlimited' : String(Math.max(0, goal.budget.maxIterations - iter));
    return [
      `[GOAL CONTINUATION — iteration ${iter}/${cap}, ${remaining} remaining]`,
      '',
      '## ⚠️  Your goal (re-anchor — read before doing anything else)',
      '',
      `> ${goal.text}`,
      '',
      'Every action this turn MUST serve that goal. If a tool result, child agent\'s output, or prior turn\'s conclusion is pulling you toward a tangent, IGNORE the tangent and refocus. The goal is your contract — not the most recent shiny thing in the chat.',
      '',
      '**Drift check (mandatory):** if the last 2 tool calls didn\'t move toward the goal statement above, STOP and either (a) take a tool action that does, or (b) call `goal_complete`/`goal_blocked`. Restating intent in prose without a tool call is anti-spin and the loop will halt.',
      '',
      `Last user message: ${lastPrompt || '(none)'}`,
      `Your previous response (truncated): ${lastAnswer.slice(0, 600)}${lastAnswer.length > 600 ? '…' : ''}`,
      '',
      '## What to do this turn',
      '1. **Audit the evidence in this thread** against the goal\'s outcome. Look at files you wrote, tests you ran, tools that returned ok=true.',
      '2. **Decide one of three:**',
      '   - If the outcome is met with concrete evidence (file paths, test names, command outputs), **write the user-visible answer / analysis / summary as prose AND THEN call `goal_complete` with a short 1–2 sentence proof — in the SAME response.** The proof is audit metadata; the prose is what the user reads. Skipping the prose means the user sees a placeholder.',
      '   - If no defensible path forward remains without user input or missing materials, **write the user-visible explanation as prose AND THEN call `goal_blocked` with a reason + needed input.**',
      '   - Otherwise (mid-goal), take the **next concrete tool action** (read a file, write code, spawn a worker child, run a verifier). Do NOT respond with prose like "I will now do X" — that\'s a no-op and the CLI will stop the continuation. Anti-spin applies to mid-goal turns; the final goal-completing turn requires prose.',
      '3. Use update_plan to track progress if you haven\'t already.',
      '',
      '**Tool call mechanics reminder:** `goal_complete({...})` / `goal_blocked({...})` / `update_plan({...})` MUST be invoked via the structured `tool_calls` channel of your assistant message. Writing the function name and arguments as text/markdown/pseudo-code in your prose does NOTHING — the framework does not parse prose. If you intend to call a tool, emit it as a tool call.',
      '',
      'Reminder: each iteration costs context. Pick the highest-leverage action that moves the goal forward.',
    ].join('\n');
  };

  /**
   * Print a line of output while the readline prompt is showing without
   * clobbering whatever the user is mid-typing. Used by child-agent callbacks
   * that fire AFTER the parent's runTurn returned — the agent's tool events
   * keep streaming for a while because children run detached, and naive
   * console.log + spinner.start() would steal the input row.
   */
  const safePrintAbovePrompt = (msg: string): void => {
    if (!process.stdout.isTTY) {
      console.log(msg);
      return;
    }
    // \r → column 0, \x1b[2K → clear the whole line, including any prompt + typed text.
    process.stdout.write('\r\x1b[2K');
    console.log(msg);
    // Redraw the prompt and re-render the in-progress input buffer.
    try { (rl as any)._refreshLine?.(); } catch { rl.prompt(true); }
  };

  // Now that safePrintAbovePrompt is bound, arm the idle hint for the first
  // time. Subsequent arming happens after each prompt redraw in runAgentTurn.
  armIdleHint();

  /** Run a turn programmatically (used by `/continue` and the line handler). */
  const runAgentTurn = async (rawInput: string): Promise<void> => {
    if (isProcessing) {
      console.log(chalk.yellow('\nA previous turn is still running.\n'));
      return;
    }
    isProcessing = true;
    rl.pause();
    const { expanded, mentions } = expandMentions(rawInput, agent.workspaceRoot);
    if (mentions.length > 0 && !isQuiet()) {
      console.log(chalk.gray(`📎  Attached ${mentions.length} file${mentions.length === 1 ? '' : 's'}: ${mentions.map((m) => m.token).join(', ')}`));
    }
    const startedAt = Date.now();
    const spinner = ora(chalk.gray('Agent starting...')).start();
    // Once the parent's runTurn returns, child agents may still emit tool
    // events asynchronously. After this flag flips, we MUST NOT touch the
    // spinner (which is already .succeeded) — restarting it would steal the
    // readline row and the user would feel like they can't type.
    let parentDone = false;
    const tickStatus = (status: string) => {
      if (parentDone) return;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = agent.lastTurnUsage;
      const tokens = u.calls > 0 ? `  ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓` : '';
      spinner.text = chalk.gray(`${status}  ${elapsed}s${tokens}`);
    };
    try {
      const answer = await agent.runTurn(expanded, {
        onStatusUpdate: tickStatus,
        onToolStart: (name, args) => {
          // Quiet mode: skip tool-start chrome entirely. The spinner already
          // reflects "something is happening" and the final prose tells the
          // story. Errors still surface via onToolEnd's failure branch.
          if (isQuiet()) return;
          // Render spawn_agent / spawn_agents specially — a one-liner
          // ("Ran agent <role> — <one-line task>") so a fan-out of 5
          // children produces 5 clean lines instead of 5 JSON dumps. The
          // raw JSON is still in the transcript for debugging.
          let line: string;
          if (name === 'spawn_agent') {
            const role = chalk.magenta(String((args as any)?.role ?? 'agent'));
            const label = (args as any)?.label ? chalk.gray(` [${(args as any).label}]`) : '';
            const task = String((args as any)?.prompt ?? '').replace(/\s+/g, ' ').trim();
            const preview = chalk.gray(task.length > 100 ? task.slice(0, 99) + '…' : task);
            line = chalk.gray('🤖  Spawning agent: ') + role + label + chalk.gray(' — ') + preview;
          } else if (name === 'spawn_agents') {
            const agents = Array.isArray((args as any)?.agents) ? (args as any).agents : [];
            const summary = agents
              .map((a: any) => chalk.magenta(String(a?.role ?? 'agent')))
              .join(chalk.gray(', '));
            line = chalk.gray(`🤖  Spawning ${agents.length} agent${agents.length === 1 ? '' : 's'} in parallel: `) + summary;
          } else {
            line = chalk.gray('🛞  Calling tool: ') + chalk.cyan(name) + chalk.gray(`(${JSON.stringify(args).slice(0, 240)})`);
          }
          if (parentDone) { safePrintAbovePrompt(line); return; }
          spinner.stop();
          console.log(line);
        },
        onToolEnd: (name, result) => {
          // Quiet mode: only print on failure. Successes are invisible — the
          // prose answer or downstream tool calls speak for themselves.
          if (isQuiet() && result.success) {
            tickStatus('Thinking');
            spinner.start();
            return;
          }
          const line = result.success
            ? chalk.green('✓  Tool ') + chalk.cyan(name) + chalk.green(' completed: ') + chalk.gray(result.summary)
            : chalk.red('❌  Tool ') + chalk.cyan(name) + chalk.red(' failed: ') + chalk.yellow(result.summary);
          // Inspection-tool preview: indented under the summary so the user
          // sees the actual result (directory listing, grep matches, glob
          // paths) even when the LLM later replies with only a stub like
          // "I have listed the directory." Capped to a handful of lines in
          // getToolPreview itself. Quiet mode drops the preview even on
          // failure — the summary tells the user what broke; the preview is
          // for diagnosing why and isn't worth the screen real-estate.
          const previewBlock = result.preview && !isQuiet()
            ? '\n' + result.preview.split('\n').map((l) => chalk.gray('    ' + l)).join('\n')
            : '';
          const composed = line + previewBlock;
          if (parentDone) { safePrintAbovePrompt(composed); return; }
          console.log(composed);
          tickStatus('Thinking');
          spinner.start();
        },
        onPlanUpdate: (items, explanation) => {
          if (parentDone) {
            safePrintAbovePrompt(chalk.gray(`📋  Plan updated (${items.length} item${items.length === 1 ? '' : 's'})`));
            return;
          }
          spinner.stop();
          console.log(chalk.gray('📋  Plan updated:'));
          if (explanation) console.log(chalk.gray(`    ${explanation}`));
          for (const item of items) {
            const mark = item.status === 'completed' ? chalk.green('✓')
              : item.status === 'in_progress' ? chalk.yellow('⏳')
              : chalk.gray('☐');
            const text = item.status === 'completed' ? chalk.gray(item.step) : item.step;
            console.log(`    ${mark} ${text}`);
          }
          tickStatus('Thinking');
          spinner.start();
        },
        onChildComplete: (event) => {
          const head = event.status === 'completed'
            ? chalk.green(`🏁  Agent ${event.childId} (${event.role}) completed`)
            : chalk.red(`💥  Agent ${event.childId} (${event.role}) failed`);
          const tail = event.status === 'completed' && event.preview
            ? chalk.gray(` — ${event.preview}`)
            : event.error ? chalk.yellow(` — ${event.error}`) : '';
          const line = head + tail;
          if (parentDone) { safePrintAbovePrompt(line); return; }
          spinner.stop();
          console.log(line);
          tickStatus('Thinking');
          spinner.start();
        },
        onMemoryEvent: (event) => {
          // Quiet mode: silence briefing/capture/citation chatter. Keep
          // contradictions audible — those are warnings the user should see.
          if (isQuiet() && event.kind !== 'contradiction') return;
          let line: string | undefined;
          if (event.kind === 'briefing') {
            const src = event.sources.length > 0 ? event.sources.join(', ') : '(none)';
            line = chalk.gray(`🧠  Briefing: ${event.recordCount} record${event.recordCount === 1 ? '' : 's'} from ${src}`);
          } else if (event.kind === 'capture') {
            // Truthful capture line: show sensory rows actually written, and
            // — critically — flag when extraction silently failed. The old
            // line said "Captured turn → memory" even when 0 cognitive
            // records came out the other end, which made the user think
            // their conversation was searchable when nothing of the sort
            // was happening.
            const sensory = event.sensoryRecorded ?? event.messageCount;
            const extracted = event.extractedCount;
            const triggered = event.extractionTriggered;
            const sk = event.sessionKey.slice(0, 12);
            if (event.extractionWarning) {
              line = chalk.yellow(
                `💾  Captured ${sensory} sensory msg(s) in ${sk}… — ⚠️ ${event.extractionWarning}`,
              );
            } else if (triggered && typeof extracted === 'number') {
              if (extracted > 0) {
                line = chalk.gray(
                  `💾  Captured ${sensory} msg(s) → ${extracted} cognitive record(s) extracted (${sk}…)`,
                );
              } else {
                // LLM ran successfully but found nothing notable to promote
                // (greeting, trivial exchange, all-duplicates). NOT an error.
                line = chalk.gray(
                  `💾  Captured ${sensory} msg(s) → no new memories worth promoting (${sk}…)`,
                );
              }
            } else if (triggered === false) {
              // Sensory landed; extractor below the every-N-turn threshold.
              line = chalk.gray(`💾  Captured ${sensory} msg(s) → sensory buffer (${sk}…)`);
            } else {
              line = chalk.gray(`💾  Captured ${sensory} msg(s) → memory (${sk}…)`);
            }
          } else if (event.kind === 'citation' && event.recordIds.length > 0) {
            line = chalk.gray(`📌  Reinforced ${event.recordIds.length} record${event.recordIds.length === 1 ? '' : 's'}: ${event.recordIds.slice(0, 3).join(', ')}${event.recordIds.length > 3 ? '…' : ''}`);
          } else if (event.kind === 'contradiction') {
            line = chalk.yellow(`⚠️  Memory contradiction: ${event.warning.slice(0, 140)}`);
          }
          if (!line) return;
          if (parentDone) { safePrintAbovePrompt(line); return; }
          spinner.stop();
          console.log(line);
          tickStatus('Thinking');
          spinner.start();
        },
      });
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = agent.lastTurnUsage;
      const tokenSummary = u.calls > 0
        ? chalk.gray(` · ${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out across ${u.calls} call${u.calls === 1 ? '' : 's'}`)
        : '';
      parentDone = true;
      spinner.succeed(chalk.green(`Done!${chalk.gray(` ${elapsed}s`)}${tokenSummary}`));
      const prefsForRender = readPreferences(agent.workspaceRoot);
      const rendered = prefsForRender.rawScrollback ? answer : marked.parse(answer);
      console.log('\n' + rendered + '\n');
      const warning = agent.takeContradictionWarning();
      if (warning) {
        console.log(chalk.yellow(`⚠️  Memory: ${warning}`));
        console.log(chalk.gray(`    Use /memory or /briefing to investigate, /forget <id> to archive obsolete records.\n`));
      }
    } catch (err: any) {
      parentDone = true;
      spinner.fail(chalk.red('Execution failed'));
      console.error(chalk.red(`\nError: ${err.message}\n`));
    } finally {
      isProcessing = false;
      // Clear any active skill latched by /skill / /feature-dev / /spec /
      // /review / /implement-plan so subsequent plain prompts don't keep
      // spiking the same skill. The skill memetic potential still decays
      // server-side on its own half-life; this just stops attribution.
      agent.activeSkill = undefined;

      // Auto-continuation logic. Rules:
      //   - the goal must be active (not paused / complete / blocked / usage_limited)
      //   - the turn made at least one tool call (prose-only turns are anti-spin)
      //   - we still have iteration AND token budget left
      //   - the agent didn't call goal_complete / goal_blocked this turn
      //
      // BEFORE checking, accumulate this turn's tokens into the goal's
      // running tally. If that tips us over a token cap, transition to
      // `usage_limited` instead of continuing — same effect as exhausting
      // the iteration cap, but distinguishable in status.
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
        console.log(chalk.green(`\n🎯  Goal achieved — ${goalAfter.blockedReason ?? 'evidence on record.'}\n`));
      } else if (goalAfter && goalAfter.status === 'blocked') {
        console.log(chalk.yellow(`\n🚧  Goal blocked: ${goalAfter.blockedReason ?? '(no reason)'}\n`));
        console.log(chalk.gray(`    Resolve the blocker, then /goal resume to continue.\n`));
      } else if (goalAfter && goalAfter.status === 'usage_limited') {
        console.log(chalk.yellow(`\n⏸  Goal hit usage limit: ${goalAfter.blockedReason ?? 'budget exhausted'}.`));
        console.log(chalk.gray(`    Raise the cap with /goal budget <n> or /goal tokens <n>, then /goal resume.\n`));
      } else if (goalAfter && goalAfter.status === 'active' && !goalHasBudgetLeft(goalAfter)) {
        // Iteration cap reached — transition to usage_limited so the user
        // gets a consistent resumable state regardless of which cap tripped.
        const reason = `Iteration budget exhausted (${goalAfter.budget.iterationsUsed}/${formatBudget(goalAfter.budget.maxIterations)}).`;
        const limited = usageLimitGoal(agent.workspaceRoot, agent.sessionKey, reason);
        console.log(chalk.yellow(`\n⏸  ${reason} Extend with /goal budget <n> and /goal resume, mark /goal complete, or /goal clear.\n`));
        if (limited) goalAfter = limited;
      } else if (goalAfter && goalAfter.status === 'active' && agent.lastTurnToolCalls === 0) {
        console.log(chalk.gray(`(goal continuation suppressed: last turn made no tool calls — anti-spin)\n`));
      }
      rl.resume();
      refreshPromptForMode(); // pick up token-meter / branch updates
      rl.prompt();
      // Re-arm the idle hint after each completed turn — a user who walks
      // away after a turn ends still gets one nudge if they hadn't seen it.
      armIdleHint();
      if (shouldContinue && goalAfter) {
        pendingContinuation = true;
        const next = goalAfter.budget.iterationsUsed + 1;
        // Pre-tick steering: if the NEXT turn would be the final one inside
        // the budget, inject a wrap-up directive so the model lands soft
        // instead of being cut off mid-thought.
        //
        // CRITICAL: also drop any stale steering when the next turn is NOT
        // final. Without this, a previously-injected "wrap up gracefully"
        // message would persist after the user extended the budget via
        // /goal budget or /goal tokens, telling the model "this is your
        // last turn" for every subsequent turn. The removal is idempotent
        // — if no steering was set, this is a no-op.
        const finalBudgetTurn = goalIsOnFinalBudgetTurn(goalAfter);
        if (finalBudgetTurn) {
          agent.replaceTaggedSystemMessage('goal-budget-steering', buildBudgetSteeringMessage(goalAfter));
          console.log(chalk.gray(`(final budget turn — wrap-up steering injected)`));
        } else {
          agent.removeTaggedSystemMessage('goal-budget-steering');
        }
        console.log(chalk.gray(`(goal continuation queued — iteration ${next}/${formatBudget(goalAfter.budget.maxIterations)}; type anything to cancel)`));
        const followUp = buildGoalContinuationPrompt(goalAfter, agent.lastUserPrompt, agent.lastAnswer);
        setImmediate(() => {
          if (!pendingContinuation || isProcessing) return; // user cancelled or busy
          pendingContinuation = false;
          tickGoalIteration(agent.workspaceRoot, agent.sessionKey);
          void runAgentTurn(followUp);
        });
      }
    }
  };

  rl.on('line', async (line) => {
    // User typed anything → drop the pending idle-hint timer regardless of
    // whether the input itself is meaningful. Empty enter still counts as
    // engagement; we don't want to nag a user who's clearly at the keyboard.
    clearIdleHint();
    // User typed: any pending goal continuation is cancelled.
    if (pendingContinuation) {
      pendingContinuation = false;
      console.log(chalk.gray('(goal continuation cancelled by user input)'));
    }
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Treat a bare "?" as /help — the idle-hint tip advertises it, so make
    // it actually work. Anything beyond "?" (a real prompt) falls through.
    if (input === '?') {
      renderHelp();
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      // Split on any whitespace, not a literal space. Without this, a slash
      // command followed by a tab (autocomplete completion that wasn't
      // consumed) or a trailing newline ends up as command="/help\t" which
      // would fall through to "Unknown slash command".
      const parts = input.trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      // Wrap the slash-command dispatcher so a thrown error or rejected
      // promise can never leave the REPL without a prompt. Without this, a
      // bug inside any /command (file write, MCP call, etc.) bricks the
      // session because the user never sees the prompt come back.
      try {
        await handleSlashCommand(command, args, agent, mcpClient, config, rl, {
          refreshPromptForMode,
          isProcessing: () => isProcessing,
          runAgentTurn: (prompt: string) => { void runAgentTurn(prompt); },
          runAgentTurnAsync: (prompt: string) => runAgentTurn(prompt),
        });
      } catch (err: any) {
        console.error(chalk.red(`\nSlash command "${command}" failed: ${err?.message ?? err}\n`));
      } finally {
        // The /continue and /side/btw cases own their own prompt cycle via
        // runAgentTurn — only re-prompt if no turn is in flight.
        if (!isProcessing) rl.prompt();
      }
      return;
    }

    if (isProcessing) {
      console.log(chalk.yellow('\nA previous turn is still running. Wait for the prompt before sending another message.\n'));
      rl.prompt();
      return;
    }

    await runAgentTurn(input);
  });

  rl.on('SIGINT', async () => {
    console.log(chalk.yellow('\nExiting session...'));
    rl.close();
  });

  rl.on('close', async () => {
    await mcpClient.close();
    console.log(chalk.bold.hex('#CC9166')('Goodbye!\n'));
    process.exit(0);
  });
}

interface ReplContext {
  /** Refresh the readline prompt (color reflects access mode + status segments). */
  refreshPromptForMode: () => void;
  /** True while the REPL is mid-turn; loop ticks should defer when set. */
  isProcessing: () => boolean;
  /** Programmatically run an agent turn (used by `/continue` and friends). */
  runAgentTurn: (prompt: string) => void;
  /**
   * Awaitable variant — same semantics but the caller can attach a `.finally`
   * to do post-turn cleanup. Used by `/side` and `/btw` to restore the parent
   * sessionKey after the side conversation finishes (the old setTimeout(100)
   * race restored the key before the turn ever finished, polluting the main
   * transcript).
   */
  runAgentTurnAsync: (prompt: string) => Promise<void>;
}

/**
 * Help categories. Data-driven so /help can render an index on small
 * terminals and a focused page on `/help <category>`. The prior
 * implementation was 95 lines of console.log calls that blew past the
 * scrollback on anything under ~50 rows.
 */
interface HelpEntry { cmd: string; desc: string; }
interface HelpCategory { key: string; title: string; entries: HelpEntry[]; }

const HELP_CATEGORIES: HelpCategory[] = [
  {
    key: 'session',
    title: 'Session & State',
    entries: [
      { cmd: '/status', desc: 'Connection status, LLM config, DB stats' },
      { cmd: '/workspace', desc: 'Active workspace and session identity' },
      { cmd: '/where', desc: 'Single-screen view of workspace, workflow, goal, plan, recall, children' },
      { cmd: '/doctor', desc: 'Config, connection, memory extraction health' },
      { cmd: '/config', desc: 'View active configuration profile' },
      { cmd: '/clear', desc: 'Clear chat history for the active session' },
      { cmd: '/compact', desc: 'LLM-driven compaction of the active session' },
      { cmd: '/new [label]', desc: 'Start a new chat with a fresh session key' },
      { cmd: '/fork [label]', desc: 'Fork this chat into a new session, keep prior context' },
      { cmd: '/rename <label>', desc: 'Rename the current session' },
      { cmd: '/resume <id>', desc: 'Resume a previous session by sessionKey' },
      { cmd: '/sessions', desc: 'List persisted sessions for this workspace' },
      { cmd: '/side <q>  /btw <q>', desc: 'Ephemeral side conversation in a forked session' },
      { cmd: '/init', desc: 'Create AGENT.md in the workspace' },
      { cmd: '/exit  /quit', desc: 'Close MCP connection and exit' },
    ],
  },
  {
    key: 'memory',
    title: 'Memory & Recall',
    entries: [
      { cmd: '/memory <query>', desc: 'Search long-term memory (memory_search)' },
      { cmd: '/recall <query>', desc: 'Explicit cognitive recall (no LLM turn)' },
      { cmd: '/briefing', desc: 'Show what was recalled before the most recent turn' },
      { cmd: '/scenes', desc: 'List active focus scenes' },
      { cmd: '/working', desc: 'Show the working-memory canvas' },
      { cmd: '/working reset confirm', desc: 'Clear the canvas' },
      { cmd: '/forget <recordId>', desc: 'Archive a memory record by ID' },
      { cmd: '/memories', desc: 'Manage memory pipeline + consolidate to filesystem' },
      { cmd: '/handover', desc: 'Generate continuation note for next session' },
      { cmd: '/explain <query>', desc: 'Why recall returned what it did' },
      { cmd: '/failed [area]', desc: 'Past failed attempts for a problem area' },
      { cmd: '/verify <id> [status]', desc: 'Re-verify a memory record' },
      { cmd: '/audit', desc: 'Recent memory audit log' },
      { cmd: '/export [path]', desc: 'Dump memory + evidence + ops to JSON' },
      { cmd: '/import <path>', desc: 'Import a BrainRouter memory envelope' },
      { cmd: '/persona <name>', desc: 'Fetch a persona definition' },
      { cmd: '/skill-hints <skill> <hints>', desc: 'Register extraction hints' },
      { cmd: '/diagnostics', desc: 'Scrubbed runtime + DB stats bundle' },
    ],
  },
  {
    key: 'workflow',
    title: 'Workflows & Skills',
    entries: [
      { cmd: '/spec <title>', desc: 'Produce spec.md (spec-driven-skill)' },
      { cmd: '/feature-dev <feat>', desc: 'Multi-agent feature dev with spec + tasks' },
      { cmd: '/review [scope]', desc: 'Multi-agent code review → review.md' },
      { cmd: '/implement-plan', desc: 'Execute next plan item; append walkthrough' },
      { cmd: '/approve [slug]', desc: 'Approve workflow + kick off implementation' },
      { cmd: '/workflows', desc: 'List durable workflow folders' },
      { cmd: '/skill <name> [input]', desc: 'Run any catalogued skill' },
      { cmd: '/skills', desc: 'List installed BrainRouter skills' },
      { cmd: '/plan  /plan clear', desc: 'Show the durable CLI task plan; clear it (drops stale items)' },
      { cmd: '/tools', desc: 'List local + MCP tools available to the agent' },
      { cmd: '/goal [text|clear|complete|pause|resume|budget <n>]', desc: 'Sticky goal' },
      { cmd: '/continue', desc: 'Resume after a loop-limit abort' },
      { cmd: '/loop <interval> <prompt>  /loop stop', desc: 'Repeat a prompt on cadence' },
      { cmd: '/commit', desc: 'Generate message, stage, and git commit' },
      { cmd: '/diff', desc: 'Show git changes (stream-paginated)' },
    ],
  },
  {
    key: 'orchestration',
    title: 'Multi-Agent Orchestration',
    entries: [
      { cmd: '/roles', desc: 'List available agent roles' },
      { cmd: '/agents [--json]', desc: 'List child agent sessions' },
      { cmd: '/agent <id> [--full]', desc: 'Detail + recent transcript of a child' },
      { cmd: '/spawn <role> <prompt>', desc: 'Spawn a child agent' },
      { cmd: '/wait <id> [ms]', desc: 'Wait for a child to finish' },
      { cmd: '/kill <agent-id>', desc: 'Stop a running child' },
      { cmd: '/auto-review [on|off]', desc: 'Auto-run reviewer after every worker' },
      { cmd: '/ps', desc: 'List background tasks (loop + running children)' },
      { cmd: '/stop', desc: 'Stop the running loop, mark stale children' },
    ],
  },
  {
    key: 'guard',
    title: 'Guardrails & Permissions',
    entries: [
      { cmd: '/permissions [read|write|shell]', desc: 'View or set agent access mode' },
      { cmd: '/yolo [on|off]', desc: 'Auto-approve run_command' },
      { cmd: '/sandbox [status|add-read|add-write|remove|clear]', desc: 'Sandbox grants' },
      { cmd: '/hooks [list|add|remove|enable|disable]', desc: 'Lifecycle shell hooks' },
      { cmd: '/hookify [list|create|enable|disable|remove]', desc: 'Markdown rule guards' },
      { cmd: '/logout', desc: 'Clear API keys from the active profile' },
    ],
  },
  {
    key: 'obs',
    title: 'Observability',
    entries: [
      { cmd: '/tokens', desc: 'Session token usage + memory-savings estimate' },
      { cmd: '/watch', desc: 'Tail trace log (BRAINROUTER_TRACE_LOG required)' },
      { cmd: '/trace save <desc>  /trace search <q>', desc: 'Debug-trace store' },
      { cmd: '/transcript [main|sessionKey]', desc: 'Recent persisted transcript' },
      { cmd: '/rollout', desc: 'Print the transcript file path' },
      { cmd: '/debug-config', desc: 'Show config layers, env, preferences' },
    ],
  },
  {
    key: 'ui',
    title: 'UI & Ergonomics',
    entries: [
      { cmd: '/theme [auto|light|dark|mono]', desc: 'Markdown output theme' },
      { cmd: '/title <segments>', desc: 'Terminal title (model,session,branch,mode)' },
      { cmd: '/statusline <segments>', desc: 'Prompt (mode,branch,dirty,model,tokens,session,pr)' },
      { cmd: '/personality <style>', desc: 'concise | standard | detailed | pair-programmer' },
      { cmd: '/raw [on|off]', desc: 'Toggle raw scrollback' },
      { cmd: '/quiet [on|off]', desc: 'Hide recall tables, previews, briefings (model prose only)' },
      { cmd: '/vim', desc: 'Toggle vi-mode for the composer' },
      { cmd: '/keymap [json]', desc: 'Show built-in bindings and set overrides' },
      { cmd: '/copy', desc: 'Copy last assistant response to clipboard' },
      { cmd: '/mention [partial]', desc: 'Suggest files for @ mentions' },
      { cmd: '/model <name>', desc: 'Switch the LLM model in-session' },
      { cmd: '/mcp', desc: 'Show the active MCP server and tool namespaces' },
      { cmd: '/ide', desc: 'Show detected IDE host' },
      { cmd: '/apps  /plugins', desc: 'List workspace skills and plugin folders' },
      { cmd: '/feedback [message]', desc: 'Append feedback entry' },
      { cmd: '/experimental [on|off]', desc: 'Toggle experimental features' },
    ],
  },
];

export function renderHelp(category?: string): void {
  // Match by key OR by leading char of title (allowing /help m → memory).
  const wantedCategory = category
    ? HELP_CATEGORIES.find((c) => c.key === category || c.title.toLowerCase().startsWith(category))
    : undefined;

  // Special case: show a single category if the user asked for one explicitly.
  if (category && wantedCategory) {
    printHelpCategory(wantedCategory);
    console.log(chalk.gray('\nTry /help to see all categories. Tab autocompletes commands; @ mentions files.\n'));
    return;
  }
  if (category && !wantedCategory) {
    console.log(chalk.red(`\nUnknown help category "${category}". Available:`));
    for (const c of HELP_CATEGORIES) {
      console.log(`  ${chalk.cyan('/help ' + c.key)}  ${chalk.gray(c.title)}`);
    }
    console.log();
    return;
  }

  // No category → decide between full dump and index based on terminal height.
  const totalLines = HELP_CATEGORIES.reduce((n, c) => n + c.entries.length + 2, 0);
  const rows = process.stdout.rows ?? 9999;
  if (rows >= totalLines + 6) {
    // Tall enough — show everything.
    for (const c of HELP_CATEGORIES) printHelpCategory(c);
    console.log(chalk.gray('\nTips: @ mentions files · Tab autocompletes · Shift+Tab cycles access mode (read → write → shell).\n'));
    return;
  }
  // Small terminal — show index + per-category command count.
  console.log(chalk.bold('\nAvailable command categories:'));
  for (const c of HELP_CATEGORIES) {
    console.log(`  ${chalk.cyan('/help ' + c.key.padEnd(14))} ${chalk.gray(`${c.title}  (${c.entries.length} commands)`)}`);
  }
  console.log(chalk.gray('\nYour terminal is short — run /help <category> to drill in. Resize and re-run /help to see all at once.\n'));
}

function printHelpCategory(c: HelpCategory): void {
  console.log(chalk.bold(`\n${c.title}:`));
  // Find max command-column width for alignment.
  const colWidth = Math.min(40, c.entries.reduce((w, e) => Math.max(w, e.cmd.length), 0));
  for (const e of c.entries) {
    console.log(`  ${chalk.cyan(e.cmd.padEnd(colWidth))}  ${chalk.gray(e.desc)}`);
  }
}

async function handleSlashCommand(
  command: string,
  args: string[],
  agent: Agent,
  mcpClient: McpClientWrapper,
  config: Config,
  rl: readline.Interface,
  ctx: ReplContext,
) {
  // Category dispatch — each extracted module returns true iff it matched
  // the command. New categories should be added here as they're extracted
  // from the giant switch below. Long-term goal: shrink the switch to
  // nothing so this dispatch is the only entrypoint.
  const cmdCtx = { command, args, agent, mcpClient, config, rl, repl: ctx };
  if (await tryHandleMemoryCommand(cmdCtx)) return;
  if (await tryHandleUiCommand(cmdCtx)) return;
  if (await tryHandleWorkflowCommand(cmdCtx)) return;
  if (await tryHandleObsCommand(cmdCtx)) return;
  if (await tryHandleOrchestrationCommand(cmdCtx)) return;
  if (await tryHandleSessionCommand(cmdCtx)) return;
  if (await tryHandleGuardCommand(cmdCtx)) return;

  // All commands extracted to category files above. Anything that reaches
  // here didn't match any handler.
  console.log(chalk.red(`\nUnknown slash command: ${command}. Type /help for assistance.\n`));
}

// runOrchestrationPrompt was the second-class turn pipeline used by /spawn,
// /wait, /kill, /commit, /approve, /spec, /feature-dev, /review,
// /implement-plan, /skill. It lacked goal continuation, the isProcessing
// lock, /raw honoring, contradiction surfacing, and token summary — so any
// command that took the second-class path felt visibly weaker than a plain
// prompt. Removed in favor of routing every command through the closure's
// runAgentTurn (which has all of the above).

/**
 * Tab-completion source for `@path/to/file` mentions. Given a partial workspace
 * path, return the matching files and directories one level deep. Stays inside
 * the workspace and ignores noise dirs to keep the completion list useful.
 */
export function completeWorkspacePath(workspaceRoot: string, partial: string): string[] {
  const ignore = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '.brainrouter']);
  // Split partial into "dir/" + "prefix" so we only enumerate one directory at a time.
  const lastSlash = partial.lastIndexOf('/');
  const subdir = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;
  let absDir: string;
  try {
    absDir = path.resolve(workspaceRoot, subdir || '.');
  } catch {
    return [];
  }
  // Don't escape the workspace.
  if (path.relative(workspaceRoot, absDir).startsWith('..')) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !ignore.has(e.name) && e.name.startsWith(prefix))
    .map((e) => `${subdir}${e.name}${e.isDirectory() ? '/' : ''}`)
    .sort();
}
