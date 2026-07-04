/**
 * MC-B3 — `brainrouter automations`: the per-workspace automation-rule
 * registry (`.brainrouter/automations/*.md`, on/when/do frontmatter).
 * Read/toggle only — rules are plain files the team commits and reviews;
 * nothing here starts a listener or runs a job.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerAutomationsCommand(program: Command): void {
  program
    .command('automations [action] [id]')
    .description('Per-workspace automation rules (.brainrouter/automations/*.md): list | enable <id> | disable <id>')
    .option('--json', 'Machine-readable output')
    .action(async (action, id, options) => {
      const { validateAutomationsInvocation, formatAutomationsList } =
        await import('../runtime/triggers/automationsCommand.js');
      const triggers = await import('@kinqs/brainrouter-core/triggers');
      const act = String(action ?? 'list').toLowerCase();
      const workspaceRoot = process.cwd();

      const gateError = validateAutomationsInvocation(act, id);
      if (gateError) {
        console.error(chalk.red(gateError));
        process.exitCode = 1;
        return;
      }

      if (act === 'list') {
        const rules = triggers.listAutomationRules(workspaceRoot);
        if (options.json) {
          process.stdout.write(JSON.stringify({ rules }) + '\n');
          return;
        }
        console.log(formatAutomationsList(rules));
        return;
      }

      // enable | disable
      const enabled = act === 'enable';
      const ok = triggers.setAutomationRuleEnabled(workspaceRoot, String(id), enabled);
      if (options.json) {
        process.stdout.write(JSON.stringify({ id, enabled, ok }) + '\n');
        if (!ok) process.exitCode = 1;
        return;
      }
      if (!ok) {
        console.error(chalk.red(`No automation rule "${id}" under .brainrouter/automations/ (see: brainrouter automations list).`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(`Automation rule ${chalk.cyan(String(id))} → ${enabled ? 'enabled' : 'disabled'}.`));
    });
}
