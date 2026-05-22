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
import { getConfigPath } from '../config/config.js';
import { LOCAL_TOOLS } from '../agent/agent.js';
import { listTranscripts, loadTranscript, readTranscriptEntries } from '../state/sessionStore.js';
import { initAgentMd } from '../prompt/initAgentMd.js';
import { expandMentions } from '../memory/mentions.js';
import { clearGoal, completeGoal, goalHasBudgetLeft, GoalTooLongError, GOAL_TEXT_MAX_CHARS, pauseGoal, readGoal, resumeGoal, setGoal, setGoalBudget, tickGoalIteration } from '../state/goalStore.js';
import { addHook, readHooks, removeHook, setHookEnabled, type HookEvent } from '../state/hooksStore.js';
import { copyToClipboard } from '../runtime/clipboard.js';
import { getLoopState, isLoopRunning, parseInterval, startLoop, stopLoop } from '../runtime/loopRunner.js';
import { randomUUID } from 'node:crypto';
import { readPreferences, writePreferences } from '../state/preferencesStore.js';
import { execSync } from 'node:child_process';
import { clampPayload, extractMemories, renderMemoryCards } from '../memory/formatters.js';
import { formatPlan, readPlan, updatePlan } from '../state/taskStore.js';
import type { WorkspaceInfo } from '../config/workspace.js';
import { listRoles } from '../orchestration/roles.js';
import { formatSessionSummary, getSession, listSessions, reconcileStale } from '../orchestration/orchestrator.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from '../prompt/skillRunner.js';
import { callMcpTool, childSessionKey } from '../runtime/mcpUtils.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, listWorkflows, readArtifact, slugify, updateWorkflowStatus } from '../state/workflowArtifacts.js';
import { consolidateMemories } from '../memory/consolidation.js';
import { createHookifyRule, deleteHookifyRule, listHookifyRules, toggleHookifyRule } from '../state/hookifyStore.js';
import { safePrintAbovePrompt as safePrintAbovePromptGlobalShared, setActiveReadline } from './cliPrompt.js';
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
  '/help', '/status', '/workspace', '/tools', '/skills', '/plan', '/transcript',
  '/doctor', '/config', '/diff', '/commit', '/clear', '/compact', '/exit', '/quit',
  '/roles', '/agents', '/agent', '/spawn', '/wait',
  '/spec', '/feature-dev', '/review', '/implement-plan', '/skill', '/workflows', '/approve',
  '/memory', '/recall', '/briefing', '/scenes', '/working', '/forget',
  '/init', '/sessions', '/resume', '/model', '/mcp',
  '/goal', '/copy', '/fork', '/rename', '/permissions', '/hooks', '/hookify', '/loop',
  '/continue', '/auto-review', '/vim', '/statusline',
  '/handover', '/explain', '/trace', '/failed', '/verify', '/audit',
  '/export', '/import', '/persona', '/skill-hints', '/diagnostics',
  '/tokens', '/watch', '/yolo', '/sandbox', '/kill',
  // workflow & ergonomics commands
  '/theme', '/title', '/personality', '/new', '/side', '/btw', '/raw',
  '/feedback', '/rollout', '/ps', '/stop', '/logout', '/apps', '/plugins',
  '/experimental', '/memories', '/debug-config', '/mention', '/keymap', '/ide',
] as const;

export function startREPL(agent: Agent, mcpClient: McpClientWrapper, config: Config, workspace?: WorkspaceInfo) {
  console.log(chalk.bold.hex('#CC9166')('\n🧠 BRAINROUTER TERMINAL AGENT CLIENT v0.3.3'));
  console.log(chalk.gray('Midnight Ledger / Obsidian Surface theme active.'));
  console.log(chalk.gray(`Workspace root: ${workspace?.workspaceRoot || process.cwd()}`));
  console.log(chalk.gray('Type ') + chalk.cyan('/help') + chalk.gray(' for commands, or start typing your prompt.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.hex('#CC9166')('brainrouter> '),
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
  const renderStatusline = (): string => {
    const prefs = readPreferences(agent.workspaceRoot);
    const segments = prefs.statusline.split(',').map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const seg of segments) {
      if (seg === 'mode') out.push(agent.getAccessMode());
      else if (seg === 'model') out.push(agent.getModel());
      else if (seg === 'tokens') {
        const u = agent.lastTurnUsage;
        if (u.calls > 0) out.push(`${u.promptTokens}↑${u.completionTokens}↓`);
      } else if (seg === 'session') {
        const k = agent.sessionKey;
        out.push(k.length > 22 ? `${k.slice(0, 22)}…` : k);
      } else if (seg === 'branch' || seg === 'dirty') {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: agent.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          const dirty = execSync('git status --porcelain', { cwd: agent.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
          if (seg === 'branch') out.push(branch);
          else if (seg === 'dirty' && dirty) out.push('*');
        } catch { /* not a git repo */ }
      } else if (seg === 'pr') {
        // Detect open GitHub PR for the current branch (Claude Code 2.1.147
        // parity). 30s cache so the prompt refresh is cheap.
        const pr = detectGitHubPR(agent.workspaceRoot);
        if (pr) out.push(pr);
      }
    }
    return out.filter(Boolean).join(' · ');
  };
  const refreshPromptForMode = () => {
    const mode = agent.getAccessMode();
    const accent = mode === 'shell' ? chalk.red : mode === 'write' ? chalk.hex('#CC9166') : chalk.green;
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
  // continuation OR a running child. Matches Claude Code 2.1.147's tab
  // title hint for `claude agents`.
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

  // Shift+Tab cycles the access mode (codex calls this "Plan mode").
  // Order: read → write → shell → read …
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(false); } catch { /* noop */ }
  }
  process.stdin.on('keypress', (_str, key) => {
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

  // Publish the rl interface globally so out-of-scope helpers
  // (runOrchestrationPrompt, askYesNo in agent.ts) can talk to the same
  // stdin/stdout pair the REPL owns. Cleared on close.
  activeReadline = rl;
  setActiveReadline(rl);
  rl.on('close', () => { activeReadline = undefined; setActiveReadline(undefined); });

  rl.prompt();

  let isProcessing = false;
  // (pendingContinuation declared earlier alongside the title refresh helpers.)

  /**
   * Build the prompt that fires automatically between goal-driven turns. Codex
   * pattern: orient the model around the active objective, force an evidence
   * audit, refuse prose-only "I will continue" answers.
   */
  const buildGoalContinuationPrompt = (
    goal: import('../state/goalStore.js').Goal,
    lastPrompt: string,
    lastAnswer: string,
  ): string => {
    const iter = goal.budget.iterationsUsed + 1;
    const remaining = Math.max(0, goal.budget.maxIterations - iter);
    return [
      `[GOAL CONTINUATION — iteration ${iter}/${goal.budget.maxIterations}, ${remaining} remaining]`,
      '',
      `Your active goal is: ${goal.text}`,
      '',
      `Last user message: ${lastPrompt || '(none)'}`,
      `Your previous response (truncated): ${lastAnswer.slice(0, 600)}${lastAnswer.length > 600 ? '…' : ''}`,
      '',
      '## What to do this turn',
      '1. **Audit the evidence in this thread** against the goal\'s outcome. Look at files you wrote, tests you ran, tools that returned ok=true.',
      '2. **Decide one of three:**',
      '   - If the outcome is met with concrete evidence (file paths, test names, command outputs), call `goal_complete` with a 1–2 sentence proof.',
      '   - If no defensible path forward remains without user input or missing materials, call `goal_blocked` with a reason + needed input.',
      '   - Otherwise, take the **next concrete tool action** (read a file, write code, spawn a worker child, run a verifier). Do NOT respond with prose like "I will now do X" — that\'s a no-op and the CLI will stop the continuation.',
      '3. Use update_plan to track progress if you haven\'t already.',
      '',
      'Reminder: budget is finite. Pick the highest-leverage action that moves the goal forward.',
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

  /** Run a turn programmatically (used by `/continue` and the line handler). */
  const runAgentTurn = async (rawInput: string): Promise<void> => {
    if (isProcessing) {
      console.log(chalk.yellow('\nA previous turn is still running.\n'));
      return;
    }
    isProcessing = true;
    rl.pause();
    const { expanded, mentions } = expandMentions(rawInput, agent.workspaceRoot);
    if (mentions.length > 0) {
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
          // Render spawn_agent / spawn_agents specially — Claude-Code style
          // one-liner ("Ran agent <role> — <one-line task>") so a fan-out of
          // 5 children produces 5 clean lines instead of 5 JSON dumps. The
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
          const line = result.success
            ? chalk.green('✓  Tool ') + chalk.cyan(name) + chalk.green(' completed: ') + chalk.gray(result.summary)
            : chalk.red('❌  Tool ') + chalk.cyan(name) + chalk.red(' failed: ') + chalk.yellow(result.summary);
          if (parentDone) { safePrintAbovePrompt(line); return; }
          console.log(line);
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
      // Auto-continuation: if a /goal is active, the turn made tool calls,
      // and we still have budget, schedule another turn. Codex parity rules:
      //   - prose-only turn (zero tool calls) suppresses next continuation
      //   - user typing anything cancels pendingContinuation
      //   - goal_complete / goal_blocked tools called during the turn stop the loop
      const goalAfter = readGoal(agent.workspaceRoot, agent.sessionKey);
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
      } else if (goalAfter && goalAfter.status === 'active' && !goalHasBudgetLeft(goalAfter)) {
        console.log(chalk.yellow(`\n⏸  Goal iteration budget exhausted (${goalAfter.budget.iterationsUsed}/${goalAfter.budget.maxIterations}). Extend with /goal budget <n>, mark /goal complete, or /goal clear.\n`));
      } else if (goalAfter && goalAfter.status === 'active' && agent.lastTurnToolCalls === 0) {
        console.log(chalk.gray(`(goal continuation suppressed: last turn made no tool calls — anti-spin)\n`));
      }
      rl.resume();
      refreshPromptForMode(); // pick up token-meter / branch updates
      rl.prompt();
      if (shouldContinue && goalAfter) {
        pendingContinuation = true;
        const next = goalAfter.budget.iterationsUsed + 1;
        console.log(chalk.gray(`(goal continuation queued — iteration ${next}/${goalAfter.budget.maxIterations}; type anything to cancel)`));
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

    if (input.startsWith('/')) {
      // Split on any whitespace, not a literal space. Without this, a slash
      // command followed by a tab (autocomplete completion that wasn't
      // consumed) or a trailing newline ends up as command="/help\t" which
      // fell through to "Unknown slash command". Matches Claude Code 2.1.147.
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
 * Help categories. Data-driven so /help can render the index on small
 * terminals and a focused page on `/help <category>`. Matches Claude Code
 * 2.1.147's paginated help — the prior implementation was 95 lines of
 * console.log calls that blew past the scrollback on anything under ~50 rows.
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
      { cmd: '/plan', desc: 'Show the durable CLI task plan' },
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

async function runSkillCommand(
  agent: Agent,
  mcpClient: McpClientWrapper,
  slashCommand: string,
  userInput: string,
  orchestration: string | undefined,
  runTurn: (prompt: string) => void,
): Promise<void> {
  const skillName = SLASH_TO_SKILL[slashCommand];
  if (!skillName) {
    console.log(chalk.red(`\nNo skill mapped to ${slashCommand}.\n`));
    return;
  }
  await runSkillByName(agent, mcpClient, skillName, userInput, orchestration, runTurn);
}

async function runSkillByName(
  agent: Agent,
  mcpClient: McpClientWrapper,
  skillName: string,
  userInput: string,
  orchestration: string | undefined,
  runTurn: (prompt: string) => void,
): Promise<void> {
  const loader = ora(chalk.gray(`Loading skill: ${skillName}...`)).start();
  let prompt: string;
  try {
    const skill = await resolveSkill(mcpClient, skillName, agent.workspaceRoot, 'full');
    if (skill.source === 'fallback') {
      // resolveSkill returns a placeholder body for unknown names; running it
      // burns an LLM call on nothing. Refuse early and tell the user what's
      // actually installed.
      loader.fail(chalk.red(`Unknown skill "${skillName}".`));
      console.log(chalk.gray('  Run `/skills` to list installed skills, or call `search_skills` for fuzzy matches.\n'));
      return;
    }
    loader.succeed(chalk.green(`Skill loaded: ${skillName} (${skill.source})`));
    prompt = buildSkillPrompt(skill, { input: userInput, orchestration });
  } catch (err: any) {
    loader.fail(chalk.red(`Failed to resolve skill "${skillName}": ${err.message}`));
    return;
  }
  // Mark the skill active so memory_recall / memory_capture_turn see it.
  // The activeSkill stays latched while the turn runs; runAgentTurn's
  // continuation loop will clear it via the post-turn hook below.
  agent.activeSkill = skillName;
  runTurn(prompt);
}

/**
 * Module-level "active readline" pointer so functions that don't carry an rl
 * argument (runOrchestrationPrompt, runSkillByName, …) can still redraw the
 * prompt cleanly after the parent's runTurn finishes and stray child events
 * arrive. Set by startREPL — there's only ever one REPL per process.
 */
let activeReadline: readline.Interface | undefined;

/**
 * Prompt the agent receives for the FIRST turn after /goal <text> or
 * /goal resume. Once this turn finishes, runAgentTurn's continuation loop
 * keeps firing iterations 2..N until the agent calls goal_complete or
 * goal_blocked, the budget runs out, or the user interrupts.
 */
function buildGoalKickoffPrompt(goal: import('../state/goalStore.js').Goal, mode: 'start' | 'resume'): string {
  const header = mode === 'start' ? '[GOAL KICKOFF — iteration 1]' : '[GOAL RESUME]';
  return [
    header,
    '',
    `Your active goal is: ${goal.text}`,
    `Iteration budget: ${goal.budget.iterationsUsed}/${goal.budget.maxIterations} used.`,
    '',
    '## What to do right now',
    mode === 'start'
      ? '1. **Open with memory.** Run `memory_search` / `memory_recall` for prior work in this workspace. Cite the recordIds you find.'
      : '1. **Reload context.** Check what was already done by reading the last few transcript entries, the current plan, and any open child agents (`list_agents`).',
    '2. **Plan briefly.** If the work has 3+ vertical slices, call `update_plan` with statuses (pending / in_progress / completed; ≤ 1 in_progress).',
    '3. **Take the first concrete tool action** toward the outcome. Read a file, write code, spawn an explorer child, run a verifier — whatever produces evidence the goal is satisfied.',
    '4. The CLI will auto-continue you with another turn after this one finishes. Iterate until you can call `goal_complete(proof)` with concrete evidence (test pass / file written / benchmark hit) or `goal_blocked(reason)` if no path remains.',
    '',
    'Do NOT respond with prose-only "I will get started" — the CLI suppresses the next auto-continuation after a turn with zero tool calls. Begin executing tools now.',
  ].join('\n');
}

function safePrintAbovePromptGlobal(msg: string): void {
  if (!process.stdout.isTTY || !activeReadline) {
    console.log(msg);
    return;
  }
  process.stdout.write('\r\x1b[2K');
  console.log(msg);
  try { (activeReadline as any)._refreshLine?.(); } catch { activeReadline.prompt(true); }
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

/**
 * Memory-aware variant of printMcpCall. Calls the tool, extracts the flat
 * record list from whatever shape it returns, and renders compact cards
 * (recordId, type, scene, content preview). Falls back to printMcpCall's
 * raw output only when no records can be parsed.
 */
async function printMemoryCards(
  mcpClient: McpClientWrapper,
  toolName: string,
  args: Record<string, unknown>,
  heading: string,
): Promise<void> {
  const spinner = ora(chalk.gray(`${toolName}…`)).start();
  const res = await callMcpTool<any>(mcpClient, toolName, args);
  spinner.stop();
  console.log();
  if (res.isError) {
    console.log(chalk.red(`${heading}: tool error — ${res.text || '(no message)'}`));
    return;
  }
  const cards = extractMemories(res.parsed);
  if (cards.length > 0) {
    console.log(renderMemoryCards(cards, heading));
  } else {
    console.log(chalk.bold(heading));
    const preview = clampPayload(res.text, 2000).trim();
    console.log(preview ? chalk.gray(preview) : chalk.yellow('  (empty result)'));
    console.log();
  }
}

async function printMcpCall(
  mcpClient: McpClientWrapper,
  toolName: string,
  args: Record<string, unknown>,
  heading: string,
): Promise<void> {
  const spinner = ora(chalk.gray(`${toolName}…`)).start();
  const res = await callMcpTool(mcpClient, toolName, args);
  spinner.stop();
  console.log(chalk.bold(`\n${heading}`));
  if (res.isError) {
    console.log(chalk.red(`  Tool error: ${res.text || '(no message)'}`));
    console.log();
    return;
  }
  if (!res.text.trim()) {
    console.log(chalk.yellow('  (empty result)'));
    console.log();
    return;
  }
  const preview = res.text.length > 4000
    ? res.text.slice(0, 4000) + chalk.gray(`\n…(${res.text.length - 4000} chars truncated)`)
    : res.text;
  console.log(chalk.gray(preview));
  console.log();
}

function formatTranscriptContent(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}
