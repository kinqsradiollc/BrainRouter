/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { marked } from 'marked';
import { LOCAL_TOOLS } from '../../agent/agent.js';
import { callMcpTool, childSessionKey } from '../../runtime/mcpUtils.js';
import { listRoles } from '../../orchestration/roles.js';
import { createSession, formatSessionSummary, getSession, listSessions, reconcileStale, updateSession } from '../../orchestration/orchestrator.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, getWorkflowDir, listWorkflows, readArtifact, slugify, updateWorkflowStatus } from '../../state/workflowArtifacts.js';
import { readPreferences, writePreferences } from '../../state/preferencesStore.js';
import { addHook, readHooks, removeHook, runHooks, setHookEnabled, type HookEvent } from '../../state/hooksStore.js';
import { buildHookifyContext, createHookifyRule, deleteHookifyRule, evaluateHookify, listHookifyRules, toggleHookifyRule } from '../../state/hookifyStore.js';
import { clearGoal, completeGoal, goalHasBudgetLeft, GoalTooLongError, GOAL_TEXT_MAX_CHARS, pauseGoal, readGoal, resumeGoal, setGoal, setGoalBudget, tickGoalIteration } from '../../state/goalStore.js';
import { formatPlan, readPlan, updatePlan } from '../../state/taskStore.js';
import { appendTranscriptEntry, listTranscripts, loadTranscript, readTranscriptEntries } from '../../state/sessionStore.js';
import { getCliStateDir, getCliStateFile } from '../../state/cliState.js';
import { findWorkspaceRoot } from '../../config/workspace.js';
import { getConfigPath, saveConfig } from '../../config/config.js';
import { copyToClipboard } from '../../runtime/clipboard.js';
import { initAgentMd } from '../../prompt/initAgentMd.js';
import { expandMentions } from '../../memory/mentions.js';
import { getLoopState, isLoopRunning, parseInterval, startLoop, stopLoop } from '../../runtime/loopRunner.js';
import { resolveSandboxConfig } from '../../runtime/sandbox.js';
import { askYesNo } from '../cliPrompt.js';
import type { CommandContext } from './_context.js';
import { buildGoalKickoffPrompt, formatTranscriptContent, printMcpCall, printMemoryCards, runSkillByName, runSkillCommand } from './_helpers.js';


export async function tryHandleObsCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/transcript':
    {
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
      return true;
    }
    case '/watch':
    {
      const tracePath = process.env.BRAINROUTER_TRACE_LOG?.trim();
      if (!tracePath) {
        console.log(chalk.yellow('\nLive tracing is off. Enable with:'));
        console.log(chalk.gray('  export BRAINROUTER_TRACE_LOG=' + path.join(agent.workspaceRoot, '.brainrouter/cli/trace.jsonl')));
        console.log(chalk.gray('  (restart the CLI so the change takes effect)\n'));
        console.log(chalk.gray('Without it, you can still see per-tool activity inline in this REPL,'));
        console.log(chalk.gray('and child-agent tool calls now surface as "role:id → tool" lines.'));
        console.log(chalk.gray('Use /agents and /agent <id> --full for the persisted child transcripts.\n'));
        return true;
      }
      if (!fs.existsSync(tracePath)) {
        console.log(chalk.yellow(`\nTrace file does not exist yet: ${tracePath}\nIt will appear after the first turn.\n`));
        return true;
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
      return true;
    }
    case '/tokens':
    {
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
      return true;
    }
    case '/feedback':
    {
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
      return true;
    }
    case '/rollout':
    {
      const { getSessionStateDir } = await import('../../state/cliState.js');
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
      return true;
    }
    case '/debug-config':
    {
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
      return true;
    }
  }
  return false;
}
