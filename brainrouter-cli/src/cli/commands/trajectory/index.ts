// ADR-041 D14 (#2) — the CLI text projection of the trajectory ledger.
//
// The desktop grows the same ledger into a panel; here it is a plain,
// newest-first dump of the session's recorded steps: model, wall-clock duration,
// token usage, and the tools each step requested with their render intents. The
// ledger is opt-in (`cli.traceTrajectory`); when it is off and empty, the command
// says how to turn it on rather than printing nothing.
import chalk from 'chalk';
import type { TrajectoryStep, RenderIntent } from '@kinqs/brainrouter-core/session';
import { readTrajectory } from '@kinqs/brainrouter-core/session';
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
  const tokens = step.tokensIn !== undefined || step.tokensOut !== undefined
    ? ` · ${chalk.gray(`↑${step.tokensIn ?? 0} ↓${step.tokensOut ?? 0} tok`)}`
    : '';
  lines.push(
    `${chalk.dim('●')} ${chalk.bold(`step ${step.seq}`)} · ${chalk.white(step.model)}`
    + ` · ${formatDuration(step.durationMs)}${tokens}`,
  );
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

export async function tryHandleTrajectoryCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/trajectory' && ctx.command !== '/traj') return false;

  const parsed = Number.parseInt(ctx.args[0] ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 30;
  const steps = readTrajectory(ctx.agent.workspaceRoot, ctx.agent.sessionKey, limit);

  if (steps.length === 0) {
    if (ctx.config.cli?.traceTrajectory === true) {
      console.log(chalk.gray('No trajectory recorded yet — take a turn and it will fill in.'));
    } else {
      console.log(chalk.yellow('Trajectory tracing is off.'));
      console.log(chalk.gray('Enable it by setting cli.traceTrajectory = true in config.json, then take a turn.'));
    }
    return true;
  }

  console.log(chalk.bold(`Trajectory — ${steps.length} most recent step(s), newest first`));
  for (const step of steps) console.log(renderStep(step));
  return true;
}
