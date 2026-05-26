/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import chalk from 'chalk';
import { childSessionKey } from '../../runtime/mcpUtils.js';
import { listRoles } from '../../orchestration/roles.js';
import { listAll as listAgentDefs } from '../../orchestration/agentRegistry.js';
import { formatSessionSummary, getSession, listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { readPreferences, writePreferences } from '../../state/preferencesStore.js';
import { readTranscriptEntries } from '../../state/sessionStore.js';
import { getLoopState, stopLoop } from '../../runtime/loopRunner.js';
import type { CommandContext } from './_context.js';
import { formatTranscriptContent } from './_helpers.js';


export async function tryHandleOrchestrationCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/roles':
    {
      console.log(chalk.bold('\nAvailable Agent Roles:'));
      for (const r of listRoles()) {
        console.log(`  ${chalk.cyan(r.name)} (${chalk.gray(r.defaultAccess)}) - ${r.description}`);
      }
      console.log();
      return true;
    }
    case '/agents':
    {
      if (args[0] === 'defs') {
        const defs = listAgentDefs(agent.workspaceRoot);
        console.log(chalk.bold('\nAgent Definitions:'));
        const ID_W = Math.max(...defs.map((l) => l.def.id.length), 4) + 2;
        const TIER_W = 12;
        const SRC_W = 10;
        console.log(
          chalk.gray(
            `  ${'ID'.padEnd(ID_W)}${'TIER'.padEnd(TIER_W)}${'SOURCE'.padEnd(SRC_W)}PATH`,
          ),
        );
        for (const loaded of defs) {
          const idStr = chalk.cyan(loaded.def.id.padEnd(ID_W));
          const tierColor = loaded.def.tier === 'reasoning' ? chalk.blue : chalk.yellow;
          const tierStr = tierColor(loaded.def.tier.padEnd(TIER_W));
          const srcStr = chalk.gray(loaded.source.padEnd(SRC_W));
          console.log(`  ${idStr}${tierStr}${srcStr}${chalk.gray(loaded.filePath)}`);
        }
        console.log();
        return true;
      }
      // `--watch`: poll the same data shape every second and re-render the
      // running-children list inline. Same shape as `/agents` and the Ink
      // status row so the user gets a single mental model (roadmap §3).
      if (args.includes('--watch')) {
        const intervalMs = 1000;
        const maxTicks = 600; // ~10 min safety cap; Ctrl-C exits early.
        let ticks = 0;
        console.log(chalk.bold('\nWatching child agents (Ctrl-C to stop)…'));
        await new Promise<void>((resolve) => {
          const handle = setInterval(() => {
            reconcileStale(agent.workspaceRoot);
            const running = listSessions(agent.workspaceRoot)
              .filter((s) => s.status === 'pending' || s.status === 'running');
            const stamp = new Date().toISOString().slice(11, 19);
            if (running.length === 0) {
              process.stdout.write(`\r[${stamp}] no running children${' '.repeat(40)}`);
            } else {
              const parts = running.map((s) => `${s.id.slice(0, 14)} (${s.role})`).join(', ');
              process.stdout.write(`\r[${stamp}] running: ${parts}${' '.repeat(10)}`);
            }
            if (++ticks >= maxTicks) {
              clearInterval(handle);
              process.stdout.write('\n');
              resolve();
            }
          }, intervalMs);
          const onSig = () => { clearInterval(handle); process.stdout.write('\n'); process.off('SIGINT', onSig); resolve(); };
          process.once('SIGINT', onSig);
        });
        console.log();
        return true;
      }
      reconcileStale(agent.workspaceRoot);
      const sessions = listSessions(agent.workspaceRoot);
      // `--json` for scripting. Emits a single JSON line on stdout so
      // tmux-resurrect, status bars, agent pickers, and pipelines can
      // parse the live session list reliably.
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
        return true;
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
      return true;
    }
    case '/agent':
    {
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
      return true;
    }
    case '/spawn':
    {
      const role = args[0];
      const prompt = args.slice(1).join(' ').trim();
      if (!role || !prompt) {
        console.log(chalk.red('\nUsage: /spawn <role> <prompt>\n'));
        return true;
      }
      // Validate the role upfront — saves an LLM round-trip that would just
      // error out server-side anyway.
      const validRoles = listRoles().map((r) => r.name);
      if (!validRoles.includes(role)) {
        console.log(chalk.red(`\nUnknown role "${role}". Available: ${validRoles.join(', ')}.\n`));
        return true;
      }
      ctx.repl.runAgentTurn(
        `Use the spawn_agent tool to start a ${role} child agent with this prompt:\n\n${prompt}\n\nReturn the child agent id when done.`,
      );
      return true;
    }
    case '/wait':
    {
      const id = args[0];
      const ms = args[1] ? Number(args[1]) : 120000;
      if (!id) { console.log(chalk.red('\nUsage: /wait <id> [timeoutMs]\n')); break; }
      ctx.repl.runAgentTurn(
        `Use the wait_agent tool with id="${id}" and timeoutMs=${ms}. Then summarize the child output for me.`,
      );
      return true;
    }
    case '/auto-review':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args[0];
      if (!arg) {
        console.log(chalk.bold(`\nAuto-review: ${prefs.autoReview ? chalk.green('on') : chalk.gray('off')}`));
        console.log(chalk.gray('  When on, every worker child agent is auto-followed by a reviewer agent on its diff.'));
        console.log(chalk.gray('  Toggle with: /auto-review on | off\n'));
        return true;
      }
      const next = arg === 'on' || arg === 'true';
      writePreferences(agent.workspaceRoot, { autoReview: next });
      console.log(chalk.green(`\n✓ Auto-review ${next ? 'enabled' : 'disabled'}.\n`));
      return true;
    }
    case '/kill':
    {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /kill <agent-id>\n')); break; }
      const session = getSession(agent.workspaceRoot, id);
      if (!session) { console.log(chalk.red(`\nNo agent session with id "${id}".\n`)); break; }
      if (session.status !== 'pending' && session.status !== 'running') {
        console.log(chalk.gray(`\nAgent ${id} is already ${session.status}.\n`));
        return true;
      }
      ctx.repl.runAgentTurn(
        `Use the close_agent tool with id="${id}" and reason="user-requested kill". Then confirm the close result.`,
      );
      return true;
    }
    case '/ps':
    {
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
      return true;
    }
    case '/stop':
    {
      // Stop the loop AND mark any running children stale.
      const stopped = stopLoop();
      console.log(stopped ? chalk.green('\n✓ Stopped /loop.') : chalk.gray('\nNo loop was running.'));
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(chalk.yellow(`Marked ${reconciled} child session(s) stale.`));
      console.log();
      return true;
    }
  }
  return false;
}
