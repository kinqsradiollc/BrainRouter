/**
 * ADR-040 A40-9 — `/runs`, the terminal view of the execution map.
 *
 * The formatting decisions do NOT live here. `runsView` in Core owns what a run
 * looks like, and both this and Desktop Runs render the same projection; two
 * hosts each deciding independently is how they end up disagreeing about
 * whether something failed, leaving the person to work out who to believe.
 */
import chalk from 'chalk';
import {
  listDurableRuns,
  readDurableRunSafe,
  toRunsListRows,
  toRunDetailView,
  runsJson,
  runDetailJson,
  openDurableRuns,
} from '@kinqs/brainrouter-core/orchestration/runs';
import type { CommandContext } from '../_context.js';

function printUsage(): void {
  console.log(chalk.bold('\n/runs — what actually ran\n'));
  console.log('  /runs                    recent runs, newest first');
  console.log('  /runs <runId>            one run in detail');
  console.log('  /runs --goal=<goalId>    only runs launched under one goal');
  console.log('  /runs --json             machine-readable listing');
  console.log('  /runs <runId> --json     machine-readable detail');
  console.log('');
}

function statusColor(status: string): string {
  if (status === 'succeeded') return chalk.green(status);
  if (status === 'failed' || status === 'blocked') return chalk.red(status);
  if (status === 'interrupted' || status === 'cancelled') return chalk.yellow(status);
  return chalk.dim(status);
}

export async function tryHandleRunsCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args } = ctx;
  if (command !== '/runs') return false;

  const wantsJson = args.includes('--json');
  // A40-5 goal grouping — restrict the listing to one goal's runs.
  const goalId = args.find((a) => a.startsWith('--goal='))?.slice('--goal='.length) || undefined;
  const positional = args.filter((a) => !a.startsWith('--'));
  const workspaceRoot = ctx.agent.workspaceRoot;

  if (positional[0] === 'help') { printUsage(); return true; }

  // A40-6: bring the store up to date before showing it — migrate legacy
  // ledgers from before durable runs existed, and reconcile runs a crash left
  // "running". Best-effort and once-per-process; a maintenance failure must not
  // stop the user seeing their runs.
  try { openDurableRuns(workspaceRoot); } catch { /* listing still works */ }

  if (!positional.length) {
    const rows = toRunsListRows(listDurableRuns(workspaceRoot, { limit: 20, goalId }).runs);
    if (wantsJson) { console.log(runsJson(rows)); return true; }
    if (!rows.length) {
      console.log(chalk.dim(goalId
        ? `\n  No runs recorded under goal ${goalId}.\n`
        : '\n  No runs recorded for this workspace yet.\n'));
      return true;
    }
    console.log('');
    for (const row of rows) {
      const when = row.startedAt.replace('T', ' ').slice(0, 19);
      console.log(
        `  ${chalk.bold(row.runId.padEnd(24))} ${statusColor(row.status).padEnd(20)} ` +
        `${chalk.dim(when)}  ${chalk.dim(row.definitionId ?? '—')}` +
        (row.goalId ? `  ${chalk.dim(`goal ${row.goalId}`)}` : ''),
      );
    }
    console.log(chalk.dim('\n  /runs <runId> for the execution map.\n'));
    return true;
  }

  const runId = positional[0]!;
  const record = readDurableRunSafe(workspaceRoot, runId);
  if (!record) {
    console.log(chalk.red(`\n  No run named ${runId} in this workspace.\n`));
    return true;
  }

  // Retained runs keep their summary, not their event stream — so detail is
  // built with an absent snapshot and the view says what it cannot show,
  // rather than drawing an empty map as though the run did nothing.
  const view = toRunDetailView(record, undefined);
  if (wantsJson) { console.log(runDetailJson(view)); return true; }

  console.log(`\n  ${chalk.bold(view.runId)}  ${statusColor(view.status)}`);
  if (view.goalId) console.log(chalk.dim(`  goal ${view.goalId}`));
  if (view.caveat) console.log(chalk.yellow(`  ${view.caveat}`));
  if (view.nodes.length) {
    console.log('');
    for (const node of view.nodes) {
      const path = node.iterationPath.length ? chalk.dim(`@${node.iterationPath.join('.')}`) : '';
      console.log(`    ${node.nodeId}${path}  ${statusColor(node.status)}  ${chalk.dim(`attempt ${node.attempt}`)}`);
    }
  }
  console.log('');
  return true;
}
