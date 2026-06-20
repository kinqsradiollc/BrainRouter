/**
 * TRACK (unified workspace · Track mode) — `/track` slash commands.
 *
 * Leaf operations against the durable per-workspace `trackStore` (one project
 * per workspace). The terminal CLI, the desktop Track surface, and the agent
 * tools all read/write the same `track.json`. On create + transition we emit a
 * best-effort BrainRouter memory note via the existing `emitAgentEvent` path so
 * the board stays provenance-linked, same as `/requirement`.
 */
import chalk from 'chalk';
import { type WorkItem, type WorkItemType, isWorkItemType, isWorkItemPriority } from '@kinqs/brainrouter-types';
import {
  ensureProject,
  getProject,
  listWorkItems,
  getWorkItem,
  createWorkItem,
  transitionWorkItem,
} from '@kinqs/brainrouter-core/dist/track/trackStore.js';
import { emitAgentEvent } from '@kinqs/brainrouter-core/dist/memory/memoryEvents.js';
import type { CommandContext } from './_context.js';

const TYPE_MARK: Record<WorkItemType, string> = { epic: '◆', story: '▣', task: '▸', bug: '✦', 'sub-task': '↳' };
function typeMark(t: WorkItemType): string { return chalk.gray(TYPE_MARK[t] ?? '▸'); }

export async function tryHandleTrackCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  if (command !== '/track') return false;
  const ws = agent.workspaceRoot;
  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') { printUsage(); return true; }

  if (sub === 'list' || sub === 'ls') {
    const items = listWorkItems(ws, rest.length ? { text: rest.join(' ') } : {});
    if (!items.length) { console.log(chalk.yellow('\nNo work items yet. Create one with: /track create <title>\n')); return true; }
    console.log(chalk.bold('\nWork items'));
    for (const w of items) console.log(`  ${chalk.cyan(w.key.padEnd(7))} ${typeMark(w.type)} ${statusTag(w)} ${w.title}`);
    console.log('');
    return true;
  }

  if (sub === 'board') {
    const project = getProject(ws) ?? ensureProject(ws);
    const items = listWorkItems(ws);
    console.log(chalk.bold(`\n${project.key} · ${project.name}`) + chalk.gray(`  ${items.length} item${items.length === 1 ? '' : 's'}`));
    for (const s of project.workflowStates) {
      const col = items.filter((w) => w.status === s.id);
      console.log(`\n${chalk.cyan(s.name)} ${chalk.gray(`(${col.length})`)}`);
      for (const w of col) console.log(`  ${chalk.gray(w.key.padEnd(7))} ${typeMark(w.type)} ${w.title}`);
    }
    console.log('');
    return true;
  }

  if (sub === 'create' || sub === 'new') {
    const parsed = parseCreate(rest);
    if (!parsed.title) { console.log(chalk.red('\nUsage: /track create <title> [--type story|task|bug|epic|sub-task] [--status <id>] [--priority lowest|low|medium|high|highest]\n')); return true; }
    const item = createWorkItem(ws, { title: parsed.title, type: parsed.type, status: parsed.status, priority: parsed.priority, sessionKey: agent.sessionKey, actor: 'user' });
    console.log(chalk.green(`\n✓ Created ${chalk.cyan(item.key)} ${typeMark(item.type)} ${item.title} `) + chalk.gray(`[${item.status}]\n`));
    await captureTrackNote(ctx, item, 'created');
    return true;
  }

  if (sub === 'move' || sub === 'transition') {
    const key = rest[0];
    const to = rest[1];
    if (!key || !to) { console.log(chalk.red('\nUsage: /track move <key> <status-id>   (status ids: /track board)\n')); return true; }
    try {
      const item = transitionWorkItem(ws, key, to, 'user');
      if (!item) { console.log(chalk.yellow(`\nNo work item ${key}.\n`)); return true; }
      console.log(chalk.green(`\n✓ ${item.key} → ${item.status}\n`));
      await captureTrackNote(ctx, item, `moved to ${item.status}`);
    } catch (e) {
      console.log(chalk.red(`\n${(e as Error).message}\n`));
    }
    return true;
  }

  if (sub === 'show') {
    const item = getWorkItem(ws, rest[0] ?? '');
    if (!item) { console.log(chalk.yellow(`\nNo work item ${rest[0] ?? ''}.\n`)); return true; }
    printItem(item);
    return true;
  }

  console.log(chalk.yellow(`\nUnknown subcommand "${sub}". Try /track help\n`));
  return true;
}

function statusTag(w: WorkItem): string {
  const c = w.statusCategory === 'done' ? chalk.green : w.statusCategory === 'in-progress' ? chalk.cyan : chalk.gray;
  return c(`[${w.status}]`);
}

interface ParsedCreate { title: string; type?: WorkItemType; status?: string; priority?: import('@kinqs/brainrouter-types').WorkItemPriority }
function parseCreate(tokens: string[]): ParsedCreate {
  const out: ParsedCreate = { title: '' };
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--type' && isWorkItemType(tokens[i + 1])) { out.type = tokens[++i] as WorkItemType; continue; }
    if (t === '--status') { out.status = tokens[++i]; continue; }
    if (t === '--priority' && isWorkItemPriority(tokens[i + 1])) { out.priority = tokens[++i] as ParsedCreate['priority']; continue; }
    words.push(t);
  }
  out.title = words.join(' ').trim();
  return out;
}

function printItem(item: WorkItem): void {
  console.log(`\n${chalk.cyan(item.key)} ${typeMark(item.type)} ${chalk.bold(item.title)} ${statusTag(item)}`);
  if (item.description) console.log(chalk.gray(`  ${item.description}`));
  const meta = [`priority: ${item.priority}`, item.assignee ? `assignee: ${item.assignee}` : '', item.labels.length ? `labels: ${item.labels.join(', ')}` : '', item.sprintId ? `sprint: ${item.sprintId}` : ''].filter(Boolean);
  if (meta.length) console.log(chalk.gray(`  ${meta.join(' · ')}`));
  if (item.codeLinks.length) console.log(chalk.gray(`  code: ${item.codeLinks.map((c) => `${c.kind}:${c.ref}`).join(', ')}`));
  console.log('');
}

function printUsage(): void {
  console.log(chalk.bold('\n/track — project board for this workspace'));
  console.log(chalk.gray('  /track board                                 Columns + items by status'));
  console.log(chalk.gray('  /track list [text]                           List (optionally filter by text)'));
  console.log(chalk.gray('  /track create <title> [--type --status --priority]   Create a work item'));
  console.log(chalk.gray('  /track move <key> <status-id>                Transition a work item'));
  console.log(chalk.gray('  /track show <key>                            Show one work item\n'));
}

async function captureTrackNote(ctx: CommandContext, item: WorkItem, change: string): Promise<void> {
  try {
    await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Track ${item.key}: ${item.title} [${item.status}] (${change})`,
        payload: { workItemId: item.id, key: item.key, type: item.type, status: item.status, priority: item.priority, change },
      },
    );
  } catch { /* best-effort; never blocks the command */ }
}
