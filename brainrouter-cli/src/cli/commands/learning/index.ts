/**
 * ADR-032 §5 Q4 / D4 — the surface that makes learned state inspectable and
 * reversible.
 *
 * The ADR is explicit that a learned store nobody can look at is a black box
 * that changes behaviour, which is the thing ADR-028 exists to refuse. So:
 * `/learned` lists what the agent has learned and where each item came from,
 * `/learned revert` is the defined way back (D4 makes undo an operation, not a
 * database edit), and `/learned correct` is the ONLY route to D1's instruction
 * tier — a person, saying it, in session.
 *
 * The gate applies to a human correction too. That is not pedantry: a
 * correction that names nothing which could contradict it can never be retired
 * by D6, so it becomes a permanent resident of every future session's context.
 */
import chalk from 'chalk';
import {
  getLearnedItem, listLearnedItems, readLearningLog, recordHumanCorrection,
  revertLearnedItemLifecycle,
  type LearnedItem,
} from '@kinqs/brainrouter-core/learning';
import { learnedTenantForAgent } from '@kinqs/brainrouter-core/agent';
import type { CommandContext } from '../_context.js';

const USAGE = [
  'Usage:',
  '  /learned                      What your agent has learned, newest first',
  '  /learned all                  Include demoted, retired and reverted items',
  '  /learned show <id>            One item with its full provenance',
  '  /learned log                  The audit trail (admissions, retirements, reverts)',
  '  /learned revert <id> [reason] Take one back — it stops reaching the agent',
  '  /learned correct <statement> | <what would show it wrong> | <what should improve>',
].join('\n');

function tierLabel(item: LearnedItem): string {
  return item.tier === 'instruction'
    ? chalk.magenta('instruction')
    : chalk.cyan('evidence');
}

function statusLabel(item: LearnedItem): string {
  switch (item.status) {
    case 'active': return chalk.green('active');
    case 'demoted': return chalk.yellow('demoted');
    case 'retired': return chalk.gray('retired');
    default: return chalk.gray('reverted');
  }
}

function printItem(item: LearnedItem): void {
  console.log(`  ${chalk.bold(item.id)}  ${tierLabel(item)} · ${statusLabel(item)} · ${item.form}`);
  console.log(`    ${item.statement}`);
  console.log(chalk.gray(`    wrong if: ${item.falsifier}`));
  console.log(chalk.gray(
    `    expects: ${item.outcome.expectation}`
    + `  ·  retrieved ${item.outcome.retrievals}× · confirmed ${item.outcome.confirmations}×`
    + ` · contradicted ${item.outcome.contradictions}×`,
  ));
  if (item.skillId) console.log(chalk.gray(`    runs as: ${item.skillId}`));
  if (item.statusReason) console.log(chalk.gray(`    ${item.statusReason}`));
}

export async function tryHandleLearningCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/learned') return false;
  const { args, agent } = ctx;
  const tenant = learnedTenantForAgent(agent);
  const sub = (args[0] ?? '').toLowerCase();

  if (sub === 'show') {
    const item = getLearnedItem(tenant, args[1] ?? '');
    if (!item) { console.log(chalk.red(`\nNo learned item with id "${args[1] ?? ''}".\n`)); return true; }
    console.log(chalk.bold('\nLearned item'));
    printItem(item);
    console.log(chalk.gray(`    session: ${item.provenance.sessionKey} · ${item.provenance.checkpoint} · ${item.provenance.capturedAt}`));
    console.log(chalk.gray(`    admitted because: ${item.provenance.gateReasoning}`));
    for (const line of item.provenance.evidence) console.log(chalk.gray(`    evidence: ${line}`));
    if (item.memoryRecordId) console.log(chalk.gray(`    memory record: ${item.memoryRecordId}`));
    console.log();
    return true;
  }

  if (sub === 'log') {
    const log = readLearningLog(tenant).slice(0, 40);
    if (log.length === 0) { console.log(chalk.gray('\nNothing has been learned or retired yet.\n')); return true; }
    console.log(chalk.bold('\nLearning audit trail'));
    for (const entry of log) {
      console.log(`  ${chalk.gray(entry.at)}  ${chalk.cyan(entry.op.padEnd(13))} ${entry.detail}`);
    }
    console.log();
    return true;
  }

  if (sub === 'revert') {
    const id = args[1] ?? '';
    const reason = args.slice(2).join(' ').trim() || 'reverted from the CLI';
    const result = await revertLearnedItemLifecycle({
      tenant,
      id,
      reason,
      memory: typeof (agent as any).mcpClient?.callHostLearning === 'function'
        ? {
          archive: async ({ recordId, itemId, reason: archiveReason }) => {
            // Human reverts need the explicit learned-status marker, not only
            // a generic archive: other devices distinguish this irreversible
            // decision from an automatic, reversible demotion by that marker.
            const response = await (agent as any).mcpClient.callHostLearning({
              operation: 'revert',
              input: {
                itemId,
                reason: archiveReason,
              },
            });
            const text = Array.isArray(response?.content)
              ? String(response.content[0]?.text ?? '')
              : '';
            if (!response?.isError) {
              let parsed: { found?: boolean } | undefined;
              try { parsed = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
              if (parsed?.found) return;
              throw new Error('central learned-behaviour record was not found');
            }

            throw new Error(text || `central learned-behaviour revert failed for ${recordId}`);
          },
        }
        : undefined,
    });
    if (!result.found || !result.item) {
      console.log(chalk.red(`\nNo learned item with id "${id}".\n`));
      return true;
    }
    console.log(chalk.yellow(`\nReverted ${result.item.id}. It no longer reaches the agent; its provenance is kept.`));
    if (result.memory.status === 'archive-pending') {
      console.log(chalk.yellow('Central memory archive is pending and will be retried by a later checkpoint.'));
    }
    console.log();
    return true;
  }

  if (sub === 'correct') {
    const parts = args.slice(1).join(' ').split('|').map((part) => part.trim());
    if (parts.length < 3 || parts.some((part) => !part)) {
      console.log(chalk.red('\n/learned correct needs three parts separated by "|".'));
      console.log(chalk.gray('  /learned correct never force-push a release branch | a force-pushed release branch still matches origin | release history stops diverging\n'));
      return true;
    }
    const result = recordHumanCorrection({
      tenant,
      sessionKey: agent.sessionKey,
      statement: parts[0]!,
      falsifier: parts[1]!,
      expectation: parts[2]!,
    });
    if (!result.admitted) {
      console.log(chalk.red(`\nNot recorded (${result.rule}): ${result.reason}`));
      console.log(chalk.gray('A correction that nothing could ever contradict can never be retired.\n'));
      return true;
    }
    console.log(chalk.green(`\nRecorded as an instruction (${result.item.id}). It reaches every future session until you revert it.\n`));
    return true;
  }

  if (sub && sub !== 'all') {
    console.log(`\n${USAGE}\n`);
    return true;
  }

  const items = listLearnedItems(tenant, { includeInactive: sub === 'all' });
  if (items.length === 0) {
    console.log(chalk.gray('\nYour agent has not learned anything yet. It reflects at turn end, at compaction, and at session end.\n'));
    return true;
  }
  console.log(chalk.bold(`\nLearned — ${items.length} item(s)`));
  for (const item of items) printItem(item);
  console.log(chalk.gray('\n  /learned show <id> · /learned revert <id> · /learned correct <…>\n'));
  return true;
}
