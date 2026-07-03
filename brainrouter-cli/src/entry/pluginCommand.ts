/**
 * PLUGIN-MARKETPLACE P1 — the `brainrouter plugin` command group.
 *
 *   brainrouter plugin init [name]        — scaffold a plugin skeleton
 *   brainrouter plugin install <path|git> — install from a local dir or git url
 *   brainrouter plugin list               — installed plugins (enabled + disabled)
 *   brainrouter plugin info <name>        — a plugin's manifest + what it contributes
 *   brainrouter plugin validate <path>    — validate a manifest without installing
 *   brainrouter plugin enable <name>      — enable a plugin (cli.plugins.enabled)
 *   brainrouter plugin disable <name>     — disable a plugin
 *   brainrouter plugin remove <name>      — uninstall a plugin
 *
 * A plugin FEEDS the existing subsystems (skills / agents / commands / hooks /
 * mcp / connectors / workflows) — no parallel runtime. `--workspace` targets the
 * committable workspace scope; the default is user scope (follows the user).
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerPluginCommand(program: Command): void {
  program
    .command('plugin <action> [target]')
    .description('Plugins: init | install <path|git> | list | info <name> | validate <path> | enable <name> | disable <name> | remove <name>')
    .option('--workspace', 'Target the committable workspace scope (default: user scope)')
    .option('--force', 'Overwrite an existing install (install)')
    .option('--ref <ref>', 'git ref (branch/tag/commit) for a git source (install)')
    .option('--json', 'Machine-readable output')
    .action(async (action, target, options) => {
      const plugin = await import('@kinqs/brainrouter-core/plugin');
      const scope: 'user' | 'workspace' = options.workspace ? 'workspace' : 'user';
      const workspaceRoot = process.cwd();
      const act = String(action ?? '').toLowerCase();

      const fail = (msg: string): void => { console.error(chalk.red(msg)); process.exitCode = 1; };

      switch (act) {
        case 'init': {
          const name = (target && String(target).trim()) || 'my-plugin';
          const res = plugin.scaffoldPlugin(name, workspaceRoot);
          if (!res.ok) return fail(res.error ?? 'scaffold failed');
          if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return; }
          console.log(chalk.green(`Scaffolded plugin "${name}" at ${res.root}`));
          for (const f of res.files ?? []) console.log(chalk.gray(`  + ${f}`));
          console.log(chalk.gray(`\nInstall it with:  brainrouter plugin install ${res.root}`));
          return;
        }

        case 'install': {
          if (!target) return fail('usage: brainrouter plugin install <path|git-url>');
          const res = plugin.installPlugin(String(target), { scope, workspaceRoot, ref: options.ref, force: options.force });
          if (!res.ok) return fail(res.error);
          if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return; }
          console.log(chalk.green(`Installed "${res.name}" (${scope}) → ${res.installedTo}`));
          for (const w of res.warnings) console.log(chalk.yellow(`  ! ${w}`));
          console.log(chalk.gray(`Enable it with:  brainrouter plugin enable ${res.name}${options.workspace ? ' --workspace' : ''}`));
          return;
        }

        case 'validate': {
          if (!target) return fail('usage: brainrouter plugin validate <path>');
          const res = plugin.discoverPlugin(String(target));
          if (!res.ok) {
            if (options.json) { process.stdout.write(JSON.stringify({ valid: false, errors: res.error.errors }) + '\n'); }
            else { console.error(chalk.red(`Invalid plugin:`)); for (const e of res.error.errors) console.error(chalk.red(`  - ${e}`)); }
            process.exitCode = 1;
            return;
          }
          const provides = plugin.summarizeProvides(res.plugin);
          if (options.json) { process.stdout.write(JSON.stringify({ valid: true, name: res.plugin.name, provides, warnings: res.plugin.warnings }) + '\n'); return; }
          console.log(chalk.green(`Valid plugin: ${res.plugin.name}`));
          console.log(chalk.gray(`  provides: ${describeProvides(provides)}`));
          for (const w of res.plugin.warnings) console.log(chalk.yellow(`  ! ${w}`));
          return;
        }

        case 'list': {
          const { loadOrInitConfig } = await import('@kinqs/brainrouter-core/config');
          const r = plugin.loadPlugins(workspaceRoot, loadOrInitConfig());
          if (options.json) { process.stdout.write(JSON.stringify({ loaded: r.loaded.map((p) => ({ name: p.name, scope: p.scope, provides: p.provides })), disabled: r.disabled.map((p) => p.name), skippedForSafeMode: r.skippedForSafeMode }) + '\n'); return; }
          if (r.skippedForSafeMode) { console.log(chalk.yellow('safeMode is on — plugin loading is skipped.')); }
          if (r.loaded.length === 0 && r.disabled.length === 0) { console.log(chalk.gray('No plugins installed. Scaffold one with `brainrouter plugin init`.')); }
          for (const p of r.loaded) console.log(`${chalk.green('●')} ${chalk.bold(p.name)} ${chalk.gray(`(${p.scope}) — ${describeProvides(p.provides)}`)}`);
          for (const p of r.disabled) console.log(`${chalk.gray('○')} ${p.name} ${chalk.gray('(disabled)')}`);
          for (const e of r.errors) console.log(chalk.red(`  ! ${e}`));
          return;
        }

        case 'info': {
          if (!target) return fail('usage: brainrouter plugin info <name>');
          const root = plugin.pluginInstallRoot(scope, String(target), workspaceRoot);
          const res = plugin.discoverPlugin(root);
          if (!res.ok) return fail(`plugin "${target}" not found in ${scope} scope: ${res.error.errors.join('; ')}`);
          const record = plugin.readInstallRecord(root);
          const provides = plugin.summarizeProvides(res.plugin);
          if (options.json) { process.stdout.write(JSON.stringify({ manifest: res.plugin.manifest, provides, record }) + '\n'); return; }
          const m = res.plugin.manifest;
          console.log(chalk.bold(m.name) + (m.version ? chalk.gray(` v${m.version}`) : ''));
          if (m.description) console.log(m.description);
          console.log(chalk.gray(`  provides: ${describeProvides(provides)}`));
          if (record) console.log(chalk.gray(`  source: ${record.sourceType} ${record.source}${record.ref ? `#${record.ref}` : ''}`));
          return;
        }

        case 'enable':
        case 'disable': {
          if (!target) return fail(`usage: brainrouter plugin ${act} <name>`);
          const enabled = act === 'enable';
          plugin.setPluginEnabled(String(target), enabled);
          if (options.json) { process.stdout.write(JSON.stringify({ name: String(target), enabled }) + '\n'); return; }
          console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} plugin "${target}".`));
          return;
        }

        case 'remove': {
          if (!target) return fail('usage: brainrouter plugin remove <name>');
          const res = plugin.removePlugin(String(target), { scope, workspaceRoot });
          if (!res.ok) return fail(res.error ?? 'remove failed');
          if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return; }
          console.log(chalk.green(`Removed "${target}" (${scope}).`));
          return;
        }

        default:
          return fail(`Unknown plugin action "${act}". Use: init | install | list | info | validate | enable | disable | remove.`);
      }
    });
}

function describeProvides(p: { skills: number; agents: number; commands: number; hooks: number; mcpServers: number; connectors: number; workflows: number }): string {
  const parts: string[] = [];
  if (p.skills) parts.push(`${p.skills} skill${p.skills === 1 ? '' : 's'}`);
  if (p.agents) parts.push(`${p.agents} agent${p.agents === 1 ? '' : 's'}`);
  if (p.commands) parts.push(`${p.commands} command${p.commands === 1 ? '' : 's'}`);
  if (p.hooks) parts.push(`${p.hooks} hook${p.hooks === 1 ? '' : 's'}`);
  if (p.mcpServers) parts.push(`${p.mcpServers} MCP server${p.mcpServers === 1 ? '' : 's'}`);
  if (p.connectors) parts.push(`${p.connectors} connector${p.connectors === 1 ? '' : 's'}`);
  if (p.workflows) parts.push(`${p.workflows} workflow${p.workflows === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'nothing';
}
