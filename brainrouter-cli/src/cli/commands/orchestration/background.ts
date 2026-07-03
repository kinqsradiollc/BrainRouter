/**
 * Background-task slash commands — `/fg`, `/ps`, `/stop`. Foreground a
 * detached worker/child snapshot, list all background tasks (loop +
 * workflows + workers + children), and stop the loop or a specific task.
 * Extracted verbatim from the former orchestration/index.ts switch.
 */

import chalk from 'chalk';
import { collectRunningTasks, formatBackgroundTasks, summarizeTasks } from '@kinqs/brainrouter-core/background';
import { getSession, listSessions, reconcileStale, updateSession } from '@kinqs/brainrouter-core/orchestration';
import { resolveBackgroundTarget, describeStopOutcome } from '../../../runtime/background/bgDetach.js';
import { getLoopState, stopLoop } from '../../../runtime/background/loopRunner.js';
import { listWorkers, closeWorker } from '@kinqs/brainrouter-core/worker';
import type { CommandContext } from '../_context.js';
import { renderWorkerSnapshot } from './_shared.js';

export async function handleFg(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  // CLI-BG-DETACH — bring a background worker or child agent to the
  // foreground: a snapshot of its status + recent transcript. (Workers
  // run detached + persist to disk; child agents persist their session
  // record + final output. No live stream is held — re-run to refresh.)
  const id = (args[0] ?? '').trim();
  if (!id) {
    console.log(chalk.red('\nUsage: /fg <id> — show a background worker/child agent (see /ps for ids).\n'));
    return true;
  }
  const ws = agent.workspaceRoot;
  reconcileStale(ws);
  const target = resolveBackgroundTarget(
    id,
    listWorkers(ws).map((w) => ({ id: w.id, status: w.status, role: w.role })),
    listSessions(ws).map((s) => ({ id: s.id, status: s.status, role: s.role })),
  );
  if (target.kind === 'worker') {
    renderWorkerSnapshot(ws, id);
    return true;
  }
  if (target.kind === 'agent') {
    const s = getSession(ws, id);
    console.log(chalk.bold(`\nChild agent ${chalk.cyan(id)} ${chalk.gray(`(${s?.role ?? target.role ?? '?'})`)} — ${s?.status ?? target.status}`));
    if (s?.prompt) console.log(chalk.gray(`  task: ${s.prompt.slice(0, 200)}${s.prompt.length > 200 ? '…' : ''}`));
    if (s?.finalOutput) console.log(chalk.gray('\n  --- output ---\n') + s.finalOutput.slice(0, 1200));
    else if (s?.error) console.log(chalk.red(`\n  error: ${s.error}`));
    else console.log(chalk.gray('\n  (no output yet — still running; re-run /fg to refresh)'));
    console.log();
    return true;
  }
  console.log(chalk.red(`\nNo background worker or child agent with id "${id}". Try /ps.\n`));
  return true;
}

export async function handlePs(ctx: CommandContext): Promise<boolean> {
  const { agent } = ctx;
  // CLI-BG-DETACH — unified background view: loop + workflows + workers +
  // child agents (was loop + child agents only). Reuses the same
  // collector that backs the live bg-tasks panel.
  const ws = agent.workspaceRoot;
  const loopState = getLoopState();
  console.log(chalk.bold('\nBackground tasks'));
  if (loopState) {
    console.log(`  ${chalk.magenta('⟲')} Loop: ${chalk.cyan(loopState.prompt)} ${chalk.gray(`(${loopState.iterations} ticks, every ${loopState.intervalMs}ms)`)}`);
  }
  const tasks = collectRunningTasks(ws);
  if (tasks.length === 0) {
    console.log(chalk.gray(loopState ? '  No other running tasks.' : '  No running tasks.'));
  } else {
    console.log(chalk.gray(`  ${summarizeTasks(tasks)}`));
    for (const line of formatBackgroundTasks(tasks, { max: 20 })) console.log(`  ${line}`);
    console.log(chalk.gray('\n  /fg <id> to view · /stop <id> to stop'));
  }
  console.log();
  return true;
}

export async function handleStop(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  const ws = agent.workspaceRoot;
  const id = (args[0] ?? '').trim();
  // `/stop <id>` stops one worker/child; `/stop` (no id) stops the loop +
  // reconciles orphaned children (original behavior).
  if (id) {
    reconcileStale(ws);
    const target = resolveBackgroundTarget(
      id,
      listWorkers(ws).map((w) => ({ id: w.id, status: w.status, role: w.role })),
      listSessions(ws).map((s) => ({ id: s.id, status: s.status, role: s.role })),
    );
    if (target.kind === 'worker') closeWorker(ws, id);
    else if (target.kind === 'agent' && target.active) updateSession(ws, id, { status: 'closed' });
    const outcome = describeStopOutcome(target);
    console.log((outcome.ok ? chalk.green('\n✓ ') : chalk.red('\n')) + outcome.message + '\n');
    return true;
  }
  const stopped = stopLoop();
  console.log(stopped ? chalk.green('\n✓ Stopped /loop.') : chalk.gray('\nNo loop was running.'));
  const reconciled = reconcileStale(ws);
  if (reconciled > 0) console.log(chalk.yellow(`Marked ${reconciled} child session(s) stale.`));
  console.log(chalk.gray('  Tip: /stop <id> to stop a specific worker/child (see /ps).'));
  console.log();
  return true;
}
