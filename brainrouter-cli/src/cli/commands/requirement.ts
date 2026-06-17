/**
 * REQUIREMENT-RECORDS (0.4.15) — `/requirement` slash commands.
 *
 * A Requirement Record is a structured unit of intent a chat can be anchored
 * to. These commands are leaf operations against the durable per-workspace
 * `requirementStore`; on create + on a meaningful update (status change /
 * criterion add) they also emit a best-effort BrainRouter memory note via the
 * existing `memory_capture_turn` event path and link the returned record id
 * back into the requirement.
 *
 * Flag parsing is the minimal sensible subset for `/requirement update`:
 * `--status <s>`, `--priority <p>`, and `--criteria "<text>"` (append one
 * criterion). Anything more is left for a later slice.
 */

import chalk from 'chalk';
import {
  isRequirementStatus,
  isRequirementPriority,
  type RequirementRecord,
  type RequirementStatus,
} from '@kinqs/brainrouter-types';
import {
  createRequirement,
  updateRequirement,
  getRequirement,
  listRequirements,
  linkRequirement,
} from '../../state/requirementStore.js';
import { emitAgentEvent } from '../../orchestration/memoryEvents.js';
import type { CommandContext } from './_context.js';

export async function tryHandleRequirementCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient } = ctx;
  if (command !== '/requirement' && command !== '/req') return false;

  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    printUsage();
    return true;
  }

  if (sub === 'create' || sub === 'new') {
    const title = rest.join(' ').trim();
    if (!title) {
      console.log(chalk.red('\nUsage: /requirement create <title>\n'));
      return true;
    }
    const record = createRequirement(agent.workspaceRoot, {
      title,
      sessionKey: agent.sessionKey,
    });
    console.log(chalk.green(`\n✓ Created requirement ${chalk.cyan(record.id)} [${statusColor(record.status)}]`));
    console.log(`  ${record.title}\n`);
    // Best-effort memory capture; never blocks/throws the command.
    await captureRequirementNote(ctx, record, 'created');
    return true;
  }

  if (sub === 'list' || sub === 'ls') {
    const records = listRequirements(agent.workspaceRoot);
    if (records.length === 0) {
      console.log(chalk.yellow('\nNo requirements yet. Create one with: /requirement create <title>\n'));
      return true;
    }
    console.log(chalk.bold('\nRequirements'));
    for (const r of records) {
      const session = r.sessionKey ? chalk.gray(` · ${r.sessionKey}`) : '';
      console.log(
        `  ${chalk.cyan(r.id)} [${statusColor(r.status)}] ${priorityLabel(r.priority)} ${r.title}${session}`,
      );
    }
    console.log();
    return true;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) {
      console.log(chalk.red('\nUsage: /requirement show <id>\n'));
      return true;
    }
    const r = getRequirement(agent.workspaceRoot, id);
    if (!r) {
      console.log(chalk.yellow(`\nNo requirement with id "${id}".\n`));
      return true;
    }
    printRecord(r);
    return true;
  }

  if (sub === 'update' || sub === 'set') {
    const id = rest[0];
    if (!id) {
      console.log(chalk.red('\nUsage: /requirement update <id> --status <s> | --priority <p> | --criteria "<text>"\n'));
      return true;
    }
    if (!getRequirement(agent.workspaceRoot, id)) {
      console.log(chalk.yellow(`\nNo requirement with id "${id}".\n`));
      return true;
    }
    const flags = parseUpdateFlags(rest.slice(1));
    if (flags.error) {
      console.log(chalk.red(`\n${flags.error}\n`));
      return true;
    }
    if (!flags.status && !flags.priority && !flags.criterion) {
      console.log(chalk.red('\nNothing to update. Use --status <s>, --priority <p>, or --criteria "<text>".\n'));
      return true;
    }

    const existing = getRequirement(agent.workspaceRoot, id)!;
    const patch: Parameters<typeof updateRequirement>[2] = {};
    if (flags.status) patch.status = flags.status;
    if (flags.priority) patch.priority = flags.priority;
    if (flags.criterion) patch.acceptanceCriteria = [...existing.acceptanceCriteria, flags.criterion];

    const updated = updateRequirement(agent.workspaceRoot, id, patch);
    if (!updated) {
      console.log(chalk.yellow(`\nNo requirement with id "${id}".\n`));
      return true;
    }
    console.log(chalk.green(`\n✓ Updated requirement ${chalk.cyan(updated.id)} [${statusColor(updated.status)}]`));
    if (flags.status) console.log(chalk.gray(`  status → ${updated.status}`));
    if (flags.priority) console.log(chalk.gray(`  priority → ${updated.priority}`));
    if (flags.criterion) console.log(chalk.gray(`  + criterion: ${flags.criterion}`));
    console.log();

    // A status change or a new criterion is "meaningful" — capture a note.
    const meaningful = Boolean(flags.status) || Boolean(flags.criterion);
    if (meaningful) {
      await captureRequirementNote(ctx, updated, flags.status ? `status → ${updated.status}` : 'criterion added');
    }
    return true;
  }

  console.log(chalk.red(`\nUnknown /requirement subcommand "${sub}".`));
  printUsage();
  return true;
}

interface UpdateFlags {
  status?: RequirementStatus;
  priority?: RequirementRecord['priority'];
  criterion?: string;
  error?: string;
}

/**
 * Minimal flag parser for `/requirement update`. Supports `--status`,
 * `--priority`, and `--criteria` (which may be quoted, so multiple following
 * tokens up to the next `--flag` are joined). Returns an `error` string on a
 * bad enum value or a flag missing its argument.
 */
function parseUpdateFlags(tokens: string[]): UpdateFlags {
  const out: UpdateFlags = {};
  let i = 0;
  while (i < tokens.length) {
    const flag = tokens[i];
    if (flag === '--status' || flag === '--priority') {
      const value = tokens[i + 1];
      if (!value || value.startsWith('--')) {
        return { error: `${flag} requires a value.` };
      }
      if (flag === '--status') {
        if (!isRequirementStatus(value)) {
          return { error: `Invalid status "${value}". One of: draft, clarifying, ready, in-progress, done, archived.` };
        }
        out.status = value;
      } else {
        if (!isRequirementPriority(value)) {
          return { error: `Invalid priority "${value}". One of: low, medium, high.` };
        }
        out.priority = value;
      }
      i += 2;
      continue;
    }
    if (flag === '--criteria' || flag === '--criterion') {
      // Collect everything until the next --flag, then strip surrounding quotes.
      const parts: string[] = [];
      i += 1;
      while (i < tokens.length && !tokens[i].startsWith('--')) {
        parts.push(tokens[i]);
        i += 1;
      }
      const criterion = stripQuotes(parts.join(' ').trim());
      if (!criterion) return { error: '--criteria requires a non-empty value.' };
      out.criterion = criterion;
      continue;
    }
    return { error: `Unknown flag "${flag}".` };
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Capture a short structured note for a requirement via the existing
 * `memory_capture_turn` event path (emitAgentEvent). Best-effort: never throws,
 * never blocks the command on a brain miss. On success, links the returned
 * memory record id back into the requirement.
 */
async function captureRequirementNote(
  ctx: CommandContext,
  record: RequirementRecord,
  change: string,
): Promise<void> {
  try {
    const criteria = record.acceptanceCriteria.length
      ? ` | criteria: ${record.acceptanceCriteria.join('; ')}`
      : '';
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Requirement ${record.id}: ${record.title} [${record.status}] (${change})`,
        payload: {
          requirementId: record.id,
          title: record.title,
          status: record.status,
          priority: record.priority,
          acceptanceCriteria: record.acceptanceCriteria,
          change,
        },
      },
    );
    if (memoryId) {
      linkRequirement(ctx.agent.workspaceRoot, record.id, { memoryId });
    }
  } catch {
    // Memory capture is advisory — a failure must never break the command.
  }
}

function printRecord(r: RequirementRecord): void {
  console.log(chalk.bold(`\nRequirement ${chalk.cyan(r.id)}`));
  console.log(`  Title:     ${chalk.cyan(r.title)}`);
  if (r.description) console.log(`  Details:   ${r.description}`);
  console.log(`  Status:    ${statusColor(r.status)}`);
  console.log(`  Priority:  ${priorityLabel(r.priority)}`);
  if (r.sessionKey) console.log(`  Session:   ${chalk.gray(r.sessionKey)}`);
  console.log(`  Created:   ${chalk.gray(r.createdAt)}`);
  console.log(`  Updated:   ${chalk.gray(r.updatedAt)}`);

  console.log(chalk.bold('\n  Acceptance criteria'));
  if (r.acceptanceCriteria.length === 0) console.log(chalk.gray('    (none)'));
  else r.acceptanceCriteria.forEach((c, n) => console.log(`    ${n + 1}. ${c}`));

  console.log(chalk.bold('\n  Clarifying Q&A'));
  if (r.clarifyingQuestions.length === 0) console.log(chalk.gray('    (none)'));
  else for (const qa of r.clarifyingQuestions) {
    console.log(`    Q: ${qa.question}`);
    console.log(`    A: ${qa.answer ? qa.answer : chalk.gray('(unanswered)')}`);
  }

  console.log(chalk.bold('\n  Links'));
  console.log(`    tasks:     ${r.taskIds.length ? chalk.gray(r.taskIds.join(', ')) : chalk.gray('(none)')}`);
  console.log(`    artifacts: ${r.artifactIds.length ? chalk.gray(r.artifactIds.join(', ')) : chalk.gray('(none)')}`);
  console.log(`    memory:    ${r.linkedMemoryIds.length ? chalk.gray(r.linkedMemoryIds.join(', ')) : chalk.gray('(none)')}`);
  if (r.sourceEventId) console.log(`    source:    ${chalk.gray(r.sourceEventId)}`);
  console.log();
}

function statusColor(status: RequirementStatus): string {
  switch (status) {
    case 'draft': return chalk.gray(status);
    case 'clarifying': return chalk.yellow(status);
    case 'ready': return chalk.cyan(status);
    case 'in-progress': return chalk.blue(status);
    case 'done': return chalk.green(status);
    case 'archived': return chalk.gray(status);
    default: return status;
  }
}

function priorityLabel(priority: RequirementRecord['priority']): string {
  if (priority === 'high') return chalk.red('high');
  if (priority === 'low') return chalk.gray('low');
  return chalk.yellow('medium');
}

function printUsage(): void {
  console.log(chalk.bold('\n/requirement — structured requirement records'));
  console.log(chalk.gray('  /requirement create <title>                 Create a draft anchored to this session'));
  console.log(chalk.gray('  /requirement list                           List this workspace\'s requirements'));
  console.log(chalk.gray('  /requirement show <id>                      Full record + criteria + Q&A + links'));
  console.log(chalk.gray('  /requirement update <id> --status <s>       Change status (draft|clarifying|ready|in-progress|done|archived)'));
  console.log(chalk.gray('  /requirement update <id> --priority <p>     Change priority (low|medium|high)'));
  console.log(chalk.gray('  /requirement update <id> --criteria "<c>"   Append an acceptance criterion'));
  console.log();
}
