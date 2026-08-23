// ADR-041 D14 (#2) — the CLI text projection of the trajectory ledger.
//
// The desktop grows the same ledger into a panel; here it is a plain,
// newest-first dump of the session's recorded steps: model, wall-clock duration,
// token usage, and the tools each step requested with their render intents. The
// ledger is opt-in (`cli.traceTrajectory`); when it is off and empty, the command
// says how to turn it on rather than printing nothing.
import chalk from 'chalk';
import type { TrajectoryStep, TrajectoryEvent, RenderIntent } from '@kinqs/brainrouter-core/session';
import { readTrajectory, deriveShadowedTrajectory } from '@kinqs/brainrouter-core/session';
import type { CommandContext } from '../_context.js';

const INTENT_COLOR: Record<RenderIntent, (s: string) => string> = {
  terminal: chalk.magenta,
  diff: chalk.green,
  read: chalk.cyan,
  search: chalk.yellow,
  web: chalk.blue,
  text: chalk.gray,
};

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderStep(step: TrajectoryStep): string {
  const lines: string[] = [];
  const shadowed = step.visibility === 'shadowed';
  const tokens = step.tokensIn !== undefined || step.tokensOut !== undefined
    ? ` · ${chalk.gray(`↑${step.tokensIn ?? 0} ↓${step.tokensOut ?? 0} tok`)}`
    : '';
  const head = `${chalk.dim('●')} ${chalk.bold(`step ${step.seq}`)} · ${chalk.white(step.model)}`
    + ` · ${formatDuration(step.durationMs)}${tokens}${shadowed ? chalk.dim(' · shadowed') : ''}`;
  lines.push(shadowed ? chalk.dim(head) : head);
  if (step.tools.length > 0) {
    const chips = step.tools
      .map((t) => `${t.name}${INTENT_COLOR[t.intent](`[${t.intent}]`)}`)
      .join('  ');
    lines.push(`  ${chalk.dim('tools:')} ${chips}`);
  }
  if (step.excerpt) {
    const oneLine = step.excerpt.replace(/\s+/g, ' ').trim();
    const clipped = oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
    lines.push(`  ${chalk.dim(`"${clipped}"`)}`);
  }
  return lines.join('\n');
}

function renderEvent(ev: TrajectoryEvent): string {
  const icon = ev.event === 'compaction' ? '⋯' : '⚑';
  const counts = ev.event === 'compaction' && (ev.droppedMessages !== undefined || ev.keptMessages !== undefined)
    ? ` (dropped ${ev.droppedMessages ?? 0}, kept ${ev.keptMessages ?? 0})`
    : '';
  return chalk.dim(`${icon} log-only · ${ev.label}${counts}`);
}

export async function tryHandleTrajectoryCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/trajectory' && ctx.command !== '/traj') return false;

  const parsed = Number.parseInt(ctx.args[0] ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 30;
  const records = deriveShadowedTrajectory(
    readTrajectory(ctx.agent.workspaceRoot, ctx.agent.sessionKey, limit),
  );

  if (records.length === 0) {
    if (ctx.config.cli?.traceTrajectory === true) {
      console.log(chalk.gray('No trajectory recorded yet — take a turn and it will fill in.'));
    } else {
      console.log(chalk.yellow('Trajectory tracing is off.'));
      console.log(chalk.gray('Enable it by setting cli.traceTrajectory = true in config.json, then take a turn.'));
    }
    return true;
  }

  const stepCount = records.filter((r) => r.kind === 'step').length;
  console.log(chalk.bold(`Trajectory — ${stepCount} step(s) + log-only events, newest first`));
  for (const r of records) console.log(r.kind === 'event' ? renderEvent(r) : renderStep(r));
  return true;
}
