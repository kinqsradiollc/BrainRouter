/**
 * ADR-028 Part D — `/plan` slash commands.
 *
 * The terminal surface over the same user-scoped store the desktop planner mode
 * and the dashboard read. Not per-workspace: none of these take a workspace
 * root, because a planner is personal and follows you between projects (D9). If
 * a workspace argument ever appears here, the scoping has regressed.
 *
 * `/plan` is deliberately short. A planner you have to spell out is one you stop
 * using during the ten seconds where writing something down was the point.
 */
import chalk from 'chalk';
import {
  addItem,
  updateItem,
  deleteItem,
  listItems,
  scheduleBlock,
  listBlocks,
  listConflicts,
  resolveConflict,
  todayView,
  findItems,
  summarizeDrift,
  describeCarryOver,
  needsAttention,
  type PlannerItem,
} from '@kinqs/brainrouter-core/planner';
import type { CommandContext } from '../_context.js';

/** The planner is user-scoped; a single local planner until account identity is threaded. */
const USER = undefined;

function printUsage(): void {
  console.log(chalk.bold('\n/plan — your day, across every project\n'));
  console.log('  /plan                       what is on today');
  console.log('  /plan add <title>           capture something');
  console.log('  /plan done <id>             mark it complete');
  console.log('  /plan due <id> <date>       set or clear a due date (— to clear)');
  console.log('  /plan block <id> <minutes>  set aside time for it');
  console.log('  /plan find <text>           search titles and notes');
  console.log('  /plan conflicts             items that changed in two places');
  console.log('  /plan keep <id> <field> mine|theirs   resolve one');
  console.log('  /plan drift                 how estimates are holding up');
  console.log(chalk.dim('\n  The same planner the desktop app and dashboard show.\n'));
}

/** A short, stable prefix — enough to type, enough to be unambiguous. */
function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}

/** Resolve a user-typed id prefix to exactly one item, or explain why not. */
function resolveId(prefix: string): { id: string } | { error: string } {
  const all = listItems(USER, { includeCompleted: true });
  const matches = all.filter((i) => i.id === prefix || i.id.startsWith(prefix));
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return { error: `No item matches "${prefix}".` };
  // Ambiguity is REPORTED, never resolved by guessing — picking the first match
  // means a mistyped prefix silently completes the wrong task.
  return {
    error:
      `"${prefix}" matches ${matches.length} items:\n` +
      matches.map((m) => `    ${shortId(m.id)}  ${m.title.value}`).join('\n'),
  };
}

function line(item: PlannerItem, scheduledIds: ReadonlySet<string>): string {
  const done = item.completed?.value === true;
  const box = done ? chalk.dim('[x]') : '[ ]';
  const due = item.dueDate?.value;
  const bits: string[] = [];
  if (item.source) bits.push(chalk.dim(item.source));
  if (typeof due === 'string') bits.push(chalk.dim(due.slice(0, 10)));
  if (scheduledIds.has(item.id)) bits.push(chalk.dim('scheduled'));
  if (item.conflicts && Object.keys(item.conflicts).length > 0) {
    bits.push(chalk.yellow(`${Object.keys(item.conflicts).join(', ')} differs`));
  }
  const title = done ? chalk.dim(item.title.value) : item.title.value;
  return `  ${box} ${chalk.dim(shortId(item.id))}  ${title}${bits.length ? '  ' + bits.join(' · ') : ''}`;
}

export async function tryHandlePlannerCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args } = ctx;
  if (command !== '/plan' && command !== '/planner') return false;

  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  if (sub === 'help') { printUsage(); return true; }

  /* ------------------------------------------------------------- today */
  if (!sub) {
    const view = todayView(USER, { date: today, nowMs: now });
    const blocks = listBlocks(USER);
    const scheduledIds = new Set(blocks.filter((b) => !b.completedAt).map((b) => b.itemId));

    if (view.items.length === 0) {
      console.log(chalk.dim('\n  Nothing planned for today. `/plan add <title>` to capture something.\n'));
    } else {
      console.log('');
      for (const item of view.items) console.log(line(item, scheduledIds));
      console.log('');
    }

    // Ordered by what needs a decision. Conflicts first because they are the
    // only thing that cannot resolve itself.
    if (view.conflicts.length > 0) {
      console.log(chalk.yellow(
        `  ${view.conflicts.length} item(s) changed in two places — \`/plan conflicts\`.`,
      ));
    }
    for (const stale of view.staleSources) console.log(chalk.dim(`  ${stale}`));
    if (view.commitment.note) console.log(chalk.dim(`  ${view.commitment.note}`));
    // A ratio that teaches, shown only when there is enough sample to mean
    // something.
    if (view.drift.description) console.log(chalk.dim(`  ${view.drift.description}`));
    console.log(chalk.dim(`  ${view.syncState}\n`));
    return true;
  }

  /* --------------------------------------------------------------- add */
  if (sub === 'add' || sub === 'new') {
    const title = rest.join(' ').trim();
    if (!title) { console.log(chalk.red('  A title is required: /plan add <title>')); return true; }
    const item = addItem(USER, { title }, now);
    console.log(chalk.dim(`  added ${shortId(item.id)}  ${item.title.value}`));
    return true;
  }

  /* -------------------------------------------------------------- done */
  if (sub === 'done' || sub === 'complete') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const updated = updateItem(USER, found.id, { completed: true }, now);
    console.log(chalk.dim(`  done  ${updated?.title.value ?? found.id}`));
    return true;
  }

  if (sub === 'undone' || sub === 'reopen') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    updateItem(USER, found.id, { completed: false }, now);
    console.log(chalk.dim('  reopened'));
    return true;
  }

  /* ---------------------------------------------------------------- due */
  if (sub === 'due') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const raw = (rest[1] ?? '').trim();
    const date = raw === '' || raw === '-' || raw === '—' ? null : raw;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.log(chalk.red('  Dates are YYYY-MM-DD. Use - to clear.'));
      return true;
    }
    updateItem(USER, found.id, { dueDate: date }, now);
    console.log(chalk.dim(date ? `  due ${date}` : '  due date cleared'));
    return true;
  }

  /* -------------------------------------------------------------- block */
  if (sub === 'block' || sub === 'schedule') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const minutes = Number(rest[1]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.log(chalk.red('  How long? /plan block <id> <minutes>'));
      return true;
    }
    // Unscheduled by default: a today list is a real plan, and forcing a clock
    // time is how planners get abandoned (D5).
    const at = rest[2];
    scheduleBlock(USER, {
      itemId: found.id, estimateMinutes: minutes,
      ...(at ? { scheduledFor: at } : {}),
    }, now);
    console.log(chalk.dim(`  ${minutes}m set aside${at ? ` at ${at}` : ''}`));
    return true;
  }

  /* --------------------------------------------------------------- find */
  if (sub === 'find' || sub === 'search') {
    const query = rest.join(' ');
    const hits = findItems(USER, query);
    if (hits.length === 0) { console.log(chalk.dim(`  Nothing matches "${query}".`)); return true; }
    console.log('');
    for (const item of hits) console.log(line(item, new Set()));
    console.log('');
    return true;
  }

  /* --------------------------------------------------------------- rm */
  if (sub === 'rm' || sub === 'delete') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    deleteItem(USER, found.id, now);
    console.log(chalk.dim('  removed'));
    return true;
  }

  /* ---------------------------------------------------------- conflicts */
  if (sub === 'conflicts') {
    const conflicts = listConflicts(USER);
    if (conflicts.length === 0) { console.log(chalk.dim('  No conflicts.')); return true; }
    console.log('');
    for (const item of conflicts) {
      console.log(`  ${chalk.dim(shortId(item.id))}  ${item.title.value}`);
      for (const [field, c] of Object.entries(item.conflicts ?? {})) {
        // Both versions are shown. A conflict you cannot see the sides of is
        // the same as having discarded the losing edit.
        console.log(`      ${chalk.yellow(field)}`);
        console.log(`        mine:   ${String(c.ours)}`);
        console.log(`        theirs: ${String(c.theirs)}`);
      }
      console.log(chalk.dim(`      /plan keep ${shortId(item.id)} <field> mine|theirs`));
    }
    console.log('');
    return true;
  }

  if (sub === 'keep') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const field = rest[1] ?? '';
    const side = (rest[2] ?? '').toLowerCase();
    if (side !== 'mine' && side !== 'theirs') {
      console.log(chalk.red('  Which version? /plan keep <id> <field> mine|theirs'));
      return true;
    }
    const resolved = resolveConflict(USER, found.id, field, side === 'mine' ? 'ours' : 'theirs', now);
    if (!resolved) { console.log(chalk.red(`  No "${field}" conflict on that item.`)); return true; }
    console.log(chalk.dim(`  kept ${side}`));
    return true;
  }

  /* -------------------------------------------------------------- drift */
  if (sub === 'drift') {
    const blocks = listBlocks(USER);
    const drift = summarizeDrift(blocks);
    if (!drift.description) {
      console.log(chalk.dim(
        `  Not enough finished blocks yet (${drift.sampleSize}). A ratio from a handful of ` +
        'blocks moves too much to plan around.',
      ));
    } else {
      console.log(`  ${drift.description}`);
    }
    // Repeatedly-moved items are raised as a question about the task.
    for (const stuck of needsAttention(blocks)) {
      console.log(chalk.dim(`  ${describeCarryOver(stuck)}`));
    }
    return true;
  }

  console.log(chalk.red(`  Unknown: /plan ${sub}`));
  printUsage();
  return true;
}
