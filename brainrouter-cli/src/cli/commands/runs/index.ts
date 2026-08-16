/**
 * ADR-040 A40-9 — `/runs`, the terminal view of the execution map, plus
 * `/runs start` (preview + confirm an explicit strategy before it runs) and
 * `/runs <id> --watch` (follow a run live).
 *
 * The formatting decisions do NOT live here. `runsView` in Core owns what a run
 * (and a plan preview) looks like, and both this and Desktop Runs render the same
 * projection; two hosts each deciding independently is how they end up
 * disagreeing about whether something failed, leaving the person to work out who
 * to believe.
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
  isTerminalRunStatus,
  previewTurnStrategy,
  planPreviewLines,
  type RunDetailView,
} from '@kinqs/brainrouter-core/orchestration/runs';
import type { CommandContext } from '../_context.js';

function printUsage(): void {
  console.log(chalk.bold('\n/runs — what actually ran\n'));
  console.log('  /runs                        recent runs, newest first');
  console.log('  /runs <runId>                one run in detail');
  console.log('  /runs <runId> --watch        follow a run live until it finishes');
  console.log('  /runs --goal=<goalId>        only runs launched under one goal');
  console.log('  /runs --json                 machine-readable listing');
  console.log('  /runs <runId> --json         machine-readable detail');
  console.log('  /runs start [--strategy=<id>] <task>');
  console.log('                               preview a strategy, confirm, then run it');
  console.log('');
}

function statusColor(status: string): string {
  if (status === 'succeeded') return chalk.green(status);
  if (status === 'failed' || status === 'blocked') return chalk.red(status);
  if (status === 'interrupted' || status === 'cancelled' || status === 'degraded') return chalk.yellow(status);
  return chalk.dim(status);
}

/** Render one run's detail. Reused by the one-shot view and the `--watch` loop. */
function renderDetail(view: RunDetailView): void {
  console.log(`\n  ${chalk.bold(view.runId)}  ${statusColor(view.status)}`);
  if (view.goalId) console.log(chalk.dim(`  goal ${view.goalId}`));
  if (view.caveat) console.log(chalk.yellow(`  ${view.caveat}`));
  if (view.nodes.length) {
    console.log('');
    for (const node of view.nodes) {
      const path = node.iterationPath.length ? chalk.dim(`@${node.iterationPath.join('.')}`) : '';
      console.log(`    ${node.nodeId}${path}  ${statusColor(node.status)}  ${chalk.dim(`attempt ${node.attempt}`)}`);
      // A40-9 — drill-down: the child sessions this stage spawned, so a run can be
      // traced into the transcripts it produced.
      for (const child of node.childSessionIds) {
        console.log(chalk.dim(`        ↳ child ${child}`));
      }
    }
  }
  console.log('');
}

/** A stable fingerprint of what the detail view shows, so `--watch` only re-renders on change. */
function detailFingerprint(view: RunDetailView): string {
  return `${view.status}|${view.completeness}|${view.nodes
    .map((n) => `${n.nodeId}:${n.attempt}:${n.status}:${n.childSessionIds.length}`)
    .join(',')}`;
}

// A40-9 — explicit strategy launch: preview the validated plan, then confirm.
async function handleStart(ctx: CommandContext, rest: string[]): Promise<void> {
  const strategyId = rest.find((a) => a.startsWith('--strategy='))?.slice('--strategy='.length) || undefined;
  const task = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!task) {
    console.log(chalk.red('\n  Usage: /runs start [--strategy=<id>] <task>\n'));
    console.log(chalk.gray('  Previews the strategy that would run for this task, then asks to confirm before starting.\n'));
    return;
  }

  let preview;
  try {
    preview = previewTurnStrategy({ workspaceRoot: ctx.agent.workspaceRoot, task, ...(strategyId ? { strategyId } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`\n  Could not resolve a strategy to preview: ${message}\n`));
    return;
  }

  console.log(chalk.bold('\n  Strategy preview\n'));
  for (const line of planPreviewLines(preview)) console.log(`  ${line}`);
  if (preview.createsChildren) {
    console.log(chalk.yellow('\n  This strategy will spawn child agents.'));
  }
  console.log('');

  const answer = await new Promise<string>((resolve) =>
    ctx.rl.question(chalk.cyan(`  Start this run? (y/N) `), resolve));
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(chalk.dim('\n  Cancelled — nothing started.\n'));
    return;
  }

  // The confirmed, explicit command is the trusted action. The turn carries the
  // chosen strategy as its topology (selectionSource `explicit`); it is not a
  // model-authored launch.
  ctx.repl.runAgentTurn(task, strategyId ? { explicitStrategyId: strategyId } : {});
}

// A40-9 — live updates: follow a run until it reaches a terminal status.
async function handleWatch(ctx: CommandContext, runId: string): Promise<void> {
  const workspaceRoot = ctx.agent.workspaceRoot;
  let last = '';
  let ticks = 0;
  const MAX_TICKS = 600; // ~10 min at 1s — a safety cap, not a deadline.

  const renderIfChanged = (): boolean => {
    const record = readDurableRunSafe(workspaceRoot, runId);
    if (!record) return true;
    const view = readRunDetail(workspaceRoot, runId) ?? toRunDetailView(record, undefined);
    const fp = detailFingerprint(view);
    if (fp !== last) { last = fp; renderDetail(view); }
    return isTerminalRunStatus(view.status);
  };

  if (renderIfChanged()) return; // already finished — one render, done.
  console.log(chalk.dim('  (watching — Ctrl-C to stop)\n'));

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(timer); process.off('SIGINT', onSigint); resolve(); };
    const onSigint = () => { console.log(chalk.dim('\n  stopped watching.\n')); finish(); };
    process.once('SIGINT', onSigint);
    const timer = setInterval(() => {
      ticks += 1;
      let terminal = false;
      try { terminal = renderIfChanged(); } catch { /* transient read; keep polling */ }
      if (terminal || ticks >= MAX_TICKS) {
        if (ticks >= MAX_TICKS && !terminal) console.log(chalk.dim('  (stopped watching after the time cap; run still in flight)\n'));
        finish();
      }
    }, 1000);
  });
}

export async function tryHandleRunsCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args } = ctx;
  if (command !== '/runs') return false;

  const wantsJson = args.includes('--json');
  const wantsWatch = args.includes('--watch');
  // A40-5 goal grouping — restrict the listing to one goal's runs.
  const goalId = args.find((a) => a.startsWith('--goal='))?.slice('--goal='.length) || undefined;
  const positional = args.filter((a) => !a.startsWith('--'));
  const workspaceRoot = ctx.agent.workspaceRoot;

  if (positional[0] === 'help') { printUsage(); return true; }
  if (positional[0] === 'start') { await handleStart(ctx, args.slice(1)); return true; }

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

  if (wantsWatch && !wantsJson) { await handleWatch(ctx, runId); return true; }

  // A40-9 — retained replay: rebuild the map from the run's retained event
  // journal. A run with no journal reduces to an absent snapshot, and the view
  // still says so honestly rather than drawing an empty map as though the run did
  // nothing. (`?? toRunDetailView(record, undefined)` is a never-hit safety net —
  // the record was just found, so `readRunDetail` returns a view.)
  const view = readRunDetail(workspaceRoot, runId) ?? toRunDetailView(record, undefined);
  if (wantsJson) { console.log(runDetailJson(view)); return true; }
  renderDetail(view);
  return true;
}
