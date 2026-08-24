/**
 * `/playbook` slash command (ADR-047 D3 / P3) — create, run, list, and schedule
 * a playbook: a packaged, parameterized, schedulable automation unit.
 *
 *   /playbook list
 *   /playbook init <name>
 *   /playbook run <name> [--param k=v ...]
 *   /playbook schedule <name> cron "<expr>" [--param k=v ...]
 *
 * A playbook is a thin COMPOSITE — it does not add a runtime. `run` resolves the
 * playbook's typed parameters, substitutes them into its body (or a referenced
 * skill's), applies the playbook's bounded tool policy for the turn, and submits
 * a normal agent turn. `schedule` registers the exact `/playbook run …` command
 * with the durable schedule ticker, which re-injects it through this same
 * dispatcher when it fires — no new scheduling machinery.
 */
import chalk from 'chalk';
import { addSchedule, parseCron, nextCronFire } from '@kinqs/brainrouter-core/schedule';
import {
  loadPlaybook,
  listPlaybooks,
  scaffoldPlaybook,
  resolvePlaybookParams,
  applyPlaybookParams,
  parseParamArgs,
  playbookRunCommand,
  isValidPlaybookName,
  type Playbook,
} from '../../../prompt/playbookCatalog.js';
import { resolveSkill, buildSkillPrompt } from '../../../prompt/skillRunner.js';
import type { CommandContext } from '../_context.js';

export async function tryHandlePlaybookCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/playbook') return false;
  const { args, agent, mcpClient } = ctx;
  const sub = (args[0] ?? '').toLowerCase();

  if (!sub || sub === 'list') {
    renderList(agent.workspaceRoot);
    return true;
  }

  if (sub === 'init') {
    const name = args[1];
    if (!name || !isValidPlaybookName(name)) {
      console.log(chalk.red('\nUsage: /playbook init <name>  (letters, digits, dashes, underscores)\n'));
      return true;
    }
    const res = scaffoldPlaybook(agent.workspaceRoot, name);
    console.log(res.created
      ? chalk.green(`\n✓ Created playbook "${name}" at ${res.path}`)
      : chalk.yellow(`\nPlaybook "${name}" already exists at ${res.path} (not overwritten).`));
    console.log(chalk.gray(`  Edit it, then run:  /playbook run ${name} --param key=value\n`));
    return true;
  }

  if (sub === 'run') {
    const name = args[1];
    if (!name) { console.log(chalk.red('\nUsage: /playbook run <name> [--param k=v ...]\n')); return true; }
    const playbook = loadPlaybook(agent.workspaceRoot, name);
    if (!playbook) { console.log(chalk.red(`\nNo playbook "${name}". Run /playbook list, or /playbook init ${name}.\n`)); return true; }

    const provided = parseParamArgs(args.slice(2));
    const resolved = resolvePlaybookParams(playbook, provided);
    if (!resolved.ok) {
      if (resolved.missing.length) console.log(chalk.red(`\nMissing required param(s): ${resolved.missing.map((p) => `--param ${p}=…`).join(' ')}`));
      for (const e of resolved.errors) console.log(chalk.red(`  ${e}`));
      console.log('');
      return true;
    }

    const rendered = applyPlaybookParams(playbook, resolved.values);
    let prompt: string;
    if (playbook.skill) {
      const skill = await resolveSkill(mcpClient, playbook.skill, agent.workspaceRoot, 'full');
      if (skill.source === 'fallback') {
        console.log(chalk.red(`\nPlaybook "${name}" references unknown skill "${playbook.skill}". Fix the frontmatter or run /skills.\n`));
        return true;
      }
      prompt = buildSkillPrompt(skill, { input: rendered });
      // The playbook's bounded tool policy WINS over the skill's; fall back to the skill's when the playbook declares none.
      agent.activeSkillAllowedTools = playbook.allowedTools ?? skill.allowedTools;
      agent.activeSkillDisallowedTools = playbook.disallowedTools.length ? playbook.disallowedTools : (skill.disallowedTools ?? []);
    } else {
      prompt = `# Playbook: ${playbook.name}\n${playbook.description ? `${playbook.description}\n` : ''}\n${rendered}`;
      agent.activeSkillAllowedTools = playbook.allowedTools;
      agent.activeSkillDisallowedTools = playbook.disallowedTools;
    }
    // The turn runner clears activeSkill* after the turn, so the bounded policy is per-run.
    console.log(chalk.green(`\n▶ Running playbook "${name}"${Object.keys(resolved.values).length ? ` (${Object.entries(resolved.values).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}\n`));
    ctx.repl.runAgentTurn(prompt);
    return true;
  }

  if (sub === 'schedule') {
    const name = args[1];
    const mode = (args[2] ?? '').toLowerCase();
    if (!name || mode !== 'cron') {
      console.log(chalk.red('\nUsage: /playbook schedule <name> cron "<expr>" [--param k=v ...]\n'));
      return true;
    }
    const playbook = loadPlaybook(agent.workspaceRoot, name);
    if (!playbook) { console.log(chalk.red(`\nNo playbook "${name}".\n`)); return true; }
    const expr = (args[3] ?? playbook.schedule ?? '').replace(/^["']|["']$/g, '').trim();
    const cron = expr ? parseCron(expr) : null;
    if (!cron) {
      console.log(chalk.red(`\nInvalid or missing cron expression${expr ? `: "${expr}"` : ''} (5 fields: minute hour dom month dow).\n`));
      return true;
    }
    const provided = parseParamArgs(args.slice(4));
    const resolved = resolvePlaybookParams(playbook, provided);
    if (!resolved.ok) {
      if (resolved.missing.length) console.log(chalk.red(`\nMissing required param(s): ${resolved.missing.join(', ')}`));
      for (const e of resolved.errors) console.log(chalk.red(`  ${e}`));
      console.log('');
      return true;
    }
    const command = playbookRunCommand(name, resolved.values);
    const nextRun = nextCronFire(cron, new Date());
    const rec = addSchedule(agent.workspaceRoot, {
      kind: 'cron',
      expr,
      command,
      owner: agent.sessionKey,
      nextRun: nextRun.toISOString(),
    });
    console.log(chalk.green(`\n✓ Scheduled ${rec.id}: cron "${expr}" → ${command}`));
    console.log(chalk.gray(`  Fires in this session while it is open (the ticker filters by owner).\n`));
    return true;
  }

  console.log(chalk.red(`\nUnknown /playbook subcommand "${sub}". Try: list | init | run | schedule.\n`));
  return true;
}

function renderList(workspaceRoot: string): void {
  const playbooks = listPlaybooks(workspaceRoot);
  if (playbooks.length === 0) {
    console.log(chalk.gray('\nNo playbooks. Create one with /playbook init <name>.\n'));
    return;
  }
  console.log(chalk.bold('\nPlaybooks:'));
  for (const pb of playbooks) console.log(`  ${chalk.cyan(pb.name)}${pb.description ? chalk.gray(` — ${pb.description}`) : ''}${paramHint(pb)}`);
  console.log('');
}

function paramHint(pb: Playbook): string {
  if (pb.params.length === 0) return '';
  const names = pb.params.map((p) => (p.required ? `${p.name}*` : p.name)).join(', ');
  return chalk.gray(`  [${names}]`);
}
