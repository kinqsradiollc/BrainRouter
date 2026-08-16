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
  readRunDetail,
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
  const positional = args.filter((a) => !a.startsWith('--'));
  const workspaceRoot = ctx.agent.workspaceRoot;

  if (positional[0] === 'help') { printUsage(); return true; }

  // A40-6: bring the store up to date before showing it — migrate legacy
  // ledgers from before durable runs existed, and reconcile runs a crash left
  // "running". Best-effort and once-per-process; a maintenance failure must not
  // stop the user seeing their runs.
  try { openDurableRuns(workspaceRoot); } catch { /* listing still works */ }

  if (!positional.length) {
    const rows = toRunsListRows(listDurableRuns(workspaceRoot, { limit: 20 }).runs);
    if (wantsJson) { console.log(runsJson(rows)); return true; }
    if (!rows.length) {
      console.log(chalk.dim('\n  No runs recorded for this workspace yet.\n'));
      return true;
    }
    console.log('');
    for (const row of rows) {
      const when = row.startedAt.replace('T', ' ').slice(0, 19);
      console.log(
        `  ${chalk.bold(row.runId.padEnd(24))} ${statusColor(row.status).padEnd(20)} ` +
        `${chalk.dim(when)}  ${chalk.dim(row.definitionId ?? '—')}`,
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

  // A40-9 — retained replay: rebuild the map from the run's retained event
  // journal. A run with no journal reduces to an absent snapshot, and the view
  // still says so honestly rather than drawing an empty map as though the run did
  // nothing. (`?? toRunDetailView(record, undefined)` is a never-hit safety net —
  // the record was just found, so `readRunDetail` returns a view.)
  const view = readRunDetail(workspaceRoot, runId) ?? toRunDetailView(record, undefined);
  if (wantsJson) { console.log(runDetailJson(view)); return true; }

  console.log(`\n  ${chalk.bold(view.runId)}  ${statusColor(view.status)}`);
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
