/**
 * /trust, /ext, /update — the project-trust gate, the typed-extension surface,
 * and the audited self-update, exposed in the REPL.
 */
import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace, listTrustedWorkspaces } from '@kinqs/brainrouter-core/workspace';
import { listExtensions } from '@kinqs/brainrouter-core/extension';
import { isExtensionEnabled, setExtensionEnabled } from '@kinqs/brainrouter-core/extension';
import { loadExtensions } from '@kinqs/brainrouter-core/extension';
import { extensionContributionSummary } from '@kinqs/brainrouter-core/extension';
import { runAuditedUpdate } from '../../runtime/updateApply.js';

export async function tryHandleExtensionCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  const ws = agent.workspaceRoot;

  if (command === '/trust') {
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'on' || sub === 'add') {
      trustWorkspace(ws);
      console.log(chalk.green(`\n✓ Trusted this workspace — its extensions/hooks will now load.`));
      console.log(chalk.gray(`  ${ws}\n`));
      return true;
    }
    if (sub === 'off' || sub === 'revoke') {
      const was = isWorkspaceTrusted(ws);
      untrustWorkspace(ws);
      console.log(was ? chalk.yellow(`\n✓ Revoked trust for this workspace.\n`) : chalk.gray(`\nThis workspace wasn't trusted.\n`));
      return true;
    }
    const trusted = isWorkspaceTrusted(ws);
    console.log(chalk.bold(`\nProject trust`));
    console.log(`  This workspace: ${trusted ? chalk.green('trusted') : chalk.yellow('NOT trusted')} ${chalk.gray(ws)}`);
    console.log(chalk.gray(`  Trust gates in-workspace code (extensions, pack hooks). Untrusted workspace code never auto-loads.`));
    console.log(chalk.gray(`  Toggle: /trust on  |  /trust off`));
    const all = listTrustedWorkspaces();
    if (all.length) {
      console.log(chalk.bold(`\n  Trusted workspaces:`));
      for (const t of all.slice(0, 20)) console.log(chalk.gray(`    ${t}`));
    }
    console.log();
    return true;
  }

  if (command === '/ext' || command === '/extensions') {
    const sub = (args[0] ?? 'list').toLowerCase();
    if ((sub === 'enable' || sub === 'disable') && args[1]) {
      setExtensionEnabled(args[1], sub === 'enable');
      console.log(chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} extension "${args[1]}" — /ext reload to apply.\n`));
      return true;
    }
    if (sub === 'reload') {
      const r = await loadExtensions(ws);
      console.log(chalk.green(`\n✓ Reloaded extensions: ${r.activated.length} active${r.skippedUntrusted.length ? `, ${r.skippedUntrusted.length} skipped (untrusted)` : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}.`));
      const c = extensionContributionSummary();
      if (c.tools.length) console.log(chalk.gray(`  tools: ${c.tools.join(', ')}`));
      if (c.providers.length) console.log(chalk.gray(`  providers: ${c.providers.join(', ')}`));
      if (c.hooks) console.log(chalk.gray(`  hook handlers: ${c.hooks}`));
      for (const e of r.errors) console.log(chalk.red(`  ✗ ${e.name}: ${e.error}`));
      console.log();
      return true;
    }
    // list
    const exts = listExtensions(ws);
    const trusted = isWorkspaceTrusted(ws);
    console.log(chalk.bold(`\nExtensions`));
    if (exts.length === 0) {
      console.log(chalk.gray(`  (none discovered)`));
      console.log(chalk.gray(`  Add one at ~/.brainrouter/extensions/<name>/ or .brainrouter/extensions/<name>/ with an extension.json + index.js exporting activate(host).\n`));
      return true;
    }
    for (const e of exts) {
      const enabled = isExtensionEnabled(e.name);
      const gated = e.source === 'workspace' && !trusted;
      const state = !enabled ? chalk.gray('disabled') : gated ? chalk.yellow('blocked: untrusted') : chalk.green('active');
      console.log(`  ${chalk.cyan(e.name)} ${chalk.gray(`v${e.version} · ${e.source}`)} — ${state}${e.contributes.length ? chalk.gray(` (${e.contributes.join(', ')})`) : ''}`);
    }
    console.log(chalk.gray(`\n  /ext enable <name> | /ext disable <name> | /ext reload${trusted ? '' : '   ·   workspace extensions need /trust on'}\n`));
    return true;
  }

  if (command === '/update') {
    const apply = args.includes('--yes') || args.includes('-y');
    console.log(chalk.gray('\nChecking for updates…'));
    const r = await runAuditedUpdate({ apply });
    if (!r.decision || !r.decision.behind) {
      console.log(chalk.green(`✓ brainrouter is up to date.\n`));
      return true;
    }
    const d = r.decision;
    console.log(chalk.bold(`\n↑ ${d.latest} available (you have ${d.current})`));
    console.log(`  Audit: ${d.audit.summary}`);
    if (d.blocked) {
      console.log(chalk.yellow(`  ${d.reason}`));
      console.log(chalk.gray(`  Not auto-installing. Review, then: ${d.command}\n`));
    } else if (r.installed) {
      console.log(chalk.green(`  ✓ Installed ${d.latest}. Restart to use it.\n`));
    } else {
      console.log(chalk.gray(`  Clean audit. Install with: /update --yes   (or ${d.command})\n`));
    }
    return true;
  }

  return false;
}
