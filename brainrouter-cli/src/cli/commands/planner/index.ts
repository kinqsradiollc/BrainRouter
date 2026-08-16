/**
 * ADR-038 D5 — `/planner` slash commands.
 *
 * The terminal surface over the same user-scoped store the desktop planner mode
 * and the dashboard read. Not per-workspace: none of these take a workspace
 * root, because a planner is personal and follows you between projects (D9). If
 * a workspace argument ever appears here, the scoping has regressed.
 *
 * `/planner` is deliberately distinct from `/plan`: the latter is the durable
 * agent-work plan whose state gates goal completion. Sharing a spelling made
 * this personal planner unreachable because the workflow handler runs first.
 */
import chalk from 'chalk';
import {
  addItem,
  canEditLocally,
  canUpdateItemLocally,
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
  type UpdateItemInput,
} from '@kinqs/brainrouter-core/planner';
import type { CommandContext } from '../_context.js';

/** The planner is user-scoped; a single local planner until account identity is threaded. */
const USER = undefined;

function printUsage(): void {
  console.log(chalk.bold('\n/planner — your day, across every project\n'));
  console.log('  /planner                         what is on today');
  console.log('  /planner add <title>             capture something');
  console.log('  /planner list [all]              list active or all items');
  console.log('  /planner done <id>               mark it complete');
  console.log('  /planner reopen <id>             mark it active again');
  console.log('  /planner due <id> <date>         set or clear a due date (— to clear)');
  console.log('  /planner block <id> <minutes>    set aside time for it');
  console.log('  /planner delete <id>             remove a locally owned item');
  console.log('  /planner find <text>             search titles and notes');
  console.log('  /planner conflicts               items that changed in two places');
  console.log('  /planner keep <id> <field> a|b           resolve one');
  console.log('  /planner drift                   how estimates are holding up');
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

function updateRefusal(id: string, input: UpdateItemInput): string {
  const item = listItems(USER, { includeCompleted: true }).find((candidate) => candidate.id === id);
  if (!item) return 'That planner item is no longer here.';
  return canUpdateItemLocally(item, input).reason ?? 'The planner refused that change.';
}

function deleteRefusal(id: string): string {
  const item = listItems(USER, { includeCompleted: true }).find((candidate) => candidate.id === id);
  if (!item) return 'That planner item is no longer here.';
  return canEditLocally(item, 'delete').reason ?? 'The planner refused that removal.';
}

export function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
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
  if (command !== '/planner') return false;

  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  const now = Date.now();
  const today = localDateKey(new Date(now));

  if (sub === 'help') { printUsage(); return true; }

  /* ------------------------------------------------------------- today */
  if (!sub) {
    const view = todayView(USER, { date: today, nowMs: now });
    const blocks = listBlocks(USER);
    const scheduledIds = new Set(blocks.filter((b) => !b.completedAt).map((b) => b.itemId));

    if (view.items.length === 0) {
      console.log(chalk.dim('\n  Nothing planned for today. `/planner add <title>` to capture something.\n'));
    } else {
      console.log('');
      for (const item of view.items) console.log(line(item, scheduledIds));
      console.log('');
    }

    // Ordered by what needs a decision. Conflicts first because they are the
    // only thing that cannot resolve itself.
    if (view.conflicts.length > 0) {
      console.log(chalk.yellow(
        `  ${view.conflicts.length} item(s) changed in two places — \`/planner conflicts\`.`,
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

  /* -------------------------------------------------------------- list */
  if (sub === 'list' || sub === 'ls') {
    const includeCompleted = (rest[0] ?? '').toLowerCase() === 'all';
    const items = listItems(USER, { includeCompleted });
    const scheduledIds = new Set(
      listBlocks(USER).filter((block) => !block.completedAt).map((block) => block.itemId),
    );
    if (items.length === 0) {
      console.log(chalk.dim(includeCompleted ? '  Your planner is empty.' : '  No active planner items.'));
      return true;
    }
    console.log('');
    for (const item of items) console.log(line(item, scheduledIds));
    console.log('');
    return true;
  }

  /* --------------------------------------------------------------- add */
  if (sub === 'add' || sub === 'new' || sub === 'capture') {
    const title = rest.join(' ').trim();
    if (!title) { console.log(chalk.red('  A title is required: /planner add <title>')); return true; }
    const item = addItem(USER, { title }, now);
    console.log(chalk.dim(`  added ${shortId(item.id)}  ${item.title.value}`));
    return true;
  }

  /* -------------------------------------------------------------- done */
  if (sub === 'done' || sub === 'complete') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const input = { completed: true } as const;
    const updated = updateItem(USER, found.id, input, now);
    if (!updated) {
      console.log(chalk.red(`  not completed — ${updateRefusal(found.id, input)}`));
      return true;
    }
    console.log(chalk.dim(`  done  ${updated.title.value}`));
    return true;
  }

  if (sub === 'undone' || sub === 'reopen') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const input = { completed: false } as const;
    if (!updateItem(USER, found.id, input, now)) {
      console.log(chalk.red(`  not reopened — ${updateRefusal(found.id, input)}`));
      return true;
    }
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
    const input = { dueDate: date };
    if (!updateItem(USER, found.id, input, now)) {
      console.log(chalk.red(`  due date unchanged — ${updateRefusal(found.id, input)}`));
      return true;
    }
    console.log(chalk.dim(date ? `  due ${date}` : '  due date cleared'));
    return true;
  }

  /* -------------------------------------------------------------- block */
  if (sub === 'block' || sub === 'schedule') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const minutes = Number(rest[1]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.log(chalk.red('  How long? /planner block <id> <minutes>'));
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
    if (!deleteItem(USER, found.id, now)) {
      console.log(chalk.red(`  not removed — ${deleteRefusal(found.id)}`));
      return true;
    }
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
        console.log(`        version A: ${String(c.ours)}`);
        console.log(`        version B: ${String(c.theirs)}`);
      }
      console.log(chalk.dim(`      /planner keep ${shortId(item.id)} <field> a|b`));
    }
    console.log('');
    return true;
  }

  if (sub === 'keep') {
    const found = resolveId(rest[0] ?? '');
    if ('error' in found) { console.log(chalk.red(`  ${found.error}`)); return true; }
    const field = rest[1] ?? '';
    const side = (rest[2] ?? '').toLowerCase();
    if (side !== 'a' && side !== 'b') {
      console.log(chalk.red('  Which version? /planner keep <id> <field> a|b'));
      return true;
    }
    const resolved = resolveConflict(USER, found.id, field, side === 'a' ? 'ours' : 'theirs', now);
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

  console.log(chalk.red(`  Unknown: /planner ${sub}`));
  printUsage();
  return true;
}
