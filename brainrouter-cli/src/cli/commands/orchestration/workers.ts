/**
 * `/workers` and `/pack` — persistent worker threads (MAS-P5-T3) and
 * opt-in agent-definition packs (MAS-P5-T4). Extracted verbatim from the
 * former orchestration/index.ts switch.
 */

import chalk from 'chalk';
import { listPacks, packAgentIds } from '@kinqs/brainrouter-core/pack';
import { readPackState, isPackEnabled, enablePack, disablePack } from '@kinqs/brainrouter-core/pack';
import { listWorkers, readWorkerMeta, readWorkerSummary, closeWorker, type WorkerStatus } from '@kinqs/brainrouter-core/worker';
import type { CommandContext } from '../_context.js';
import { renderWorkerSnapshot } from './_shared.js';

export async function handleWorkers(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  // MAS-P5-T3 — persistent worker threads. list | info <id> | close <id>.
  const sub = (args[0] ?? 'list').toLowerCase();
  const ws = agent.workspaceRoot;
  const dot = (s: WorkerStatus) =>
    s === 'running' ? chalk.cyan('●') : s === 'completed' ? chalk.green('●') : s === 'failed' ? chalk.red('●') : chalk.gray('○');
  if (sub === 'list') {
    const workers = listWorkers(ws);
    if (!workers.length) {
      console.log(chalk.gray('\nNo worker threads. (workers persist under the workspace CLI state directory.)\n'));
      return true;
    }
    console.log(chalk.bold('\nWorker threads:'));
    for (const w of workers) {
      console.log(`  ${dot(w.status)} ${chalk.cyan(w.id)} ${chalk.gray(`(${w.role})`)} — ${w.status} · ${w.goal.slice(0, 60)}${w.goal.length > 60 ? '…' : ''}`);
    }
    console.log(chalk.gray('\n  /workers info <id> | close <id>\n'));
    return true;
  }
  if (sub === 'info') {
    const id = args[1];
    const w = id ? readWorkerMeta(ws, id) : null;
    if (!w) { console.log(chalk.red(`\nNo worker "${id ?? ''}". Try /workers.\n`)); return true; }
    console.log(chalk.bold(`\nWorker ${chalk.cyan(w.id)} ${chalk.gray(`(${w.role})`)}`));
    console.log(`  status: ${w.status}   depth: ${w.depth}   pid: ${w.pid ?? '—'}`);
    if (w.ownership) console.log(`  ownership: ${w.ownership}`);
    console.log(`  goal: ${w.goal}`);
    console.log(chalk.gray(`  created ${w.createdAt} · updated ${w.updatedAt}`));
    const summary = readWorkerSummary(ws, w.id);
    if (summary) console.log(chalk.gray('\n  --- summary.md ---\n') + summary);
    console.log();
    return true;
  }
  if (sub === 'close') {
    const id = args[1];
    if (!id) { console.log(chalk.yellow('\nUsage: /workers close <id>\n')); return true; }
    const w = closeWorker(ws, id);
    console.log(w ? chalk.green(`\nWorker ${id} closed.\n`) : chalk.red(`\nNo worker "${id}".\n`));
    return true;
  }
  if (sub === 'attach') {
    // Snapshot view of a worker's recent transcript + summary. Workers
    // run detached and persist to disk, so "attach" is a point-in-time
    // read; re-run /workers attach to refresh. (No live session is held,
    // so /workers detach is a no-op acknowledgement.) `/fg <id>` is the
    // top-level alias for this.
    const id = args[1];
    if (!renderWorkerSnapshot(ws, id ?? '')) {
      console.log(chalk.red(`\nNo worker "${id ?? ''}". Try /workers.\n`));
    }
    return true;
  }
  if (sub === 'detach') {
    console.log(chalk.gray('\nDetached. (Workers run in the background; /workers attach <id> to view again.)\n'));
    return true;
  }
  console.log(chalk.gray('Usage: /workers [list] | info <id> | attach <id> | detach | close <id>'));
  return true;
}

export async function handlePack(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  // MAS-P5-T4 — agent-definition packs. list | enable <n> | disable <n> | info <n>
  const sub = (args[0] ?? 'list').toLowerCase();
  const name = args[1];
  const ws = agent.workspaceRoot;
  const packs = listPacks(ws);
  const enabled = readPackState(ws).enabled;
  if (sub === 'list') {
    if (!packs.length) {
      console.log(chalk.gray('No packs found. (built-in, ~/.config/brainrouter/packs, .brainrouter/packs)'));
      return true;
    }
    console.log(chalk.bold('\nAgent packs:') + chalk.gray(' (opt-in — enable to add their agents)'));
    for (const p of packs) {
      const on = isPackEnabled(enabled, p.name);
      console.log(
        `  ${on ? chalk.green('●') : chalk.gray('○')} ${chalk.cyan(p.name)} ` +
          `${chalk.gray(`(${p.source} · v${p.version})`)}${p.description ? ` — ${p.description}` : ''}`,
      );
    }
    console.log(chalk.gray('\n  /pack enable <name> | disable <name> | info <name>'));
    return true;
  }
  if (sub === 'info') {
    const p = packs.find((x) => x.name === name);
    if (!p) { console.log(chalk.red(`No pack named "${name ?? ''}". Try /pack list.`)); return true; }
    const ids = packAgentIds(p);
    console.log(chalk.bold(`\nPack: ${chalk.cyan(p.name)} ${chalk.gray(`(${p.source} · v${p.version})`)}`));
    if (p.description) console.log(`  ${p.description}`);
    console.log(chalk.gray(`  dir: ${p.dir}`));
    console.log(`  enabled: ${isPackEnabled(enabled, p.name) ? chalk.green('yes') : chalk.gray('no')}`);
    console.log(`  agents (${ids.length}): ${ids.length ? ids.join(', ') : chalk.gray('none')}`);
    console.log();
    return true;
  }
  if (sub === 'enable' || sub === 'disable') {
    if (!name) { console.log(chalk.red(`Usage: /pack ${sub} <name>`)); return true; }
    if (!packs.some((x) => x.name === name)) { console.log(chalk.red(`No pack named "${name}". Try /pack list.`)); return true; }
    if (sub === 'enable') enablePack(ws, name); else disablePack(ws, name);
    console.log(chalk.green(`Pack "${name}" ${sub}d for this workspace.`) + chalk.gray(' (affects newly spawned agents)'));
    return true;
  }
  console.log(chalk.gray('Usage: /pack list | enable <name> | disable <name> | info <name>'));
  return true;
}
