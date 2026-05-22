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

function renderHelp(category?: string): void {
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
  switch (command) {
    case '/help':
      renderHelp(args[0]?.toLowerCase());
      break;

    case '/status': {
      console.log(chalk.bold('\n🖥️  BrainRouter Status:'));
      const activeServerName = config.activeServer;
      const server = config.servers[activeServerName];
      console.log(`  Active Server: ${chalk.green(activeServerName)} (Type: ${chalk.cyan(server.type)})`);
      if (server.type === 'http') {
        console.log(`  Endpoint URL:  ${chalk.blue(server.url)}`);
      } else {
        console.log(`  Command:       ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      }

      const llm = config.llm;
      if (llm) {
        console.log(`  LLM Provider:  ${chalk.green(llm.provider)}`);
        console.log(`  LLM Model:     ${chalk.cyan(llm.model)}`);
        if (llm.endpoint) {
          console.log(`  LLM Endpoint:  ${chalk.blue(llm.endpoint)}`);
        }
      }

      const spinner = ora(chalk.gray('Querying diagnostics & testing latency...')).start();
      try {
        const start = Date.now();
        const testRes = await mcpClient.callTool('list_skills', { scope: 'local' });
        const latency = Date.now() - start;
        spinner.succeed(chalk.green(`Latency check: ${latency}ms`));

        // Diagnostics / memory stats
        const diag = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        if (!diag.isError && diag.parsed) {
          const stats = diag.parsed.databaseStats?.userStats;
          if (stats) {
            console.log(chalk.bold('\n📊 Cognitive Memory Database Stats:'));
            console.log(`  Total Memories:       ${chalk.yellow(stats.totalCount ?? 0)}`);
            console.log(`    - Instructions:     ${chalk.gray(stats.typeCounts?.instruction ?? 0)}`);
            console.log(`    - Codebase Facts:   ${chalk.gray(stats.typeCounts?.codebase_fact ?? 0)}`);
            console.log(`    - Architectures:    ${chalk.gray(stats.typeCounts?.architecture_decision ?? 0)}`);
            console.log(`  Total Focus Scenes:   ${chalk.yellow(stats.totalScenes ?? 0)}`);
            console.log(`  Working Memory Items: ${chalk.yellow(stats.workingMemoryCount ?? 0)}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to fetch diagnostics.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/workspace': {
      console.log(chalk.bold('\nWorkspace:'));
      console.log(`  Root:       ${chalk.blue(agent.workspaceRoot)}`);
      console.log(`  Launch CWD: ${chalk.gray(agent.launchCwd)}`);
      console.log(`  Session:    ${chalk.green(agent.sessionKey)}`);
      console.log();
      break;
    }

    case '/skills': {
      const spinner = ora(chalk.gray('Fetching skills...')).start();
      try {
        const res = await callMcpTool<any[]>(mcpClient, 'list_skills', { scope: 'all' });
        spinner.stop();
        if (!res.isError && Array.isArray(res.parsed)) {
          const skillsList = res.parsed;
          console.log(chalk.bold('\n🧠 BrainRouter Skills:'));
          if (skillsList.length > 0) {
            for (const skill of skillsList) {
              console.log(`  • ${chalk.cyan(skill.name)} (${chalk.gray(skill.scope)}) - ${skill.description}`);
            }
          } else {
            console.log(chalk.yellow('  No skills found.'));
          }
        } else {
          console.log(chalk.red('\nFailed to parse skills list response.'));
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list skills.'));
        console.error(chalk.red(`  Error: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/config': {
      console.log(chalk.bold('\n⚙️  Active Configuration:'));
      console.log(`  File Path: ${chalk.blue(getConfigPath())}\n`);
      
      // Print config without API keys
      const scrubbedConfig = JSON.parse(JSON.stringify(config));
      if (scrubbedConfig.llm?.apiKey) {
        scrubbedConfig.llm.apiKey = 'br_••••••••••••••••';
      }
      for (const s of Object.values(scrubbedConfig.servers)) {
        const srv = s as any;
        if (srv.apiKey) srv.apiKey = 'br_••••••••••••••••';
        if (srv.env?.BRAINROUTER_API_KEY) {
          srv.env.BRAINROUTER_API_KEY = 'br_••••••••••••••••';
        }
      }
      console.log(chalk.gray(JSON.stringify(scrubbedConfig, null, 2)));
      console.log();
      break;
    }

    case '/tools': {
      console.log(chalk.bold('\nLocal Workspace Tools:'));
      for (const tool of LOCAL_TOOLS) {
        console.log(`  ${chalk.cyan(tool.name)} - ${tool.description}`);
      }

      const spinner = ora(chalk.gray('Fetching MCP tools...')).start();
      try {
        const res = await mcpClient.listTools();
        spinner.stop();
        const tools = res.tools || [];
        console.log(chalk.bold('\nMCP Tools:'));
        if (tools.length === 0) {
          console.log(chalk.yellow('  No MCP tools exposed by the active server.'));
        } else {
          for (const tool of tools) {
            console.log(`  ${chalk.cyan(tool.name)} - ${tool.description || 'No description'}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list MCP tools.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/plan': {
      const state = readPlan(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.bold('\nPlan:'));
      console.log(chalk.gray(formatPlan(state)));
      if (state.updatedAt) {
        console.log(chalk.gray(`Updated: ${state.updatedAt}`));
      }
      console.log();
      break;
    }

    case '/transcript': {
      const requestedSession = args.join(' ').trim();
      const sessionKey = !requestedSession || requestedSession === 'main'
        ? agent.sessionKey
        : requestedSession;
      const entries = readTranscriptEntries(agent.workspaceRoot, sessionKey, 20);
      console.log(chalk.bold(`\nTranscript: ${sessionKey}`));
      if (entries.length === 0) {
        console.log(chalk.yellow('  No transcript entries found.'));
      } else {
        for (const entry of entries) {
          const label = entry.name ? `${entry.role}:${entry.name}` : entry.role;
          const text = formatTranscriptContent(entry.content ?? entry.tool_calls ?? '');
          console.log(`${chalk.gray(entry.timestamp)} ${chalk.cyan(label)} ${chalk.gray(text)}`);
        }
      }
      console.log();
      break;
    }

    case '/doctor': {
      console.log(chalk.bold('\nBrainRouter Doctor:'));
      console.log(`  Config file: ${chalk.blue(getConfigPath())}`);
      console.log(`  Active profile: ${chalk.green(config.activeServer)}`);

      const server = config.servers[config.activeServer];
      if (!server) {
        console.log(chalk.red('  Server profile: missing'));
        break;
      }

      console.log(`  Server profile: ${chalk.green(server.type)}`);
      if (server.type === 'stdio') {
        console.log(`  Launch command: ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      } else {
        console.log(`  Endpoint: ${chalk.blue(server.url)}`);
      }

      const spinner = ora(chalk.gray('Checking MCP tool surface...')).start();
      try {
        const startedAt = Date.now();
        const res = await mcpClient.listTools();
        const latency = Date.now() - startedAt;
        spinner.succeed(chalk.green(`MCP connection healthy (${latency}ms)`));
        console.log(`  MCP tools: ${chalk.yellow(res.tools?.length ?? 0)}`);
        const toolNames = new Set((res.tools || []).map((tool: any) => tool.name));
        const memoryTools = ['memory_recall', 'memory_capture_turn', 'memory_working_offload'];
        for (const name of memoryTools) {
          const hasTool = toolNames.has(name);
          console.log(`  ${name}: ${hasTool ? chalk.green('available') : chalk.yellow('not exposed')}`);
        }
      } catch (err: any) {
        spinner.fail(chalk.red('MCP connection check failed.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }

      // Memory health: are captures actually being extracted into searchable
      // cognitive records, or are they piling up in sensory_stream? This is
      // the silent failure mode that makes briefings return "0 records" — the
      // CLI shows 💾 Captured after every turn but the LLM the extractor
      // needs may not be configured in the MCP child env.
      try {
        const diagRes = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        const ext = diagRes.parsed?.databaseStats?.userStats?.extraction;
        if (ext) {
          const errs = ext.extractionErrors ?? 0;
          const pending = ext.unextractedCount ?? 0;
          const total = diagRes.parsed?.databaseStats?.userStats?.total ?? 0;
          const headline = errs > 0
            ? chalk.red(`  Memory extraction: DEGRADED — ${errs} consecutive failures`)
            : pending > 5
              ? chalk.yellow(`  Memory extraction: backlog of ${pending} sensory rows pending`)
              : chalk.green(`  Memory extraction: healthy (${total} cognitive records, ${pending} pending)`);
          console.log(headline);
          if (ext.lastErrorMessage) {
            console.log(chalk.gray(`    Last error: ${String(ext.lastErrorMessage).slice(0, 160)}`));
          }
          if (errs > 0 || !diagRes.parsed?.envKeys?.some?.((k: string) => /BRAINROUTER_LLM_API_KEY|OPENAI_API_KEY/.test(k))) {
            console.log(chalk.gray('    Hint: set OPENAI_API_KEY (or BRAINROUTER_LLM_API_KEY) before launching brainrouter so the MCP child can run extraction.'));
          }
        }
      } catch (err: any) {
        console.log(chalk.yellow(`  Memory extraction: unable to query (${err?.message ?? err})`));
      }

      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
      console.log(`  Plan items: ${chalk.yellow(plan.items.length)} (updated: ${chalk.gray(plan.updatedAt || 'never')})`);
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(`  Reconciled ${chalk.yellow(reconciled)} stale child session(s).`);
      const childSessions = listSessions(agent.workspaceRoot);
      console.log(`  Child sessions: ${chalk.yellow(childSessions.length)} total`);
      const orchestrationTools = ['spawn_agent', 'list_agents', 'wait_agent', 'read_agent_transcript', 'close_agent', 'update_plan'];
      for (const tn of orchestrationTools) {
        const has = LOCAL_TOOLS.some((lt: any) => lt.name === tn);
        console.log(`  ${tn}: ${has ? chalk.green('available') : chalk.red('missing')}`);
      }
      console.log();
      break;
    }

    case '/diff': {
      // Stream the diff instead of buffering. The old execPromise approach
      // read the whole diff into memory, then colored every line in a JS
      // loop before any output appeared — for a 5k-line diff that took
      // seconds and you saw nothing until completion. Now: spawn `git diff
      // --color=always` and pipe stdout directly. Claude Code 2.1.147
      // improved diff rendering performance the same way.
      const stagedFlag = args.includes('--staged') || args.includes('--cached');
      const allFlag = args.includes('--all') || args.includes('HEAD');
      const gitArgs = ['diff', '--color=always'];
      if (allFlag) gitArgs.push('HEAD');
      else if (stagedFlag) gitArgs.push('--cached');
      console.log(chalk.bold(
        `\n--- Git Diff (${allFlag ? 'staged + unstaged' : stagedFlag ? 'staged' : 'unstaged'}) ---`,
      ));
      await new Promise<void>((resolve) => {
        const child = spawn('git', gitArgs, {
          cwd: agent.workspaceRoot,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('exit', (code) => {
          if (code !== 0 && code !== null && code !== 1) {
            // git diff returns 1 when there are differences with --exit-code;
            // without that flag it's just success. Anything else is an error.
            console.log(chalk.yellow(`(git diff exited ${code})`));
          }
          resolve();
        });
        child.on('error', (err) => {
          console.log(chalk.red(`Failed to spawn git: ${err.message}`));
          resolve();
        });
      });
      // If the diff was empty, git printed nothing — give the user a hint.
      // (We can't detect empty without buffering; just always print the tip.)
      console.log(chalk.gray('  Tip: /diff --staged for staged changes only, /diff --all (or HEAD) for both.\n'));
      break;
    }

    case '/commit': {
      // Pre-check git status so we can skip an LLM round-trip when there's
      // nothing to commit. The actual commit work goes through ctx.runAgentTurn
      // so it inherits the normal pipeline: isProcessing locking, goal
      // continuation, /raw honoring, contradiction surfacing, token summary.
      const spinner = ora(chalk.gray('Checking git status...')).start();
      let statusOut = '';
      let diffOut = '';
      try {
        ({ stdout: statusOut } = await execPromise('git status --short'));
        if (!statusOut.trim()) {
          spinner.succeed(chalk.green('Working directory clean. Nothing to commit.'));
          break;
        }
        spinner.text = chalk.gray('Reading diff...');
        ({ stdout: diffOut } = await execPromise('git diff HEAD'));
        spinner.stop();
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed to read git status: ${err.message}`));
        break;
      }
      console.log(chalk.bold('\nGit changes detected:'));
      console.log(chalk.gray(statusOut));
      const prompt =
        `Based on the following git status and git diff, please create a commit. ` +
        `Stage the modified/untracked files (using git add) and run git commit with an appropriate conventional commit message.\n\n` +
        `Git status:\n${statusOut}\n\nDiff:\n${diffOut}`;
      ctx.runAgentTurn(prompt);
      return;
    }

    case '/roles': {
      console.log(chalk.bold('\nAvailable Agent Roles:'));
      for (const r of listRoles()) {
        console.log(`  ${chalk.cyan(r.name)} (${chalk.gray(r.defaultAccess)}) - ${r.description}`);
      }
      console.log();
      break;
    }

    case '/agents': {
      reconcileStale(agent.workspaceRoot);
      const sessions = listSessions(agent.workspaceRoot);
      // `--json` for scripting (Claude Code 2.1.147 parity). Emits a single
      // JSON line on stdout so tmux-resurrect, status bars, agent pickers,
      // and pipelines can parse the live session list reliably.
      if (args.includes('--json')) {
        const payload = sessions.map((s) => ({
          id: s.id,
          role: s.role,
          status: s.status,
          label: s.label,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          completedAt: s.completedAt,
          prompt: s.prompt,
          usage: s.usage,
          parentSessionKey: s.parentSessionKey,
          finalOutputPreview: s.finalOutput ? String(s.finalOutput).slice(0, 280) : undefined,
        }));
        // process.stdout.write with no chalk so jq / scripts get clean JSON.
        process.stdout.write(JSON.stringify({ sessions: payload }) + '\n');
        break;
      }
      console.log(chalk.bold('\nChild Agent Sessions:'));
      if (sessions.length === 0) {
        console.log(chalk.yellow('  No child agents yet. Use /spawn <role> <prompt> to start one.'));
      } else {
        for (const s of sessions) {
          const colorFn =
            s.status === 'completed' ? chalk.green :
            s.status === 'failed' ? chalk.red :
            s.status === 'stale' ? chalk.yellow :
            s.status === 'closed' ? chalk.gray : chalk.cyan;
          console.log(`  ${colorFn(formatSessionSummary(s))}`);
          if (s.usage) {
            console.log(chalk.gray(`      tokens: ${s.usage.promptTokens.toLocaleString()}↑ ${s.usage.completionTokens.toLocaleString()}↓ across ${s.usage.calls} call${s.usage.calls === 1 ? '' : 's'} (${s.usage.turns} turn${s.usage.turns === 1 ? '' : 's'})`));
          }
          if (s.prompt) {
            console.log(chalk.gray(`      prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 100)}${s.prompt.length > 100 ? '…' : ''}`));
          }
        }
        console.log(chalk.gray('\n  (pipe-friendly output: /agents --json)'));
      }
      console.log();
      break;
    }

    case '/agent': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /agent <id> [--full]\n')); break; }
      const full = args.includes('--full');
      const s = getSession(agent.workspaceRoot, id);
      if (!s) { console.log(chalk.red(`\nNo session ${id}\n`)); break; }
      console.log(chalk.bold(`\nAgent ${s.id}`));
      console.log(`  Role:    ${chalk.cyan(s.role)} (${s.access})`);
      console.log(`  Status:  ${chalk.yellow(s.status)}`);
      console.log(`  Started: ${chalk.gray(s.startedAt)}`);
      if (s.completedAt) console.log(`  Ended:   ${chalk.gray(s.completedAt)}`);
      if (s.label) console.log(`  Label:   ${s.label}`);
      console.log(`  Prompt:  ${chalk.gray(s.prompt.slice(0, 240))}`);
      if (s.usage) {
        console.log(`  Tokens:  ${chalk.cyan(s.usage.promptTokens.toLocaleString())}↑  ${chalk.cyan(s.usage.completionTokens.toLocaleString())}↓  ${chalk.gray(`(${s.usage.calls} LLM call${s.usage.calls === 1 ? '' : 's'}, ${s.usage.turns} turn${s.usage.turns === 1 ? '' : 's'})`)}`);
      }
      if (s.finalOutput) console.log(`\n${chalk.bold('Final output:')}\n${s.finalOutput}`);
      if (s.error) console.log(`\n${chalk.red('Error:')} ${s.error}`);
      const entries = readTranscriptEntries(agent.workspaceRoot, childSessionKey(s.parentSessionKey, s.id), full ? 1000 : 10);
      if (entries.length > 0) {
        console.log(chalk.bold(`\n${full ? 'Full' : 'Recent'} transcript (${entries.length} entries):`));
        for (const e of entries) {
          const text = formatTranscriptContent(e.content ?? e.tool_calls ?? '');
          const roleColor = e.role === 'user' ? chalk.yellow : e.role === 'assistant' ? chalk.green : e.role === 'tool' ? chalk.magenta : chalk.cyan;
          console.log(`  ${chalk.gray(e.timestamp)} ${roleColor(e.role)} ${chalk.gray(text)}`);
        }
        if (!full && entries.length === 10) {
          console.log(chalk.gray(`\n  (use /agent ${id} --full to see all entries)`));
        }
      }
      console.log();
      break;
    }

    case '/spawn': {
      const role = args[0];
      const prompt = args.slice(1).join(' ').trim();
      if (!role || !prompt) {
        console.log(chalk.red('\nUsage: /spawn <role> <prompt>\n'));
        break;
      }
      // Validate the role upfront — saves an LLM round-trip that would just
      // error out server-side anyway.
      const validRoles = listRoles().map((r) => r.name);
      if (!validRoles.includes(role)) {
        console.log(chalk.red(`\nUnknown role "${role}". Available: ${validRoles.join(', ')}.\n`));
        break;
      }
      ctx.runAgentTurn(
        `Use the spawn_agent tool to start a ${role} child agent with this prompt:\n\n${prompt}\n\nReturn the child agent id when done.`,
      );
      return;
    }

    case '/wait': {
      const id = args[0];
      const ms = args[1] ? Number(args[1]) : 120000;
      if (!id) { console.log(chalk.red('\nUsage: /wait <id> [timeoutMs]\n')); break; }
      ctx.runAgentTurn(
        `Use the wait_agent tool with id="${id}" and timeoutMs=${ms}. Then summarize the child output for me.`,
      );
      return;
    }

    case '/feature-dev': {
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /feature-dev <feature description>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'feature-dev' });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      const tasksPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.tasks);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      try {
        updatePlan(agent.workspaceRoot, {
          explanation: `Feature: ${feature}`,
          plan: [
            { step: 'Discovery: clarify scope and constraints', status: 'in_progress' },
            { step: 'Exploration: map relevant code with explorer agents', status: 'pending' },
            { step: 'Architecture: choose design via architect agent', status: 'pending' },
            { step: `Write spec.md to ${specPath}`, status: 'pending' },
            { step: `Write tasks.md to ${tasksPath}`, status: 'pending' },
            { step: 'Implementation: worker agent edits code', status: 'pending' },
            { step: 'Review: reviewer agent inspects diff', status: 'pending' },
            { step: 'Verify: verifier agent runs tests', status: 'pending' },
          ],
        }, agent.sessionKey);
      } catch (err: any) {
        console.log(chalk.yellow(`Plan setup warning: ${err.message}`));
      }
      await runSkillCommand(agent, mcpClient, command, feature, [
        '## Required memory-first opening',
        'Run `memory_search` with the feature name AND `memory_graph_query` to surface prior knowledge in this workspace. Pass any recovered record IDs to children via `spawn_agent`\'s `seedRecordIds`.',
        '',
        '## Workflow (mandatory, no shortcuts)',
        `Workflow slug: \`${meta.slug}\`. Folder: \`${path.dirname(specPath)}\`.`,
        '',
        'Phase 1 — Exploration: call `spawn_agent` AT LEAST TWICE in parallel with role=explorer. Different children must cover different parts of the codebase relevant to this feature. Do not narrate exploration yourself; use the tool.',
        '',
        'Phase 2 — Architecture: after explorers complete (use `wait_agent`), call `spawn_agent` with role=architect to produce ≥2 design alternatives and a recommended slice.',
        '',
        `Phase 3 — Persist artifacts: call \`write_file\` to create \`${specPath}\` (the spec) AND \`${tasksPath}\` (the task breakdown). Use the spec-driven-skill structure for \`spec.md\` and the planning-skill structure for \`tasks.md\`. These files are the canonical record — do NOT produce a chat-only plan.`,
        '',
        'Phase 4 — STOP: present a short summary in chat referencing the file paths, then explicitly ask the user to confirm before any `worker` implementation begins.',
      ].join('\n'), ctx.runAgentTurn);
      return;
    }

    case '/spec': {
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /spec <feature title>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'spec' });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      await runSkillCommand(agent, mcpClient, '/spec', feature, [
        '## Goal',
        `Produce a complete specification for: "${feature}".`,
        '',
        '## Mandatory steps',
        '1. Open with `memory_search` for related prior work; cite any recovered record IDs in the spec.',
        '2. Optionally spawn 1–2 `explorer` children to confirm scope before drafting (only if the feature touches unfamiliar code).',
        `3. Call \`write_file\` with path \`${specPath}\` containing the full spec, structured per the spec-driven-skill template (Objective, Commands, Project Structure, Code Style, Testing Strategy, Boundaries).`,
        '4. In chat, summarize the spec in ≤ 10 lines and reference the file path. Ask the user to approve before generating tasks or implementation.',
        '',
        '## Anti-patterns',
        '- Do NOT produce a multi-section spec inline in chat without writing the file.',
        '- Do NOT proceed to task breakdown or implementation until the user explicitly approves.',
      ].join('\n'), ctx.runAgentTurn);
      return;
    }

    case '/review': {
      const scope = args.join(' ').trim() || 'current unstaged and staged changes (git diff HEAD)';
      const meta = createWorkflow(agent.workspaceRoot, { title: `Review: ${scope}`, kind: 'review' });
      const reportPath = artifactRelativePath(agent.workspaceRoot, meta.slug, 'review.md');
      console.log(chalk.gray(`Workflow folder: ${path.dirname(reportPath)}`));
      await runSkillCommand(agent, mcpClient, command, scope, [
        '## Required memory-first opening',
        'Run `memory_search` for similar past reviews and `memory_file_history` for any files touched by this diff. Pass relevant record IDs through `seedRecordIds`.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${meta.slug}\`. Output file: \`${reportPath}\`.`,
        '',
        'Step 1: call `spawn_agent` THREE times in parallel with role=reviewer and access=read. Focuses:',
        '(a) correctness / bugs / security;',
        '(b) maintainability / readability / design;',
        '(c) conventions / tests / documentation.',
        'Step 2: `wait_agent` on all three.',
        `Step 3: \`write_file\` to \`${reportPath}\` containing a severity-ordered synthesis (blocker / major / minor / nit) with file:line citations.`,
        'Step 4: summarize ≤ 15 lines in chat referencing the file. Do NOT edit reviewed files.',
      ].join('\n'), ctx.runAgentTurn);
      return;
    }

    case '/implement-plan': {
      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
      const next = plan.items.find(i => i.status === 'pending' || i.status === 'in_progress');
      if (!next) { console.log(chalk.yellow('\nNo pending plan items.\n')); break; }
      // Attach this execution turn to the current workflow if there is one, so
      // walkthrough.md accumulates per workflow rather than per CLI session.
      const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
      const slug = currentSlug ?? createWorkflow(agent.workspaceRoot, { title: next.step, kind: 'implement-plan' }).slug;
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(walkPath)}`));
      await runSkillCommand(agent, mcpClient, command, `Next plan item: "${next.step}"`, [
        '## Required memory-first opening',
        'Run `memory_search` and `memory_task_state` scoped to this plan item. Seed the `worker` child with the record IDs.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${slug}\`. Walkthrough file: \`${walkPath}\`.`,
        '',
        'Step 1: `update_plan` to mark this item `in_progress`.',
        'Step 2: `spawn_agent` role=worker access=write with concrete acceptance criteria AND `seedRecordIds`.',
        'Step 3: after the worker completes, `spawn_agent` role=verifier access=shell to run tests/typechecks.',
        `Step 4: append a section to \`${walkPath}\` (use \`read_file\` then \`write_file\`) recording: item name, files changed, verification commands run, PASS/FAIL, follow-ups.`,
        'Step 5: only on PASS, `update_plan` to `completed` AND `memory_task_update` with outcome. On FAIL, keep `in_progress`, surface failing output, `memory_task_update` with blocker.',
      ].join('\n'), ctx.runAgentTurn);
      return;
    }

    case '/approve': {
      const slug = args[0] || getCurrentWorkflow(agent.workspaceRoot);
      if (!slug) {
        console.log(chalk.red('\nNo current workflow. Use /spec or /feature-dev first, or /approve <slug>.\n'));
        break;
      }
      const spec = readArtifact(agent.workspaceRoot, slug, ARTIFACT.spec);
      if (!spec) {
        console.log(chalk.red(`\nWorkflow "${slug}" has no spec.md yet. Run /spec or /feature-dev first.\n`));
        break;
      }
      const next = updateWorkflowStatus(agent.workspaceRoot, slug, 'in-progress');
      if (!next) {
        console.log(chalk.red(`\nWorkflow "${slug}" not found.\n`));
        break;
      }
      console.log(chalk.green(`\n✓ Approved workflow "${slug}". Status: in-progress.`));
      console.log(chalk.gray('Kicking off implementation phase…\n'));
      const tasksPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.tasks);
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      ctx.runAgentTurn(
        `The user just approved workflow \`${slug}\`. Begin implementation now.\n\n` +
        `1. If \`${tasksPath}\` does not exist yet, read \`${artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.spec)}\` and \`write_file\` a complete tasks.md (vertical slices, S/M-sized, with acceptance criteria) before doing anything else.\n` +
        `2. Pick the first pending task from tasks.md and call \`update_plan\` to mark it in_progress.\n` +
        `3. \`spawn_agent\` role=worker access=write to implement it. Pass any relevant recalled record IDs via seedRecordIds.\n` +
        `4. After the worker completes, \`spawn_agent\` role=verifier access=shell to run tests/typechecks.\n` +
        `5. Append a section to \`${walkPath}\` (read+write) recording the outcome.\n` +
        `6. STOP after the first task and ask whether to continue. Do not silently work through every task — the user approves slices, not the whole batch.`,
      );
      return;
    }

    case '/workflows': {
      const workflows = listWorkflows(agent.workspaceRoot);
      console.log(chalk.bold('\nDurable Workflows'));
      if (workflows.length === 0) {
        console.log(chalk.yellow('  (none yet — try /spec or /feature-dev)'));
      } else {
        const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
        for (const w of workflows) {
          const marker = w.slug === currentSlug ? chalk.green(' ← current') : '';
          console.log(`  ${chalk.cyan(w.slug)} [${chalk.gray(w.status)}] ${chalk.gray(w.kind)}${marker}`);
          console.log(`    ${w.title}`);
          const hasSpec = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.spec);
          const hasTasks = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.tasks);
          const hasWalk = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.walkthrough);
          console.log(chalk.gray(`    spec.md:${hasSpec ? '✓' : '·'}  tasks.md:${hasTasks ? '✓' : '·'}  walkthrough.md:${hasWalk ? '✓' : '·'}`));
        }
      }
      console.log();
      break;
    }

    case '/skill': {
      const skillName = args[0];
      const userInput = args.slice(1).join(' ').trim();
      if (!skillName) {
        console.log(chalk.red('\nUsage: /skill <skill-name> [input]\n'));
        console.log(chalk.gray('Mapped slash commands:'));
        for (const [slash, name] of Object.entries(SLASH_TO_SKILL)) {
          console.log(`  ${chalk.cyan(slash.padEnd(18))} → ${chalk.green(name)}`);
        }
        console.log();
        break;
      }
      await runSkillByName(agent, mcpClient, skillName, userInput, undefined, ctx.runAgentTurn);
      return;
    }

    case '/memory': {
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /memory <query>\n')); break; }
      await printMemoryCards(mcpClient, 'memory_search', { query, sessionKey: agent.sessionKey }, `Memory search · "${query}"`);
      break;
    }

    case '/recall': {
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /recall <query>\n')); break; }
      await printMemoryCards(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query }, `Cognitive recall · "${query}"`);
      break;
    }

    case '/briefing': {
      const b = agent.getLastBriefing();
      console.log(chalk.bold('\nLast Memory Briefing'));
      if (b.sources.length === 0) {
        console.log(chalk.yellow('  No briefing has been built yet. Start a turn or use /recall.'));
      } else {
        console.log(`  Sources queried: ${chalk.cyan(b.sources.join(', '))}`);
        console.log(`  Recalled record IDs (${b.recordIds.length}): ${chalk.gray(b.recordIds.slice(0, 10).join(', '))}${b.recordIds.length > 10 ? '…' : ''}`);
      }
      console.log();
      break;
    }

    case '/scenes': {
      const res = await callMcpTool<any>(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query: 'list focus scenes' });
      if (res.isError) {
        console.log(chalk.red(`\nmemory_recall failed: ${res.text || '(no message)'}\n`));
      } else {
        const persona = res.parsed?.appendSystemContext ?? '';
        const sceneRe = /Recent focus scenes:\s*\n([\s\S]*?)(\n\n|<\/scene-navigation>)/;
        const m = sceneRe.exec(persona);
        console.log(chalk.bold('\nActive focus scenes'));
        if (m) {
          for (const line of m[1].split('\n')) {
            const trimmed = line.replace(/^\s+/, '').replace(/^-\s*/, '').trim();
            if (trimmed) console.log(`  • ${chalk.cyan(trimmed)}`);
          }
        } else {
          console.log(chalk.yellow('  (no scenes returned — recall may be empty)'));
        }
        const cards = extractMemories(res.parsed);
        if (cards.length > 0) {
          console.log();
          console.log(renderMemoryCards(cards, 'Related memories', 5));
        }
      }
      break;
    }

    case '/forget': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /forget <recordId>\n')); break; }
      await printMcpCall(mcpClient, 'memory_update', { recordId: id, status: 'archived' }, `Archive memory ${id}`);
      break;
    }

    case '/init': {
      const result = initAgentMd(agent.workspaceRoot);
      if (result.status === 'created') {
        console.log(chalk.green(`\n✓ Created ${result.path}`));
        console.log(chalk.gray('Edit it to describe your project, conventions, and boundaries — any AGENT.md-aware coding agent will read it.\n'));
      } else {
        console.log(chalk.yellow(`\nFile already exists: ${result.path}`));
        console.log(chalk.gray('Open it and edit by hand if you want to refresh it.\n'));
      }
      break;
    }

    case '/sessions': {
      const transcripts = listTranscripts(agent.workspaceRoot);
      console.log(chalk.bold('\nPersisted sessions:'));
      if (transcripts.length === 0) {
        console.log(chalk.yellow('  (none — start chatting and your transcript will appear here)'));
      } else {
        for (const t of transcripts.slice(0, 30)) {
          const when = t.modifiedAt.replace('T', ' ').slice(0, 19);
          const isCurrent = t.sessionKey === agent.sessionKey;
          const tag = isCurrent ? chalk.green(' (current)') : '';
          console.log(`  ${chalk.cyan(t.sessionKey)}${tag}`);
          console.log(`    ${chalk.gray(`${t.turnCount} entries · ${when}`)}`);
          if (t.firstUserMessage) console.log(`    ${chalk.gray(`"${t.firstUserMessage}"`)}`);
        }
        console.log(chalk.gray('\nResume one with: /resume <sessionKey>'));
      }
      console.log();
      break;
    }

    case '/resume': {
      const sessionKey = args.join(' ').trim();
      if (!sessionKey) {
        console.log(chalk.red('\nUsage: /resume <sessionKey>\n'));
        console.log(chalk.gray('Tip: copy a sessionKey from /sessions.\n'));
        break;
      }
      const entries = loadTranscript(agent.workspaceRoot, sessionKey);
      if (entries.length === 0) {
        console.log(chalk.red(`\nNo transcript found for "${sessionKey}".\n`));
        break;
      }
      agent.sessionKey = sessionKey;
      const loaded = agent.loadHistory(entries);
      console.log(chalk.green(`\n✓ Resumed session ${chalk.cyan(sessionKey)} with ${loaded} prior messages.`));
      console.log(chalk.gray('Your next message will continue the conversation.\n'));
      break;
    }

    case '/model': {
      const newModel = args[0];
      if (!newModel) {
        console.log(chalk.bold(`\nCurrent model: ${chalk.cyan(agent.getModel())}`));
        console.log(chalk.gray('Switch with: /model <model-name> (e.g. /model gpt-4o-mini, /model gpt-5, /model qwen2.5-coder)\n'));
        break;
      }
      const previous = agent.getModel();
      agent.setModel(newModel);
      console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(newModel)}\n`));
      break;
    }

    case '/mcp': {
      const profileName = config.activeServer;
      const server = config.servers[profileName];
      console.log(chalk.bold('\nMCP server'));
      console.log(`  Profile: ${chalk.green(profileName)} (${chalk.cyan(server?.type ?? 'unknown')})`);
      if (server?.type === 'http') {
        console.log(`  URL:     ${chalk.blue(server.url)}`);
      } else if (server?.type === 'stdio') {
        console.log(`  Cmd:     ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      }
      const spinner = ora(chalk.gray('Fetching MCP tool surface...')).start();
      try {
        const res = await mcpClient.listTools();
        const tools = res.tools || [];
        spinner.succeed(chalk.green(`${tools.length} MCP tools available`));
        const namespaces: Record<string, string[]> = {};
        for (const t of tools) {
          const parts = (t.name || '').split('_');
          const ns = parts.length > 1 ? parts[0] : 'misc';
          (namespaces[ns] ||= []).push(t.name);
        }
        for (const ns of Object.keys(namespaces).sort()) {
          console.log(`\n  ${chalk.bold.cyan(ns)} (${namespaces[ns].length})`);
          for (const name of namespaces[ns].sort()) {
            console.log(`    ${chalk.gray('•')} ${name}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/goal': {
      const arg = args.join(' ').trim();
      const ws = agent.workspaceRoot;
      const sk = agent.sessionKey;
      const showStatus = (g: import('../state/goalStore.js').Goal | null) => {
        if (!g) {
          console.log(chalk.yellow('\nNo active goal. Set one with: /goal <outcome statement>\n'));
          console.log(chalk.gray('Outcome-first format works best:'));
          console.log(chalk.gray('  /goal <desired end state> verified by <evidence> while preserving <constraints>.\n'));
          return;
        }
        const status = g.status === 'active' ? chalk.green(g.status)
          : g.status === 'paused' ? chalk.yellow(g.status)
          : g.status === 'complete' ? chalk.cyan(g.status)
          : chalk.red(g.status);
        console.log(chalk.bold('\nGoal'));
        console.log(`  Status:     ${status}`);
        console.log(`  Outcome:    ${chalk.cyan(g.text)}`);
        console.log(`  Budget:     ${g.budget.iterationsUsed}/${g.budget.maxIterations} iterations used`);
        console.log(`  Started:    ${chalk.gray(g.startedAt)}`);
        if (g.completedAt) console.log(`  Completed:  ${chalk.gray(g.completedAt)}`);
        if (g.blockedReason) console.log(`  Note:       ${chalk.gray(g.blockedReason)}`);
        console.log(chalk.gray('\nSubcommands: /goal <text> | pause | resume | complete | clear | budget <n>\n'));
      };

      if (!arg || arg === 'show') { showStatus(readGoal(ws, sk)); break; }
      if (arg === 'clear') {
        clearGoal(ws, sk);
        agent.refreshSystemPrompt();
        console.log(chalk.green('\n✓ Goal cleared.\n'));
        break;
      }
      if (arg === 'pause') {
        const g = pauseGoal(ws, sk);
        if (!g) console.log(chalk.yellow('\nNo active goal to pause.\n'));
        else { agent.refreshSystemPrompt(); console.log(chalk.yellow(`\n⏸  Goal paused. No auto-continuation until /goal resume.\n`)); }
        break;
      }
      if (arg === 'resume') {
        const g = resumeGoal(ws, sk);
        if (!g) { console.log(chalk.yellow('\nNo goal to resume.\n')); break; }
        agent.refreshSystemPrompt();
        console.log(chalk.green(`\n▶  Goal resumed (${g.budget.iterationsUsed}/${g.budget.maxIterations} used). Starting next iteration…\n`));
        // Fire the next iteration immediately so the user doesn't have to type
        // a "proceed" message — the whole point of /goal is autonomy.
        ctx.runAgentTurn(buildGoalKickoffPrompt(g, 'resume'));
        return; // runAgentTurn owns its prompt cycle
      }
      if (arg === 'complete') {
        const g = completeGoal(ws, sk, 'Marked complete manually by user.');
        if (!g) console.log(chalk.yellow('\nNo goal to mark complete.\n'));
        else { agent.refreshSystemPrompt(); console.log(chalk.green(`\n🎯  Goal marked complete.\n`)); }
        break;
      }
      if (arg.startsWith('budget')) {
        const n = Number(arg.replace(/^budget\s*/, '').trim());
        if (!Number.isFinite(n) || n < 1) {
          console.log(chalk.red('\nUsage: /goal budget <positive integer>\n'));
          break;
        }
        const g = setGoalBudget(ws, sk, Math.floor(n));
        if (!g) console.log(chalk.yellow('\nNo goal to update.\n'));
        else { agent.refreshSystemPrompt(); console.log(chalk.green(`\n✓ Budget set to ${g.budget.maxIterations} iterations (${g.budget.iterationsUsed} already used).\n`)); }
        break;
      }
      // Anything else is a new goal text.
      let goal: import('../state/goalStore.js').Goal;
      try {
        goal = setGoal(ws, arg, sk);
      } catch (err: any) {
        if (err instanceof GoalTooLongError) {
          console.log(chalk.red(`\n✗ ${err.message}`));
          console.log(chalk.gray(`  Tip: a goal is a 1–3 sentence outcome statement, not a chat log. Max ${GOAL_TEXT_MAX_CHARS} chars.\n`));
          break;
        }
        throw err;
      }
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Goal set: ${chalk.cyan(goal.text)}`));
      console.log(chalk.gray(`Budget: ${goal.budget.maxIterations} iterations. The CLI will auto-continue after each turn until the agent calls goal_complete / goal_blocked or you /goal pause | clear.`));
      console.log(chalk.gray('Kicking off iteration 1 now — type anything to cancel.\n'));
      // Fire the first turn immediately so /goal doesn't require a "proceed"
      // follow-up. The post-turn continuation loop in runAgentTurn handles
      // iterations 2..N.
      ctx.runAgentTurn(buildGoalKickoffPrompt(goal, 'start'));
      return; // runAgentTurn owns its prompt cycle
    }

    case '/copy': {
      if (!agent.lastAnswer) {
        console.log(chalk.yellow('\nNo response yet to copy.\n'));
        break;
      }
      const result = await copyToClipboard(agent.lastAnswer);
      if (result.ok) {
        console.log(chalk.green(`\n✓ Copied last response to clipboard via ${result.tool} (${agent.lastAnswer.length} chars).\n`));
      } else {
        console.log(chalk.yellow(`\nClipboard tool unavailable (${result.error}). Selecting the text above with your terminal still works.\n`));
      }
      break;
    }

    case '/fork': {
      const label = args.join(' ').trim() || `fork-${new Date().toISOString().slice(11, 19)}`;
      const newKey = `${agent.sessionKey}:fork:${randomUUID().slice(0, 8)}:${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
      const previous = agent.sessionKey;
      agent.fork(newKey);
      console.log(chalk.green(`\n✓ Forked session.`));
      console.log(chalk.gray(`  Parent : ${previous}`));
      console.log(chalk.gray(`  New    : ${newKey}`));
      console.log(chalk.gray('  Your next message starts a new transcript while keeping prior context.\n'));
      break;
    }

    case '/rename': {
      const newName = args.join(' ').trim();
      if (!newName) {
        console.log(chalk.red('\nUsage: /rename <new session label>\n'));
        break;
      }
      const safe = newName.replace(/[^A-Za-z0-9._-]+/g, '-');
      const previous = agent.sessionKey;
      const newKey = `${previous.split(':')[0]}:${safe}`;
      agent.sessionKey = newKey;
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Session renamed`));
      console.log(chalk.gray(`  Old: ${previous}`));
      console.log(chalk.gray(`  New: ${newKey}`));
      console.log(chalk.gray('  (Future transcript entries land under the new key; existing entries stay under the old.)\n'));
      break;
    }

    case '/permissions': {
      const sub = args[0];
      if (!sub) {
        const mode = agent.getAccessMode();
        console.log(chalk.bold(`\nCurrent access mode: ${chalk.cyan(mode)}`));
        console.log(chalk.gray('  read   — list/grep/read/web only. No file writes, no shell.'));
        console.log(chalk.gray('  write  — read + write_file / edit_file / apply_patch. No shell.'));
        console.log(chalk.gray('  shell  — write + run_command (still confirmed in the REPL).'));
        console.log(chalk.gray('\nSwitch with: /permissions read | write | shell  (or use Shift+Tab to cycle)\n'));
        break;
      }
      if (!['read', 'write', 'shell'].includes(sub)) {
        console.log(chalk.red(`\nUnknown mode "${sub}". Choose: read, write, shell.\n`));
        break;
      }
      agent.setAccessMode(sub as 'read' | 'write' | 'shell');
      ctx.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Access mode → ${chalk.cyan(sub)}\n`));
      break;
    }

    case '/hooks': {
      const sub = args[0];
      if (!sub || sub === 'list') {
        const hooks = readHooks(agent.workspaceRoot);
        console.log(chalk.bold('\nLifecycle hooks'));
        if (hooks.length === 0) {
          console.log(chalk.yellow('  (none)'));
          console.log(chalk.gray('  Add one with: /hooks add <event> <shell-command>  (events: pre-turn, post-turn, pre-tool, post-tool, session-start, session-end)\n'));
        } else {
          for (const h of hooks) {
            const tag = h.enabled ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${tag} ${chalk.cyan(h.id)} ${chalk.gray(h.event)}${h.match ? chalk.gray(` (match: ${h.match})`) : ''}`);
            console.log(`    ${chalk.gray(h.command)}`);
          }
          console.log();
        }
        break;
      }
      if (sub === 'add') {
        const event = args[1] as HookEvent | undefined;
        const command = args.slice(2).join(' ').trim();
        const validEvents: HookEvent[] = ['pre-turn', 'post-turn', 'pre-tool', 'post-tool', 'session-start', 'session-end'];
        if (!event || !validEvents.includes(event) || !command) {
          console.log(chalk.red(`\nUsage: /hooks add <${validEvents.join('|')}> <shell-command>\n`));
          break;
        }
        const created = addHook(agent.workspaceRoot, { event, command });
        console.log(chalk.green(`\n✓ Hook added: ${created.id}\n`));
        break;
      }
      if (sub === 'remove' && args[1]) {
        const ok = removeHook(agent.workspaceRoot, args[1]);
        console.log(ok ? chalk.green(`\n✓ Removed ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        break;
      }
      if ((sub === 'enable' || sub === 'disable') && args[1]) {
        const ok = setHookEnabled(agent.workspaceRoot, args[1], sub === 'enable');
        console.log(ok ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        break;
      }
      console.log(chalk.red('\nUsage: /hooks [list | add <event> <cmd> | remove <id> | enable <id> | disable <id>]\n'));
      break;
    }

    case '/loop': {
      const arg0 = args[0];
      if (!arg0 || arg0 === 'status') {
        const state = getLoopState();
        if (!state) console.log(chalk.yellow('\nNo loop running.\n'));
        else {
          console.log(chalk.bold('\nLoop state'));
          console.log(`  Prompt:      ${chalk.cyan(state.prompt)}`);
          console.log(`  Interval:    ${chalk.gray(`${state.intervalMs}ms`)}`);
          console.log(`  Iterations:  ${chalk.gray(state.iterations.toString())}`);
          if (state.lastFiredAt) console.log(`  Last fired:  ${chalk.gray(state.lastFiredAt)}`);
          if (state.lastError) console.log(`  Last error:  ${chalk.red(state.lastError)}`);
          console.log(chalk.gray('\n  Stop with /loop stop\n'));
        }
        break;
      }
      if (arg0 === 'stop') {
        const ok = stopLoop();
        console.log(ok ? chalk.green('\n✓ Loop stopped.\n') : chalk.yellow('\nNo loop was running.\n'));
        break;
      }
      const intervalMs = parseInterval(arg0);
      const loopPrompt = args.slice(intervalMs ? 1 : 0).join(' ').trim();
      if (!intervalMs || !loopPrompt) {
        console.log(chalk.red('\nUsage: /loop <interval> <prompt>'));
        console.log(chalk.gray('  e.g. /loop 30s /review'));
        console.log(chalk.gray('       /loop 5m check the deploy status\n'));
        break;
      }
      const result = startLoop(loopPrompt, intervalMs, async () => {
        // Each tick queues the loop's prompt as if the user typed it. We use
        // the REPL's processing flag to avoid stomping on a turn the user
        // started manually.
        if (ctx.isProcessing()) return;
        console.log(chalk.gray(`\n⟲ Loop tick (iteration ${(getLoopState()?.iterations ?? 0)})`));
        rl.write(`${loopPrompt}\n`);
      });
      if (result.started) {
        console.log(chalk.green(`\n✓ Loop started — "${loopPrompt}" every ${intervalMs}ms.`));
        console.log(chalk.gray('  Stop with /loop stop.\n'));
      } else {
        console.log(chalk.red(`\nLoop not started: ${result.reason}\n`));
      }
      break;
    }

    case '/continue': {
      const last = agent.lastUserPrompt;
      if (!last) {
        console.log(chalk.yellow('\nNothing to continue — no prior prompt this session. Just type your next message.\n'));
        break;
      }
      // Inspect child-agent state up front so /continue gives the LLM
      // concrete instructions instead of a vague "wait for children". Without
      // this, the model frequently text-replies "I am waiting…" without ever
      // calling wait_agent and the turn just hangs the user.
      reconcileStale(agent.workspaceRoot);
      const allChildren = listSessions(agent.workspaceRoot);
      const running = allChildren.filter((s) => s.status === 'pending' || s.status === 'running');
      const recentlyDone = allChildren
        .filter((s) => s.status === 'completed' || s.status === 'failed')
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 5);

      const sections: string[] = [
        `You were in the middle of working on: "${last}"`,
        '',
      ];
      if (running.length > 0) {
        const ids = running.map((s) => `${s.id} (${s.role}, ${s.status})`).join(', ');
        sections.push(
          `## Children still running`,
          `${running.length} child agent${running.length === 1 ? '' : 's'} have NOT finished yet: ${ids}.`,
          `**You MUST call \`wait_agent\` on each one** before producing a final answer. Do not respond with prose like "I am waiting" — that is a no-op. Issue the tool calls now in this turn.`,
          '',
        );
      }
      if (recentlyDone.length > 0) {
        const lines = recentlyDone.map((s) => `- ${s.id} (${s.role}): ${s.status}${s.error ? ` — ${s.error}` : ''}`);
        sections.push(
          `## Children that already finished`,
          `Use \`read_agent_transcript\` (or the cached finalOutput in \`list_agents\`) to incorporate their work:`,
          ...lines,
          '',
        );
      }
      if (running.length === 0 && recentlyDone.length === 0) {
        sections.push('No child agents are tracked. Pick up where you left off.', '');
      }
      sections.push(
        agent.lastTurnHitLoopLimit
          ? 'You ran out of tool-loop iterations before producing a final answer. Resume now: drain any pending children, then finish writing the workflow artifacts (`spec.md` / `tasks.md` / `walkthrough.md`) before giving a summary.'
          : 'Resume the workflow. Synthesize whatever children produced, then finish writing the artifacts the workflow expects (`spec.md` / `tasks.md` / `walkthrough.md`).',
      );

      ctx.runAgentTurn(sections.join('\n'));
      return; // runAgentTurn handles its own prompt cycle
    }

    case '/auto-review': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args[0];
      if (!arg) {
        console.log(chalk.bold(`\nAuto-review: ${prefs.autoReview ? chalk.green('on') : chalk.gray('off')}`));
        console.log(chalk.gray('  When on, every worker child agent is auto-followed by a reviewer agent on its diff.'));
        console.log(chalk.gray('  Toggle with: /auto-review on | off\n'));
        break;
      }
      const next = arg === 'on' || arg === 'true';
      writePreferences(agent.workspaceRoot, { autoReview: next });
      console.log(chalk.green(`\n✓ Auto-review ${next ? 'enabled' : 'disabled'}.\n`));
      break;
    }

    case '/vim': {
      const prefs = readPreferences(agent.workspaceRoot);
      const next = prefs.editorMode === 'vi' ? 'emacs' : 'vi';
      writePreferences(agent.workspaceRoot, { editorMode: next });
      console.log(chalk.green(`\n✓ Editor mode → ${next}. Restart the CLI to apply.\n`));
      break;
    }

    case '/statusline': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nStatusline'));
        console.log(`  Current: ${chalk.cyan(prefs.statusline)}`);
        console.log(chalk.gray('  Available segments: mode, branch, dirty, model, tokens, session'));
        console.log(chalk.gray('  Example: /statusline mode,branch,dirty,tokens\n'));
        break;
      }
      const valid = new Set(['mode', 'branch', 'dirty', 'model', 'tokens', 'session']);
      const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((s) => !valid.has(s));
      if (unknown.length > 0) {
        console.log(chalk.red(`\nUnknown segment(s): ${unknown.join(', ')}. Valid: ${Array.from(valid).join(', ')}\n`));
        break;
      }
      writePreferences(agent.workspaceRoot, { statusline: requested.join(',') });
      ctx.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Statusline set to: ${requested.join(',')}\n`));
      break;
    }

    case '/handover': {
      // Generate a compact continuation note from current task memories so
      // the next session can pick up. Uses memory_handover.
      await printMcpCall(mcpClient, 'memory_handover', { sessionKey: agent.sessionKey }, 'Session handover note');
      break;
    }

    case '/explain': {
      const query = args.join(' ').trim();
      if (!query) {
        console.log(chalk.red('\nUsage: /explain <query>\n'));
        console.log(chalk.gray('  Re-runs recall in explain mode: shows FTS hits, vector hits, RRF scores, type/skill boosts, reranker, graph expansion.\n'));
        break;
      }
      await printMcpCall(mcpClient, 'memory_explain_recall', { sessionKey: agent.sessionKey, query }, `Recall explanation · "${query}"`);
      break;
    }

    case '/trace': {
      const sub = args[0];
      if (sub === 'save') {
        const rest = args.slice(1).join(' ').trim();
        if (!rest) { console.log(chalk.red('\nUsage: /trace save <description>\n')); break; }
        await printMcpCall(mcpClient, 'memory_debug_trace_save', { content: rest }, 'Saved debug trace');
        break;
      }
      if (sub === 'search' || !sub) {
        const query = args.slice(1).join(' ').trim();
        if (sub !== 'search' && !query) {
          console.log(chalk.red('\nUsage: /trace save <description> | /trace search <query>\n'));
          break;
        }
        await printMcpCall(mcpClient, 'memory_debug_trace_search', { query: query || '*' }, 'Prior debug traces');
        break;
      }
      console.log(chalk.red('\nUsage: /trace save <description> | /trace search <query>\n'));
      break;
    }

    case '/failed': {
      const area = args.join(' ').trim();
      await printMcpCall(mcpClient, 'memory_failed_attempts', area ? { area } : {}, `Past failed attempts${area ? ` · "${area}"` : ''}`);
      break;
    }

    case '/verify': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /verify <recordId> [status] [confidence]\n')); break; }
      const status = args[1] || 'verified';
      const confidence = args[2] ? Number(args[2]) : 0.9;
      await printMcpCall(mcpClient, 'memory_verify', { recordId: id, verificationStatus: status, confidence }, `Verify ${id}`);
      break;
    }

    case '/audit': {
      await printMcpCall(mcpClient, 'memory_audit', { limit: 30 }, 'Recent memory audit log');
      break;
    }

    case '/export': {
      const out = args[0] || `.brainrouter/cli/memory-export-${Date.now()}.json`;
      const res = await callMcpTool<any>(mcpClient, 'memory_export', {});
      if (res.isError) {
        console.log(chalk.red(`\nmemory_export failed: ${res.text}\n`));
      } else {
        try {
          fs.writeFileSync(path.resolve(agent.workspaceRoot, out), res.text, 'utf8');
          console.log(chalk.green(`\n✓ Exported memory to ${out} (${res.text.length} chars)\n`));
        } catch (err: any) {
          console.log(chalk.red(`\nWrite failed: ${err.message}\n`));
        }
      }
      break;
    }

    case '/import': {
      const src = args[0];
      if (!src) { console.log(chalk.red('\nUsage: /import <path-to-export.json>\n')); break; }
      let envelope: string;
      try { envelope = fs.readFileSync(path.resolve(agent.workspaceRoot, src), 'utf8'); }
      catch (err: any) { console.log(chalk.red(`\nRead failed: ${err.message}\n`)); break; }
      await printMcpCall(mcpClient, 'memory_import', { envelope }, `Import from ${src}`);
      break;
    }

    case '/persona': {
      const name = args.join(' ').trim();
      if (!name) {
        console.log(chalk.red('\nUsage: /persona <persona-name>\n'));
        console.log(chalk.gray('  Example: /persona code-reviewer (see /skills for available personas)\n'));
        break;
      }
      await printMcpCall(mcpClient, 'get_persona', { name }, `Persona · ${name}`);
      break;
    }

    case '/skill-hints': {
      const skill = args[0];
      const hints = args.slice(1).join(' ').trim();
      if (!skill || !hints) {
        console.log(chalk.red('\nUsage: /skill-hints <skill-name> <hints>\n'));
        break;
      }
      await printMcpCall(mcpClient, 'memory_register_skill_hints', { skill, hints }, `Registered hints for ${skill}`);
      break;
    }

    case '/diagnostics': {
      await printMcpCall(mcpClient, 'memory_diagnostics', {}, 'Memory diagnostics');
      break;
    }

    case '/working': {
      const sub = args[0];
      if (sub === 'reset') {
        const confirm = args[1];
        if (confirm !== 'confirm') {
          console.log(chalk.yellow('\n⚠ /working reset clears the working-memory canvas. Confirm with: /working reset confirm\n'));
          break;
        }
        await printMcpCall(mcpClient, 'memory_working_reset', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot }, 'Working memory reset');
        break;
      }
      await printMcpCall(mcpClient, 'memory_working_context', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot }, 'Working memory canvas');
      break;
    }

    case '/yolo': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      if (!arg) {
        console.log(chalk.bold(`\nAuto-approve shell: ${prefs.autoApproveShell ? chalk.red('ON') : chalk.green('off')}`));
        console.log(chalk.gray('  When ON, run_command skips the per-call confirmation prompt and executes immediately.'));
        console.log(chalk.gray('  Pair with BRAINROUTER_SANDBOX=on if you still want a safety net.'));
        console.log(chalk.gray('  Toggle with: /yolo on  |  /yolo off\n'));
        break;
      }
      const next = arg === 'on' || arg === 'true' || arg === '1';
      writePreferences(agent.workspaceRoot, { autoApproveShell: next });
      if (next) {
        console.log(chalk.red('\n⚠  /yolo ON — run_command will now execute without asking.'));
        console.log(chalk.gray('   You are in access mode "shell" so the agent CAN call shell commands.'));
        console.log(chalk.gray('   Lower the risk with /permissions write (no shell), or set BRAINROUTER_SANDBOX=on.\n'));
      } else {
        console.log(chalk.green('\n✓ /yolo off — run_command will prompt for confirmation again.\n'));
      }
      break;
    }

    case '/sandbox': {
      const sub = (args[0] ?? '').toLowerCase();
      const rest = args.slice(1).join(' ').trim();
      const prefs = readPreferences(agent.workspaceRoot);
      const showState = () => {
        const enabled = (process.env.BRAINROUTER_SANDBOX ?? '').toLowerCase() === 'on';
        console.log(chalk.bold('\nSandbox'));
        console.log(`  Engine:  ${enabled ? chalk.green('on') : chalk.gray('off')} ${chalk.gray('(BRAINROUTER_SANDBOX env)')}`);
        console.log(`  Platform: ${chalk.cyan(process.platform)} ${chalk.gray(process.platform === 'darwin' ? '(sandbox-exec)' : process.platform === 'linux' ? '(bwrap/firejail)' : '(unsupported — run_command runs unsandboxed)')}`);
        console.log(`  Workspace (always rw): ${chalk.blue(agent.workspaceRoot)}`);
        console.log(chalk.bold('  Read-only grants:'));
        if (prefs.sandboxReadPaths.length === 0) console.log(chalk.gray('    (none)'));
        else for (const p of prefs.sandboxReadPaths) console.log(`    ${chalk.cyan(p)}`);
        console.log(chalk.bold('  Write grants (beyond workspace):'));
        if (prefs.sandboxWritePaths.length === 0) console.log(chalk.gray('    (none)'));
        else for (const p of prefs.sandboxWritePaths) console.log(`    ${chalk.cyan(p)}`);
        console.log(chalk.gray('\n  Subcommands:'));
        console.log(chalk.gray('    /sandbox add-read <path>     grant read-only access'));
        console.log(chalk.gray('    /sandbox add-write <path>    grant read+write access'));
        console.log(chalk.gray('    /sandbox remove <path>       drop a grant (matches either list)'));
        console.log(chalk.gray('    /sandbox clear               drop all persisted grants'));
        console.log(chalk.gray('    /sandbox status              show this view\n'));
      };
      if (!sub || sub === 'status') { showState(); break; }
      const resolveGrant = (p: string): string | null => {
        if (!p) return null;
        const abs = path.resolve(agent.workspaceRoot, p);
        if (!fs.existsSync(abs)) {
          console.log(chalk.yellow(`\n⚠  Path does not exist: ${abs}`));
          console.log(chalk.gray('   Granting anyway — create it later or the sandbox will skip the bind.\n'));
        }
        return abs;
      };
      if (sub === 'add-read') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox add-read <path>\n')); break; }
        const next = Array.from(new Set([...prefs.sandboxReadPaths, abs]));
        writePreferences(agent.workspaceRoot, { sandboxReadPaths: next });
        console.log(chalk.green(`\n✓ Added read grant: ${abs}\n`));
        break;
      }
      if (sub === 'add-write') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox add-write <path>\n')); break; }
        const next = Array.from(new Set([...prefs.sandboxWritePaths, abs]));
        writePreferences(agent.workspaceRoot, { sandboxWritePaths: next });
        console.log(chalk.green(`\n✓ Added write grant: ${abs}\n`));
        break;
      }
      if (sub === 'remove') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox remove <path>\n')); break; }
        writePreferences(agent.workspaceRoot, {
          sandboxReadPaths: prefs.sandboxReadPaths.filter((p) => p !== abs),
          sandboxWritePaths: prefs.sandboxWritePaths.filter((p) => p !== abs),
        });
        console.log(chalk.green(`\n✓ Removed grant: ${abs}\n`));
        break;
      }
      if (sub === 'clear') {
        writePreferences(agent.workspaceRoot, { sandboxReadPaths: [], sandboxWritePaths: [] });
        console.log(chalk.green('\n✓ Cleared all persisted sandbox grants.\n'));
        break;
      }
      console.log(chalk.red(`\nUnknown /sandbox subcommand "${sub}". Run /sandbox for help.\n`));
      break;
    }

    case '/kill': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /kill <agent-id>\n')); break; }
      const session = getSession(agent.workspaceRoot, id);
      if (!session) { console.log(chalk.red(`\nNo agent session with id "${id}".\n`)); break; }
      if (session.status !== 'pending' && session.status !== 'running') {
        console.log(chalk.gray(`\nAgent ${id} is already ${session.status}.\n`));
        break;
      }
      ctx.runAgentTurn(
        `Use the close_agent tool with id="${id}" and reason="user-requested kill". Then confirm the close result.`,
      );
      return;
    }

    case '/watch': {
      const tracePath = process.env.BRAINROUTER_TRACE_LOG?.trim();
      if (!tracePath) {
        console.log(chalk.yellow('\nLive tracing is off. Enable with:'));
        console.log(chalk.gray('  export BRAINROUTER_TRACE_LOG=' + path.join(agent.workspaceRoot, '.brainrouter/cli/trace.jsonl')));
        console.log(chalk.gray('  (restart the CLI so the change takes effect)\n'));
        console.log(chalk.gray('Without it, you can still see per-tool activity inline in this REPL,'));
        console.log(chalk.gray('and child-agent tool calls now surface as "role:id → tool" lines.'));
        console.log(chalk.gray('Use /agents and /agent <id> --full for the persisted child transcripts.\n'));
        break;
      }
      if (!fs.existsSync(tracePath)) {
        console.log(chalk.yellow(`\nTrace file does not exist yet: ${tracePath}\nIt will appear after the first turn.\n`));
        break;
      }
      console.log(chalk.bold(`\n📡 Tailing ${tracePath} — Ctrl+C to stop.\n`));
      // Stream the last 30 lines + new appends as JSONL until the user
      // interrupts with Ctrl+C. We use child_process tail because that's
      // dramatically simpler than re-implementing inotify in Node.
      const tail = exec(`tail -n 30 -f "${tracePath}"`);
      const lineHandler = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const raw of text.split('\n')) {
          if (!raw.trim()) continue;
          try {
            const e = JSON.parse(raw);
            const attrs = e.attributes ?? {};
            const dur = typeof e.duration_ms === 'number' ? chalk.gray(` ${e.duration_ms}ms`) : '';
            const detail = Object.entries(attrs)
              .slice(0, 4)
              .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
              .join(' ');
            console.log(`${chalk.gray(e.ts?.slice(11, 19) ?? '')} ${chalk.cyan(e.name)}${dur} ${chalk.gray(detail)}`);
          } catch { /* not JSON — print raw */ console.log(chalk.gray(raw)); }
        }
      };
      tail.stdout?.on('data', lineHandler);
      tail.stderr?.on('data', (c) => process.stderr.write(c));
      const onInterrupt = () => {
        try { tail.kill('SIGTERM'); } catch { /* noop */ }
        console.log(chalk.gray('\nwatch ended.\n'));
        rl.off('SIGINT', onInterrupt);
        rl.prompt();
      };
      rl.once('SIGINT', onInterrupt);
      // Resume the prompt only after the user interrupts; otherwise the
      // tail stays attached.
      break;
    }

    case '/tokens': {
      const session = agent.sessionUsage;
      const metrics = agent.memoryMetrics;
      const children = listSessions(agent.workspaceRoot).filter((s) => s.usage);
      const childPrompt = children.reduce((acc, c) => acc + (c.usage?.promptTokens ?? 0), 0);
      const childCompletion = children.reduce((acc, c) => acc + (c.usage?.completionTokens ?? 0), 0);
      const childCalls = children.reduce((acc, c) => acc + (c.usage?.calls ?? 0), 0);

      // Memory savings estimate:
      // - Each recalled record (avg ~200 chars ≈ 50 tokens) supplies cross-
      //   session context that would otherwise require either a manual
      //   user explanation, a re-read of files, or skill re-discovery.
      //   Conservative multiplier of 5× to account for the "without memory
      //   you would have read 3-5 files" replacement cost.
      // - Offloaded child output bytes are subtracted from what the parent
      //   would otherwise have had to carry in context.
      const recallSavings = metrics.briefingTokensInjected * 5;
      const offloadSavings = Math.round(metrics.offloadCharsAvoided / 4);
      const totalSaved = recallSavings + offloadSavings;
      const totalSpent = session.promptTokens + session.completionTokens + childPrompt + childCompletion;

      console.log(chalk.bold('\nToken usage — this session'));
      console.log(`  Parent: ${chalk.cyan(session.promptTokens.toLocaleString())}↑  ${chalk.cyan(session.completionTokens.toLocaleString())}↓  ${chalk.gray(`(${session.turns} turn${session.turns === 1 ? '' : 's'}, ${session.calls} LLM call${session.calls === 1 ? '' : 's'})`)}`);
      if (children.length > 0) {
        console.log(`  Children (${children.length}): ${chalk.cyan(childPrompt.toLocaleString())}↑  ${chalk.cyan(childCompletion.toLocaleString())}↓  ${chalk.gray(`(${childCalls} LLM call${childCalls === 1 ? '' : 's'})`)}`);
        for (const c of children.slice(0, 5)) {
          const u = c.usage!;
          console.log(chalk.gray(`    · ${c.id} (${c.role}): ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓`));
        }
        if (children.length > 5) console.log(chalk.gray(`    …and ${children.length - 5} more (see /agents)`));
      }
      console.log(`  Total this session: ${chalk.bold.cyan(totalSpent.toLocaleString())} tokens`);

      console.log(chalk.bold('\nMemory savings (estimated)'));
      console.log(`  Briefing tokens injected:  ${chalk.gray(metrics.briefingTokensInjected.toLocaleString())}  (${metrics.recallRecordsConsulted} records consulted)`);
      console.log(`  Cross-session recall value: ~${chalk.green(recallSavings.toLocaleString())} tokens you'd otherwise spend re-reading files / re-explaining context`);
      console.log(`  Offload bytes avoided:     ${chalk.gray(metrics.offloadCharsAvoided.toLocaleString())} chars (large child outputs that stayed out of parent context)`);
      console.log(`  → Offload value:           ~${chalk.green(offloadSavings.toLocaleString())} tokens`);
      console.log(`  ${chalk.bold('Total estimated savings:')}  ${chalk.bold.green('~' + totalSaved.toLocaleString())} tokens`);

      if (totalSpent > 0) {
        const ratio = totalSaved / totalSpent;
        console.log(chalk.gray(`  Ratio: for every 1 token spent, memory saved ~${ratio.toFixed(2)} tokens of context.`));
      }
      console.log(chalk.gray('\n  (Estimates use a 5× multiplier on briefing tokens — a heuristic for "you would have needed to re-derive this from files/prompts otherwise". Treat as directional, not exact.)\n'));
      break;
    }

    case '/clear':
      agent.clearHistory();
      console.log(chalk.yellow('\nConversation history cleared.\n'));
      break;

    case '/compact': {
      const spinner = ora(chalk.gray('Summarizing conversation for compaction...')).start();
      try {
        const result = await agent.compactHistory();
        if (!result) {
          spinner.warn(chalk.yellow('Nothing to compact — chat history is already short.'));
          break;
        }
        spinner.succeed(chalk.green(`Compacted ${result.replacedMessages} messages → ~${result.estimatedTokens} tokens (${result.durationMs}ms).`));
        console.log(chalk.bold('\nCompaction summary:'));
        console.log(marked.parse(result.summary));
        console.log(chalk.gray('The summary is now part of system context. Continue normally.\n'));
      } catch (err: any) {
        spinner.fail(chalk.red(`Compaction failed: ${err.message}`));
        console.log(chalk.gray('Fallback: nothing was changed. Use /clear if you want to drop history without summarizing.\n'));
      }
      break;
    }

    case '/theme': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['auto', 'light', 'dark', 'mono']);
      if (!arg) {
        console.log(chalk.bold('\nTheme'));
        console.log(`  Current: ${chalk.cyan(prefs.theme)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}`));
        console.log(chalk.gray('  Set with: /theme <name>\n'));
        break;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown theme "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        break;
      }
      writePreferences(agent.workspaceRoot, { theme: arg as any });
      console.log(chalk.green(`\n✓ Theme → ${arg}\n`));
      break;
    }

    case '/title': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nTerminal title'));
        console.log(`  Current: ${chalk.cyan(prefs.terminalTitle)}`);
        console.log(chalk.gray('  Segments: model, branch, session, mode  (use "off" to disable)'));
        console.log(chalk.gray('  Example: /title model,session\n'));
        break;
      }
      writePreferences(agent.workspaceRoot, { terminalTitle: arg });
      try {
        if (arg.toLowerCase() !== 'off') {
          const segs = arg.split(',').map((s) => s.trim()).filter(Boolean);
          const parts: string[] = [];
          for (const seg of segs) {
            if (seg === 'model') parts.push(agent.getModel());
            else if (seg === 'session') parts.push(agent.sessionKey.slice(0, 24));
            else if (seg === 'mode') parts.push(agent.getAccessMode());
            else if (seg === 'branch') {
              try { parts.push(execSync('git rev-parse --abbrev-ref HEAD', { cwd: agent.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* not a git repo */ }
            }
          }
          if (parts.length > 0) process.stdout.write(`\x1b]0;brainrouter · ${parts.join(' · ')}\x07`);
        }
      } catch { /* terminal does not support OSC titles */ }
      console.log(chalk.green(`\n✓ Terminal title → ${arg}\n`));
      break;
    }

    case '/personality': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['concise', 'standard', 'detailed', 'pair-programmer']);
      if (!arg) {
        console.log(chalk.bold('\nPersonality (communication style)'));
        console.log(`  Current: ${chalk.cyan(prefs.personality)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}\n`));
        break;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown personality "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        break;
      }
      writePreferences(agent.workspaceRoot, { personality: arg as any });
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Personality → ${arg}. New behavior applies on the next turn.\n`));
      break;
    }

    case '/new': {
      const label = args.join(' ').trim() || `new-${new Date().toISOString().slice(11, 19)}`;
      const newKey = `${agent.sessionKey.split(':')[0]}:${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
      const previous = agent.sessionKey;
      agent.sessionKey = newKey;
      agent.clearHistory();
      console.log(chalk.green(`\n✓ Started a new chat.`));
      console.log(chalk.gray(`  Old: ${previous}`));
      console.log(chalk.gray(`  New: ${newKey}\n`));
      break;
    }

    case '/side':
    case '/btw': {
      const prompt = args.join(' ').trim();
      if (!prompt) {
        console.log(chalk.red(`\nUsage: ${command} <ephemeral side question>\n`));
        console.log(chalk.gray('  Side conversations run in a forked chat history and discard the result on exit.\n'));
        break;
      }
      const original = agent.sessionKey;
      const sideKey = `${original}:side:${randomUUID().slice(0, 6)}`;
      agent.sessionKey = sideKey;
      console.log(chalk.gray(`(side conversation in ${sideKey} — answer is ephemeral)\n`));
      // Fire-and-forget BUT restore the sessionKey when the turn finishes,
      // not after a fixed 100ms. The old setTimeout race restored the key
      // long before the turn finished its async work — capture, transcript
      // writes, contradiction checks — so side-conversation tool messages
      // and the assistant reply ended up appended to the MAIN session.
      void ctx.runAgentTurnAsync(prompt).finally(() => {
        agent.sessionKey = original;
      });
      return;
    }

    case '/raw': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.rawScrollback;
      writePreferences(agent.workspaceRoot, { rawScrollback: next });
      console.log(chalk.green(`\n✓ Raw scrollback ${next ? 'enabled' : 'disabled'}. Markdown rendering ${next ? 'OFF' : 'ON'} for next turn.\n`));
      break;
    }

    case '/feedback': {
      const msg = args.join(' ').trim();
      const dir = path.join(agent.workspaceRoot, '.brainrouter/cli');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'feedback.jsonl');
      const entry = {
        ts: new Date().toISOString(),
        sessionKey: agent.sessionKey,
        model: agent.getModel(),
        accessMode: agent.getAccessMode(),
        message: msg || '(no message provided)',
      };
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      console.log(chalk.green(`\n✓ Feedback recorded at ${path.relative(agent.workspaceRoot, file)}`));
      console.log(chalk.gray('  This stays local — share by attaching the file to a GitHub issue.\n'));
      break;
    }

    case '/rollout': {
      const { getSessionStateDir } = await import('../state/cliState.js');
      const sessionDir = getSessionStateDir(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.bold('\nSession bucket'));
      console.log(`  Session:   ${chalk.cyan(agent.sessionKey)}`);
      console.log(`  Directory: ${chalk.blue(sessionDir)}`);
      const interestingFiles = ['transcript.jsonl', 'goal.json', 'tasks.json'];
      console.log(chalk.bold('\nFiles in bucket:'));
      let printedAny = false;
      for (const name of interestingFiles) {
        const full = path.join(sessionDir, name);
        if (fs.existsSync(full)) {
          const stat = fs.statSync(full);
          console.log(`  ${chalk.cyan(name.padEnd(18))} ${chalk.gray(`${stat.size} bytes · modified ${stat.mtime.toISOString()}`)}`);
          printedAny = true;
        }
      }
      if (!printedAny) console.log(chalk.gray('  (empty — files appear after you set a goal, update a plan, or run a turn)'));
      console.log();
      break;
    }

    case '/ps': {
      const loopState = getLoopState();
      console.log(chalk.bold('\nBackground tasks'));
      if (!loopState) {
        console.log(chalk.gray('  No /loop running.'));
      } else {
        console.log(`  Loop: ${chalk.cyan(loopState.prompt)} (${loopState.iterations} ticks, every ${loopState.intervalMs}ms)`);
      }
      reconcileStale(agent.workspaceRoot);
      const sessions = listSessions(agent.workspaceRoot).filter((s) => s.status === 'pending' || s.status === 'running');
      if (sessions.length === 0) {
        console.log(chalk.gray('  No running child agents.'));
      } else {
        for (const s of sessions) {
          console.log(`  Agent: ${chalk.cyan(s.id)} ${chalk.gray(s.role)} (${s.status})`);
        }
      }
      console.log();
      break;
    }

    case '/stop': {
      // Stop the loop AND mark any running children stale.
      const stopped = stopLoop();
      console.log(stopped ? chalk.green('\n✓ Stopped /loop.') : chalk.gray('\nNo loop was running.'));
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(chalk.yellow(`Marked ${reconciled} child session(s) stale.`));
      console.log();
      break;
    }

    case '/logout': {
      // Remove the API key from the active server profile. The CLI keeps the
      // profile so a future /login can re-attach credentials.
      const profile = config.activeServer;
      const server = config.servers[profile];
      if (!server) {
        console.log(chalk.red(`\nNo active profile to log out of.\n`));
        break;
      }
      const removed: string[] = [];
      if ((server as any).apiKey) { delete (server as any).apiKey; removed.push('server.apiKey'); }
      if (config.llm?.apiKey) { (config.llm as any).apiKey = ''; removed.push('llm.apiKey'); }
      if (removed.length === 0) {
        console.log(chalk.gray(`\nNo credentials were set on profile "${profile}".\n`));
        break;
      }
      const { saveConfig } = await import('../config/config.js');
      saveConfig(config);
      console.log(chalk.green(`\n✓ Cleared ${removed.join(', ')} from profile "${profile}".`));
      console.log(chalk.gray('  Re-attach with /login.\n'));
      break;
    }

    case '/apps':
    case '/plugins': {
      const skillsRoot = path.join(agent.workspaceRoot, 'skills');
      const pluginsRoot = path.join(agent.workspaceRoot, 'plugins');
      console.log(chalk.bold(`\n${command === '/apps' ? 'Apps' : 'Plugins'}`));
      const roots = [skillsRoot, pluginsRoot].filter((p) => fs.existsSync(p));
      if (roots.length === 0) {
        console.log(chalk.yellow('  No skills/ or plugins/ directory in this workspace.'));
        console.log(chalk.gray('  Drop a folder under skills/<category>/<name>/SKILL.md to register one.\n'));
        break;
      }
      for (const root of roots) {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          console.log(chalk.cyan(`  ${path.relative(agent.workspaceRoot, path.join(root, entry.name))}`));
        }
      }
      console.log();
      break;
    }

    case '/experimental': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.experimental;
      writePreferences(agent.workspaceRoot, { experimental: next });
      console.log(chalk.green(`\n✓ Experimental features ${next ? 'enabled' : 'disabled'}.`));
      if (next) console.log(chalk.gray('  Streaming output, theme rendering, and other gated features are now active.\n'));
      else console.log();
      break;
    }

    case '/memories': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const prefs = readPreferences(agent.workspaceRoot);
        console.log(chalk.bold('\nMemories pipeline'));
        console.log(`  Enabled: ${prefs.memoriesEnabled ? chalk.green('on') : chalk.gray('off')}`);
        console.log(chalk.gray('  Subcommands:'));
        console.log(chalk.gray('    /memories on | off          — toggle the pipeline'));
        console.log(chalk.gray('    /memories consolidate       — write user/feedback/project/reference files'));
        console.log(chalk.gray('    /memories status            — show this view\n'));
        break;
      }
      if (sub === 'on' || sub === 'off') {
        writePreferences(agent.workspaceRoot, { memoriesEnabled: sub === 'on' });
        console.log(chalk.green(`\n✓ Memories pipeline ${sub === 'on' ? 'enabled' : 'disabled'}.\n`));
        break;
      }
      if (sub === 'consolidate') {
        const spinner = ora(chalk.gray('Consolidating memories from MCP into filesystem artifacts...')).start();
        try {
          const result = await consolidateMemories(mcpClient, agent.workspaceRoot, { sessionKey: agent.sessionKey });
          spinner.succeed(chalk.green(`Consolidated ${result.totalRecords} records.`));
          console.log(chalk.bold('\nPer-type counts:'));
          for (const [t, n] of Object.entries(result.perType)) {
            console.log(`  ${chalk.cyan(t.padEnd(10))} ${n}`);
          }
          console.log(chalk.bold('\nFiles written:'));
          for (const f of result.files) console.log(`  ${chalk.gray(f)}`);
          console.log();
        } catch (err: any) {
          spinner.fail(chalk.red(`Consolidation failed: ${err.message}\n`));
        }
        break;
      }
      console.log(chalk.red(`\nUnknown /memories subcommand "${sub}". Try: status, on, off, consolidate.\n`));
      break;
    }

    case '/debug-config': {
      console.log(chalk.bold('\nConfig layers (in order of precedence)'));
      console.log(`  Workspace: ${chalk.cyan(agent.workspaceRoot)}`);
      console.log(`  CLI state: ${chalk.cyan(path.join(agent.workspaceRoot, '.brainrouter/cli'))}`);
      console.log(`  Profile:   ${chalk.cyan(config.activeServer)}`);
      console.log(`  Server:    ${chalk.cyan(JSON.stringify(config.servers[config.activeServer], null, 2).split('\n').map((l) => '             ' + l).join('\n').trim())}`);
      console.log(chalk.bold('\nEnvironment'));
      const flags = ['BRAINROUTER_SANDBOX', 'BRAINROUTER_SANDBOX_READ_PATHS', 'BRAINROUTER_SANDBOX_WRITE_PATHS', 'BRAINROUTER_SANDBOX_NETWORK', 'BRAINROUTER_TRACE_LOG', 'BRAINROUTER_MAX_TOOL_LOOPS', 'BRAINROUTER_LLM_TIMEOUT_MS', 'BRAINROUTER_WORKSPACE'];
      for (const f of flags) {
        const v = process.env[f];
        if (v) console.log(`  ${chalk.cyan(f)} = ${v}`);
      }
      console.log(chalk.bold('\nPreferences'));
      console.log(chalk.gray(JSON.stringify(readPreferences(agent.workspaceRoot), null, 2)));
      console.log();
      break;
    }

    case '/mention': {
      const partial = args.join(' ').trim();
      console.log(chalk.bold('\nFile mention helper'));
      console.log(chalk.gray('  Inline syntax: write `@path/to/file` in a prompt — the CLI expands it before sending.'));
      const ws = agent.workspaceRoot;
      const suggestions = completeWorkspacePath(ws, partial || '');
      if (suggestions.length === 0) {
        console.log(chalk.yellow('  No files matched.\n'));
        break;
      }
      console.log(chalk.gray(`  Workspace matches${partial ? ` for "${partial}"` : ''}:`));
      for (const s of suggestions.slice(0, 20)) console.log(`    ${chalk.cyan('@' + s)}`);
      if (suggestions.length > 20) console.log(chalk.gray(`    …and ${suggestions.length - 20} more`));
      console.log();
      break;
    }

    case '/keymap': {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nKeymap'));
        console.log(chalk.gray('  Current overrides:'));
        console.log(chalk.gray(`    ${prefs.keymap || '(none — defaults)'}`));
        console.log(chalk.bold('\n  Built-in bindings'));
        console.log(chalk.gray('    Shift+Tab       cycle access mode (read → write → shell)'));
        console.log(chalk.gray('    Tab             autocomplete slash commands and @mentions'));
        console.log(chalk.gray('    Ctrl+C          interrupt current turn / exit'));
        console.log(chalk.gray('    /vim            toggle vi-mode for the composer'));
        console.log(chalk.gray('\n  Set custom overrides (JSON map): /keymap {"submit":"ctrl+s"}\n'));
        break;
      }
      try {
        JSON.parse(arg); // validate
      } catch (err: any) {
        console.log(chalk.red(`\nInvalid JSON: ${err.message}\n`));
        break;
      }
      writePreferences(agent.workspaceRoot, { keymap: arg });
      console.log(chalk.green(`\n✓ Keymap overrides saved. Restart the CLI to apply.\n`));
      break;
    }

    case '/ide': {
      const env = process.env;
      console.log(chalk.bold('\nIDE context'));
      const cursor = env.CURSOR_TRACE_ID ? 'Cursor' : null;
      const code = env.VSCODE_INJECTION || env.VSCODE_PID ? 'VS Code' : null;
      const jet = env.JETBRAINS_IDE || env.IDEA_INITIAL_DIRECTORY ? 'JetBrains' : null;
      const detected = [cursor, code, jet].filter(Boolean);
      console.log(`  Detected: ${detected.length > 0 ? chalk.cyan(detected.join(', ')) : chalk.gray('(none — running standalone)')}`);
      console.log(chalk.gray('  Brainrouter reads files via the workspace root; if your IDE has an open selection, paste it with @ mentions or copy/paste.'));
      console.log(chalk.gray('  Tip: configure IDE to launch brainrouter with -w <workspace> so paths match.\n'));
      break;
    }

    case '/hookify': {
      const sub = args[0];
      if (!sub || sub === 'list') {
        const rules = listHookifyRules(agent.workspaceRoot);
        console.log(chalk.bold('\nHookify rules'));
        if (rules.length === 0) {
          console.log(chalk.yellow('  (none)'));
          console.log(chalk.gray('  Add with: /hookify create <name>|<event>|<pattern>|<action>|<message>'));
          console.log(chalk.gray('    event   = bash | file | prompt | stop | all'));
          console.log(chalk.gray('    action  = warn | block'));
          console.log(chalk.gray('  Rules live as markdown files in .brainrouter/hooks/.\n'));
        } else {
          for (const r of rules) {
            const tag = r.enabled ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${tag} ${chalk.cyan(r.id)} ${chalk.gray(r.event)} → ${chalk.yellow(r.action)}${r.pattern ? chalk.gray(` (pattern: ${r.pattern})`) : ''}`);
            console.log(chalk.gray(`    ${r.message.split('\n')[0].slice(0, 120)}`));
          }
          console.log();
        }
        break;
      }
      if (sub === 'create') {
        const raw = args.slice(1).join(' ').trim();
        const parts = raw.split('|').map((p) => p.trim());
        if (parts.length < 5) {
          console.log(chalk.red('\nUsage: /hookify create <name>|<event>|<pattern>|<action>|<message>\n'));
          break;
        }
        try {
          const created = createHookifyRule(agent.workspaceRoot, {
            name: parts[0],
            event: parts[1] as any,
            pattern: parts[2],
            action: (parts[3] as 'warn' | 'block'),
            message: parts.slice(4).join('|'),
          });
          console.log(chalk.green(`\n✓ Created hookify rule ${created.id} at ${path.relative(agent.workspaceRoot, created.sourcePath)}\n`));
        } catch (err: any) {
          console.log(chalk.red(`\nFailed: ${err.message}\n`));
        }
        break;
      }
      if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) { console.log(chalk.red(`\nUsage: /hookify ${sub} <id>\n`)); break; }
        const ok = toggleHookifyRule(agent.workspaceRoot, id, sub === 'enable');
        console.log(ok ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${id}\n`) : chalk.red(`\nNo rule ${id}\n`));
        break;
      }
      if (sub === 'remove') {
        const id = args[1];
        if (!id) { console.log(chalk.red(`\nUsage: /hookify remove <id>\n`)); break; }
        const ok = deleteHookifyRule(agent.workspaceRoot, id);
        console.log(ok ? chalk.green(`\n✓ Removed ${id}\n`) : chalk.red(`\nNo rule ${id}\n`));
        break;
      }
      console.log(chalk.red('\nUsage: /hookify [list | create <spec> | enable <id> | disable <id> | remove <id>]\n'));
      break;
    }

    case '/quit':
    case '/exit':
      rl.close();
      break;

    default:
      console.log(chalk.red(`\nUnknown slash command: ${command}. Type /help for assistance.\n`));
  }
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
function completeWorkspacePath(workspaceRoot: string, partial: string): string[] {
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
