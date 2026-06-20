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
import { type WorkItem, type WorkItemType, type AutomationTrigger, type AutomationAction, type AutomationActionType, type ProjectRole, isWorkItemType, isWorkItemPriority, isAutomationTrigger, isAutomationActionType, isProjectRole } from '@kinqs/brainrouter-types';
import {
  ensureProject,
  getProject,
  listWorkItems,
  getWorkItem,
  createWorkItem,
  transitionWorkItem,
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
} from '@kinqs/brainrouter-core/dist/track/trackStore.js';
import { parseTrackQuery } from '@kinqs/brainrouter-core/dist/track/query.js';
import { exportToGithub, importFromGithub, resolveGithubConfig } from '@kinqs/brainrouter-core/dist/track/githubSync.js';
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
    const arg = rest.join(' ').trim();
    const isQuery = /[=~<>]|(\s(and|or|in)\s)/i.test(arg);
    if (isQuery) {
      const p = parseTrackQuery(arg);
      if (!p.ok) { console.log(chalk.red(`\nBad query: ${p.error}\n`)); return true; }
    }
    const items = listWorkItems(ws, arg ? (isQuery ? { query: arg } : { text: arg }) : {});
    if (!items.length) { console.log(chalk.yellow(`\n${arg ? 'No matching work items.' : 'No work items yet. Create one with: /track create <title>'}\n`)); return true; }
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

  if (sub === 'automations' || sub === 'auto') { handleAutomations(ws, rest); return true; }

  if (sub === 'members' || sub === 'member') { handleMembers(ws, rest); return true; }

  if (sub === 'sync') { await handleSync(ws, rest); return true; }

  console.log(chalk.yellow(`\nUnknown subcommand "${sub}". Try /track help\n`));
  return true;
}

/** `/track sync github <import|export> [--dry-run] [--repo owner/name]`. */
async function handleSync(ws: string, rest: string[]): Promise<void> {
  const provider = (rest[0] ?? '').toLowerCase();
  const direction = (rest[1] ?? '').toLowerCase();
  if (provider !== 'github' || (direction !== 'import' && direction !== 'export')) {
    console.log(chalk.gray('\nUsage: /track sync github import|export [--dry-run] [--repo owner/name]'));
    console.log(chalk.gray('  Token: cli.track.githubToken in config.json, or $GITHUB_TOKEN. Repo: --repo or cli.track.githubRepo.\n'));
    return;
  }
  const dryRun = rest.includes('--dry-run') || rest.includes('-n');
  const repoIdx = rest.indexOf('--repo');
  const repoArg = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
  const cfg = resolveGithubConfig(repoArg);
  if (!cfg.repo) { console.log(chalk.red('\nNo repo. Pass --repo owner/name or set cli.track.githubRepo in config.json.\n')); return; }
  if (!cfg.token) { console.log(chalk.red('\nNo token. Set cli.track.githubToken in config.json or export GITHUB_TOKEN.\n')); return; }

  const opts = { repo: cfg.repo, token: cfg.token, fetchImpl: fetch as never, dryRun };
  console.log(chalk.gray(`\n${dryRun ? 'Dry-run: ' : ''}${direction} ${cfg.repo} (token via ${cfg.tokenSource})…`));
  try {
    const res = direction === 'export' ? await exportToGithub(ws, opts) : await importFromGithub(ws, opts);
    const rows = res.exported ?? res.imported ?? [];
    const creates = rows.filter((r) => r.action === 'create').length;
    const updates = rows.filter((r) => r.action === 'update').length;
    console.log(chalk.green(`${dryRun ? 'Would ' : ''}${direction === 'export' ? 'push' : 'pull'}: ${creates} new, ${updates} updated`) + chalk.gray(` (${rows.length} total)`));
    for (const r of rows.slice(0, 20)) {
      const label = 'key' in r ? (r.key ?? '—') : `#${(r as { issueNumber: number }).issueNumber}`;
      console.log(`  ${r.action === 'create' ? chalk.green('+') : chalk.cyan('~')} ${chalk.cyan(String(label).padEnd(8))} ${r.title}`);
    }
    if (res.errors.length) { console.log(chalk.red(`\n${res.errors.length} error(s):`)); for (const e of res.errors.slice(0, 10)) console.log(chalk.red(`  ${e}`)); }
    console.log('');
  } catch (e) {
    console.log(chalk.red(`\nSync failed: ${(e as Error).message}\n`));
  }
}

/** `/track members [list|add|role|rm]` — per-project members & roles. */
function handleMembers(ws: string, rest: string[]): void {
  ensureProject(ws);
  const op = (rest[0] ?? 'list').toLowerCase();

  if (op === 'list' || op === 'ls') {
    const members = listMembers(ws);
    console.log(chalk.bold('\nMembers'));
    for (const m of members) {
      console.log(`  ${roleColor(m.role)(m.role.padEnd(6))} ${chalk.cyan((m.id).padEnd(14))} ${m.name ?? ''}`);
    }
    console.log('');
    return;
  }

  if (op === 'add') {
    const id = rest[1];
    const role = rest[2];
    if (!id) { console.log(chalk.red('\nUsage: /track members add <handle> [role: viewer|member|admin|owner] [--name "Full Name"]\n')); return; }
    if (role && !isProjectRole(role)) { console.log(chalk.red(`\nUnknown role "${role}". Use: viewer · member · admin · owner\n`)); return; }
    const nameIdx = rest.indexOf('--name');
    const name = nameIdx >= 0 ? rest.slice(nameIdx + 1).join(' ').trim() || undefined : undefined;
    try {
      const m = addMember(ws, { id, name, role: (role as ProjectRole) ?? 'member' });
      console.log(chalk.green(`\n✓ ${m.id} added as ${m.role}\n`));
    } catch (e) { console.log(chalk.red(`\n${(e as Error).message}\n`)); }
    return;
  }

  if (op === 'role') {
    const id = rest[1];
    const role = rest[2];
    if (!id || !role) { console.log(chalk.red('\nUsage: /track members role <handle> <viewer|member|admin|owner>\n')); return; }
    if (!isProjectRole(role)) { console.log(chalk.red(`\nUnknown role "${role}".\n`)); return; }
    try {
      const m = updateMemberRole(ws, id, role);
      console.log(m ? chalk.green(`\n✓ ${m.id} → ${m.role}\n`) : chalk.yellow(`\nNo member ${id}.\n`));
    } catch (e) { console.log(chalk.red(`\n${(e as Error).message}\n`)); }
    return;
  }

  if (op === 'rm' || op === 'remove' || op === 'del') {
    const id = rest[1];
    if (!id) { console.log(chalk.red('\nUsage: /track members rm <handle>\n')); return; }
    try {
      console.log(removeMember(ws, id) ? chalk.green(`\n✓ Removed ${id}\n`) : chalk.yellow(`\nNo member ${id}.\n`));
    } catch (e) { console.log(chalk.red(`\n${(e as Error).message}\n`)); }
    return;
  }

  console.log(chalk.yellow(`\nUnknown members op "${op}". Try: list · add · role · rm\n`));
}

function roleColor(role: ProjectRole): (s: string) => string {
  return role === 'owner' ? chalk.magenta : role === 'admin' ? chalk.cyan : role === 'member' ? chalk.green : chalk.gray;
}

/** `/track automations [list|add|rm|on|off]` — manage trigger→action rules. */
function handleAutomations(ws: string, rest: string[]): void {
  ensureProject(ws);
  const op = (rest[0] ?? 'list').toLowerCase();

  if (op === 'list' || op === 'ls') {
    const rules = listAutomations(ws);
    if (!rules.length) { console.log(chalk.yellow('\nNo automation rules. Add one with: /track automations add <name> --when created --if "type = bug" --do set-priority:high\n')); return; }
    console.log(chalk.bold('\nAutomation rules'));
    for (const r of rules) {
      const dot = r.enabled ? chalk.green('●') : chalk.gray('○');
      const acts = r.actions.map((a) => `${a.type}:${a.value}`).join(', ');
      console.log(`  ${dot} ${chalk.cyan(r.id.padEnd(12))} ${chalk.bold(r.name)}`);
      console.log(chalk.gray(`      when ${r.trigger}${r.condition ? ` · if ${r.condition}` : ''} → ${acts}`));
    }
    console.log('');
    return;
  }

  if (op === 'add' || op === 'new') {
    const parsed = parseAutomation(rest.slice(1));
    if (!parsed.name) { console.log(chalk.red('\nUsage: /track automations add <name> [--when created|transitioned|updated] [--if "<query>"] --do <action>:<value> [--do …]\n  actions: set-status · set-priority · set-assignee · add-label · comment\n')); return; }
    if (!parsed.actions.length) { console.log(chalk.red('\nAdd at least one action: --do set-priority:high\n')); return; }
    if (parsed.condition) {
      const p = parseTrackQuery(parsed.condition);
      if (!p.ok) { console.log(chalk.red(`\nBad condition query: ${p.error}\n`)); return; }
    }
    const rule = createAutomation(ws, { name: parsed.name, trigger: parsed.trigger, condition: parsed.condition, actions: parsed.actions });
    console.log(chalk.green(`\n✓ Rule ${chalk.cyan(rule.id)} "${rule.name}" — when ${rule.trigger}${rule.condition ? ` if ${rule.condition}` : ''} → ${rule.actions.map((a) => `${a.type}:${a.value}`).join(', ')}\n`));
    return;
  }

  if (op === 'rm' || op === 'delete' || op === 'del') {
    const id = rest[1];
    if (!id) { console.log(chalk.red('\nUsage: /track automations rm <id>\n')); return; }
    console.log(deleteAutomation(ws, id) ? chalk.green(`\n✓ Deleted ${id}\n`) : chalk.yellow(`\nNo rule ${id}.\n`));
    return;
  }

  if (op === 'on' || op === 'off' || op === 'enable' || op === 'disable') {
    const id = rest[1];
    if (!id) { console.log(chalk.red(`\nUsage: /track automations ${op} <id>\n`)); return; }
    const enabled = op === 'on' || op === 'enable';
    const r = updateAutomation(ws, id, { enabled });
    console.log(r ? chalk.green(`\n✓ ${r.name} ${enabled ? 'enabled' : 'paused'}\n`) : chalk.yellow(`\nNo rule ${id}.\n`));
    return;
  }

  console.log(chalk.yellow(`\nUnknown automations op "${op}". Try: list · add · rm · on · off\n`));
}

interface ParsedAutomation { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }
function parseAutomation(tokens: string[]): ParsedAutomation {
  const out: ParsedAutomation = { name: '', trigger: 'created', actions: [] };
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--when' && isAutomationTrigger(tokens[i + 1])) { out.trigger = tokens[++i] as AutomationTrigger; continue; }
    if (t === '--if') { out.condition = tokens[++i]; continue; }
    if (t === '--do') {
      const spec = tokens[++i] ?? '';
      const sep = spec.indexOf(':');
      const type = sep >= 0 ? spec.slice(0, sep) : spec;
      const value = sep >= 0 ? spec.slice(sep + 1) : '';
      if (isAutomationActionType(type) && value) out.actions.push({ type: type as AutomationActionType, value });
      continue;
    }
    words.push(t);
  }
  out.name = words.join(' ').trim();
  return out;
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
  console.log(chalk.gray('  /track list [text | query]                   List; a query like "priority >= high AND type = bug"'));
  console.log(chalk.gray('  /track create <title> [--type --status --priority]   Create a work item'));
  console.log(chalk.gray('  /track move <key> <status-id>                Transition a work item'));
  console.log(chalk.gray('  /track show <key>                            Show one work item'));
  console.log(chalk.gray('  /track automations [list|add|rm|on|off]      Trigger→action rules (e.g. bugs → high priority)'));
  console.log(chalk.gray('  /track members [list|add|role|rm]            Project members + roles (owner·admin·member·viewer)'));
  console.log(chalk.gray('  /track sync github import|export [--dry-run]  Two-way sync with GitHub Issues\n'));
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
