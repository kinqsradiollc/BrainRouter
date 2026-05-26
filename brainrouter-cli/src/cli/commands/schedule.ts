/**
 * `/schedule` slash command — recurring cron + one-shot dispatch.
 *
 * Recurring  : /schedule cron "*\/15 * * * *" /ci-status
 * One-shot   : /schedule in 30s /agents
 *              /schedule at 14:30 /agents
 * Management : /schedule list
 *              /schedule remove  <id>
 *              /schedule disable <id>
 *              /schedule enable  <id>
 *
 * The dispatched command runs in the SAME session that registered the
 * schedule (we use `agent.sessionKey` as the owner). The ticker filters
 * by owner — if a different REPL is open against the same workspace,
 * it won't fire someone else's jobs.
 */

import chalk from 'chalk';
import { parseInterval } from '../../runtime/loopRunner.js';
import { parseCron, nextCronFire } from '../../runtime/cronParser.js';
import {
  addSchedule,
  loadSchedules,
  removeSchedule,
  setScheduleEnabled,
  type ScheduleRecord,
} from '../../state/scheduleStore.js';
import type { CommandContext } from './_context.js';

export async function tryHandleScheduleCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/schedule') return false;
  const { args, agent } = ctx;
  const sub = (args[0] ?? '').toLowerCase();

  if (!sub || sub === 'list') {
    renderList(agent.workspaceRoot, agent.sessionKey);
    return true;
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = args[1];
    if (!id) {
      console.log(chalk.red('\nUsage: /schedule remove <id>\n'));
      return true;
    }
    const ok = removeSchedule(agent.workspaceRoot, id);
    console.log(ok
      ? chalk.green(`\n✓ Removed ${id}.\n`)
      : chalk.yellow(`\nNo schedule with id ${id}.\n`));
    return true;
  }

  if (sub === 'disable' || sub === 'enable') {
    const id = args[1];
    if (!id) {
      console.log(chalk.red(`\nUsage: /schedule ${sub} <id>\n`));
      return true;
    }
    const ok = setScheduleEnabled(agent.workspaceRoot, id, sub === 'enable');
    console.log(ok
      ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${id}.\n`)
      : chalk.yellow(`\nNo schedule with id ${id}.\n`));
    return true;
  }

  if (sub === 'cron') {
    // Need to re-join because the splitter cracked the quoted cron expr
    // across tokens. Re-join args after the leading "cron".
    const rest = args.slice(1).join(' ').trim();
    const m = /^"([^"]+)"\s+(\/\S.*)$/.exec(rest);
    if (!m) {
      console.log(chalk.red('\nUsage: /schedule cron "<expr>" /command'));
      console.log(chalk.gray('  e.g. /schedule cron "*/15 * * * *" /ci-status\n'));
      return true;
    }
    const expr = m[1];
    const command = m[2].trim();
    if (!command.startsWith('/')) {
      console.log(chalk.red('\nSchedule only dispatches slash commands (must start with `/`).\n'));
      return true;
    }
    const cron = parseCron(expr);
    if (!cron) {
      console.log(chalk.red(`\nInvalid cron expression: "${expr}"`));
      console.log(chalk.gray('  Expected 5 fields: minute hour dom month dow\n'));
      return true;
    }
    const nextRun = nextCronFire(cron, new Date());
    const rec = addSchedule(agent.workspaceRoot, {
      kind: 'cron',
      expr,
      command,
      owner: agent.sessionKey,
      nextRun: nextRun.toISOString(),
    });
    console.log(chalk.green(`\n✓ Registered ${rec.id}: cron "${expr}" → ${command}`));
    console.log(chalk.gray(`  Next fire: ${formatWhen(nextRun)}\n`));
    return true;
  }

  if (sub === 'in') {
    const ms = parseInterval(args[1] ?? '');
    const command = args.slice(2).join(' ').trim();
    if (!ms || !command) {
      console.log(chalk.red('\nUsage: /schedule in <duration> /command'));
      console.log(chalk.gray('  e.g. /schedule in 5m /ci-status\n'));
      return true;
    }
    if (!command.startsWith('/')) {
      console.log(chalk.red('\nSchedule only dispatches slash commands.\n'));
      return true;
    }
    const nextRun = new Date(Date.now() + ms);
    const rec = addSchedule(agent.workspaceRoot, {
      kind: 'once',
      expr: nextRun.toISOString(),
      command,
      owner: agent.sessionKey,
      nextRun: nextRun.toISOString(),
    });
    console.log(chalk.green(`\n✓ Registered ${rec.id}: one-shot in ${args[1]} → ${command}`));
    console.log(chalk.gray(`  Fires at: ${formatWhen(nextRun)}\n`));
    return true;
  }

  if (sub === 'at') {
    const time = args[1] ?? '';
    const command = args.slice(2).join(' ').trim();
    const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!tm || !command) {
      console.log(chalk.red('\nUsage: /schedule at HH:MM /command'));
      console.log(chalk.gray('  e.g. /schedule at 14:30 /agents\n'));
      return true;
    }
    if (!command.startsWith('/')) {
      console.log(chalk.red('\nSchedule only dispatches slash commands.\n'));
      return true;
    }
    const h = Number(tm[1]);
    const min = Number(tm[2]);
    if (h > 23 || min > 59) {
      console.log(chalk.red('\nInvalid time. Hours 0-23, minutes 0-59.\n'));
      return true;
    }
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    const rec = addSchedule(agent.workspaceRoot, {
      kind: 'once',
      expr: target.toISOString(),
      command,
      owner: agent.sessionKey,
      nextRun: target.toISOString(),
    });
    console.log(chalk.green(`\n✓ Registered ${rec.id}: one-shot at ${time} → ${command}`));
    console.log(chalk.gray(`  Fires at: ${formatWhen(target)}\n`));
    return true;
  }

  console.log(chalk.red(`\nUnknown subcommand: /schedule ${sub}`));
  console.log(chalk.gray('  Try: list | cron "<expr>" /cmd | in <dur> /cmd | at HH:MM /cmd | remove <id> | disable <id> | enable <id>\n'));
  return true;
}

function renderList(workspaceRoot: string, sessionKey: string): void {
  const all = loadSchedules(workspaceRoot);
  const mine = all.filter((s) => s.owner === sessionKey);
  if (mine.length === 0) {
    console.log(chalk.yellow('\nNo schedules registered for this session.'));
    console.log(chalk.gray('  Add one with /schedule cron "<expr>" /command or /schedule in 5m /command\n'));
    return;
  }
  console.log(chalk.bold('\nSchedules'));
  for (const s of mine) {
    const status = s.enabled ? chalk.green('●') : chalk.gray('○');
    const kind = s.kind === 'cron' ? `cron "${s.expr}"` : `once`;
    console.log(`  ${status} ${chalk.cyan(s.id)}  ${chalk.gray(kind.padEnd(28))} → ${s.command}`);
    console.log(`      ${chalk.gray(`next: ${formatWhen(new Date(s.nextRun))}${s.lastRun ? `  ·  last: ${formatWhen(new Date(s.lastRun))}` : ''}`)}`);
  }
  console.log();
}

function formatWhen(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '(invalid)';
  const now = Date.now();
  const delta = d.getTime() - now;
  const abs = Math.abs(delta);
  const human = humanDelta(abs);
  const rel = delta >= 0 ? `in ${human}` : `${human} ago`;
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} (${rel})`;
}

function humanDelta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
