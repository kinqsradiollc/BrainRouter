/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import { marked } from 'marked';
import { listTranscripts, loadTranscript } from '../../state/sessionStore.js';
import { buildRewindTimeline, truncateAtTurn } from '../../runtime/rewindTimeline.js';
import { planRestore, readFileMutations } from '../../state/fileSnapshotStore.js';
import { readGoal, resumeGoal } from '../../state/goalStore.js';
import { askYesNo } from '../cliPrompt.js';
import { buildGoalKickoffPrompt } from './_helpers.js';
import type { CommandContext } from './_context.js';


export async function tryHandleSessionCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/sessions':
    {
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
      return true;
    }
    case '/resume':
    {
      const sessionKey = args.join(' ').trim();
      if (!sessionKey) {
        console.log(chalk.red('\nUsage: /resume <sessionKey>\n'));
        console.log(chalk.gray('Tip: copy a sessionKey from /sessions.\n'));
        return true;
      }
      const entries = loadTranscript(agent.workspaceRoot, sessionKey);
      if (entries.length === 0) {
        console.log(chalk.red(`\nNo transcript found for "${sessionKey}".\n`));
        return true;
      }
      agent.sessionKey = sessionKey;
      // The persisted transcript doesn't record per-call token usage, so
      // we can't reconstruct counters for the resumed session — start
      // counting from this point forward instead of carrying over the
      // pre-resume parent counts (which were for a different session).
      agent.resetSessionCounters();
      const loaded = agent.loadHistory(entries);
      console.log(chalk.green(`\n✓ Resumed session ${chalk.cyan(sessionKey)} with ${loaded} prior messages.`));

      // If the resumed session has a goal that was suspended (paused,
      // blocked, or hit usage limit), prompt the user whether to resume it
      // now. Without this prompt the loop silently stays paused and the
      // user has to remember to `/goal resume` — easy to miss.
      const resumedGoal = readGoal(agent.workspaceRoot, sessionKey);
      if (
        resumedGoal &&
        (resumedGoal.status === 'paused' ||
          resumedGoal.status === 'blocked' ||
          resumedGoal.status === 'usage_limited')
      ) {
        const label = resumedGoal.status.replace('_', ' ');
        console.log(chalk.yellow(`\n⏸  This session has a ${label} goal:`));
        console.log(`     ${chalk.cyan(resumedGoal.text)}`);
        console.log(`     ${chalk.gray(`${resumedGoal.budget.iterationsUsed}/${resumedGoal.budget.maxIterations} iterations used`)}${resumedGoal.blockedReason ? chalk.gray(` · ${resumedGoal.blockedReason}`) : ''}`);
        const resume = await askYesNo('Resume the goal and continue auto-iteration? (y/N) ', false);
        if (resume) {
          // If the goal hit a budget cap, the user probably also wants to
          // raise it — but don't force the question; they can /goal budget
          // before/after. Just unpause and kick off the next iteration.
          const reactivated = resumeGoal(agent.workspaceRoot, sessionKey);
          if (reactivated) {
            // 9d: pre-9d this branch had to drop a `goal-budget-steering`
            // tagged system message left over from a budget-trigger pause.
            // That message no longer exists — the wrap-up directive is
            // folded into the goal-anchor and the anchor is re-rendered
            // by the next runTurn. `refreshSystemPrompt` is still useful
            // here to rebuild any overlays that depend on the active goal.
            agent.refreshSystemPrompt();
            console.log(chalk.green(`\n▶  Goal resumed (${reactivated.budget.iterationsUsed}/${reactivated.budget.maxIterations} used). Starting next iteration…\n`));
            ctx.repl.runAgentTurn(buildGoalKickoffPrompt(reactivated, 'resume'));
            return true; // runAgentTurn owns its prompt cycle
          }
        } else {
          console.log(chalk.gray(`\nGoal stays ${label}. Run /goal resume later to continue.\n`));
        }
      } else {
        console.log(chalk.gray('Your next message will continue the conversation.\n'));
      }
      return true;
    }
    case '/fork':
    {
      const label = args.join(' ').trim() || `fork-${new Date().toISOString().slice(11, 19)}`;
      const newKey = `${agent.sessionKey}:fork:${randomUUID().slice(0, 8)}:${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
      const previous = agent.sessionKey;
      agent.fork(newKey);
      console.log(chalk.green(`\n✓ Forked session.`));
      console.log(chalk.gray(`  Parent : ${previous}`));
      console.log(chalk.gray(`  New    : ${newKey}`));
      console.log(chalk.gray('  Your next message starts a new transcript while keeping prior context.\n'));
      return true;
    }
    case '/rewind':
    {
      // 0.4.x-3 — interactive timeline. `/rewind` lists the last 20 turns;
      // `/rewind <n>` forks a new session truncated to keep turns 1..n and
      // drop everything after, so you can branch from an earlier point.
      const entries = loadTranscript(agent.workspaceRoot, agent.sessionKey);
      const timeline = buildRewindTimeline(entries, 20);
      if (timeline.length === 0) {
        console.log(chalk.yellow('\nNothing to rewind — no user turns recorded in this session yet.\n'));
        return true;
      }
      const restoreFiles = args.includes('--files');
      const arg = (args.find((a) => !a.startsWith('--')) ?? '').trim();
      if (!arg) {
        console.log(chalk.bold(`\n⏪ Rewind — last ${timeline.length} turn${timeline.length === 1 ? '' : 's'} (newest last):`));
        for (const t of timeline) {
          console.log(`  ${chalk.cyan(String(t.turnNumber).padStart(2))}  ${chalk.gray(t.timestamp.slice(11, 19))}  ${t.preview}`);
        }
        console.log(chalk.gray('\n  /rewind <n>          forks a new session truncated to that turn (conversation only).'));
        console.log(chalk.gray('  /rewind <n> --files  also restores workspace files to their turn-<n> state (preview + confirm).\n'));
        return true;
      }
      const n = Number(arg);
      const chosen = timeline.find((t) => t.turnNumber === n);
      if (!Number.isInteger(n) || !chosen) {
        console.log(chalk.red(`\nNo turn "${arg}". Run /rewind to list the available turns.\n`));
        return true;
      }

      // 0.4.x-3b — optional file-restore: revert files mutated after turn n to
      // their end-of-turn-n state. Previewed + confirmed; never automatic.
      if (restoreFiles) {
        const actions = planRestore(readFileMutations(agent.workspaceRoot, agent.sessionKey), chosen.absoluteTurn);
        if (actions.length === 0) {
          console.log(chalk.gray(`\n(No file changes recorded after turn ${n} — nothing to restore. Rewinding conversation only.)`));
        } else {
          console.log(chalk.bold(`\n⚠️  File restore — ${actions.length} file${actions.length === 1 ? '' : 's'} will change to their turn-${n} state:`));
          for (const a of actions) {
            console.log(a.action === 'delete'
              ? `  ${chalk.red('delete')}  ${a.path}  ${chalk.gray('(was created after this turn)')}`
              : `  ${chalk.yellow('revert')}  ${a.path}`);
          }
          const ok = await askYesNo(chalk.bold('\nApply these file changes? This overwrites current content. (y/N) '), false);
          if (!ok) {
            console.log(chalk.gray('\nFile restore cancelled. (Conversation not rewound either — re-run without --files to fork conversation only.)\n'));
            return true;
          }
          let restored = 0;
          for (const a of actions) {
            try {
              const abs = path.resolve(agent.workspaceRoot, a.path);
              if (a.action === 'delete') { if (fs.existsSync(abs)) fs.rmSync(abs); }
              else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, a.content ?? '', 'utf8'); }
              restored++;
            } catch (err: any) {
              console.log(chalk.red(`  ✗ ${a.path}: ${err?.message ?? err}`));
            }
          }
          console.log(chalk.green(`✓ Restored ${restored}/${actions.length} file${actions.length === 1 ? '' : 's'} to their turn-${n} state.`));
        }
      }

      const kept = truncateAtTurn(entries, chosen.endIndex);
      const previous = agent.sessionKey;
      const newKey = `${agent.sessionKey.split(':')[0]}:rewind:${randomUUID().slice(0, 8)}`;
      agent.fork(newKey);
      const loaded = agent.loadHistory(kept);
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Rewound to turn ${n} in a new session.`));
      console.log(chalk.gray(`  Parent : ${previous}`));
      console.log(chalk.gray(`  New    : ${newKey}`));
      console.log(chalk.gray(`  Kept ${loaded} message${loaded === 1 ? '' : 's'} (turn ${n} preserved; everything after dropped). Your next message continues from here.\n`));
      return true;
    }
    case '/rename':
    {
      const newName = args.join(' ').trim();
      if (!newName) {
        console.log(chalk.red('\nUsage: /rename <new session label>\n'));
        return true;
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
      return true;
    }
    case '/compact':
    {
      const spinner = makeSpinner(chalk.gray('Summarizing conversation for compaction...')).start();
      try {
        const result = await agent.compactHistory();
        if (!result) {
          spinner.warn(chalk.yellow('Nothing to compact — chat history is already short.'));
          return true;
        }
        spinner.succeed(chalk.green(`Compacted ${result.replacedMessages} messages → ~${result.estimatedTokens} tokens (${result.durationMs}ms).`));
        console.log(chalk.bold('\nCompaction summary:'));
        console.log(marked.parse(result.summary));
        console.log(chalk.gray('The summary is now part of system context. Continue normally.\n'));
      } catch (err: any) {
        spinner.fail(chalk.red(`Compaction failed: ${err.message}`));
        console.log(chalk.gray('Fallback: nothing was changed. Use /clear if you want to drop history without summarizing.\n'));
      }
      return true;
    }
    case '/new':
    {
      const label = args.join(' ').trim() || `new-${new Date().toISOString().slice(11, 19)}`;
      const newKey = `${agent.sessionKey.split(':')[0]}:${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
      const previous = agent.sessionKey;
      agent.sessionKey = newKey;
      agent.clearHistory();
      console.log(chalk.green(`\n✓ Started a new chat.`));
      console.log(chalk.gray(`  Old: ${previous}`));
      console.log(chalk.gray(`  New: ${newKey}\n`));
      return true;
    }
    case '/side':
    case '/btw':
    {
      const prompt = args.join(' ').trim();
      if (!prompt) {
        console.log(chalk.red(`\nUsage: ${command} <ephemeral side question>\n`));
        console.log(chalk.gray('  Side conversations run in a forked chat history and discard the result on exit.\n'));
        return true;
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
      void ctx.repl.runAgentTurnAsync(prompt).finally(() => {
        agent.sessionKey = original;
      });
      return true;
    }
    case '/clear': {
      agent.clearHistory();
      console.log(chalk.yellow('\nConversation history cleared.\n'));
      return true;
    }
    case '/quit':
    case '/exit': {
      rl.close();
      return true;
    }
  }
  return false;
}
