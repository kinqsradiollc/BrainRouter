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
 *   brainrouter plugin search <q>         — search the hosted registry (P3)
 *   brainrouter plugin trust <name>       — approve a plugin's shell/MCP capabilities (P3)
 *   brainrouter plugin publish [dir]      — validate + build a registry entry + PR/gh instructions (P5)
 *   brainrouter plugin update [name]      — re-resolve source + atomic-swap a newer version (P5, --all)
 *
 * A plugin FEEDS the existing subsystems (skills / agents / commands / hooks /
 * mcp / connectors / workflows) — no parallel runtime. `--workspace` targets the
 * committable workspace scope; the default is user scope (follows the user).
 * Executable capabilities (command hooks + MCP command-servers) stay DISABLED
 * until `plugin trust <name> --shell|--mcp` approves them (P3 consent gate).
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerPluginCommand(program: Command): void {
  program
    .command('plugin <action> [target]')
    .description('Plugins: init | install | list | info | validate | enable | disable | remove | search <q> | trust <name> | publish [dir] | update [name]')
    .option('--workspace', 'Target the committable workspace scope (default: user scope)')
    .option('--force', 'Overwrite an existing install (install)')
    .option('--ref <ref>', 'git ref (branch/tag/commit) for a git source (install)')
    .option('--category <category>', 'Filter search results by category (search)')
    .option('--tag <tag>', 'Filter search results by tag (search)')
    .option('--limit <n>', 'Max search results (search)')
    .option('--shell', 'Approve a plugin\'s command hooks (trust)')
    .option('--mcp', 'Approve a plugin\'s MCP command-servers (trust)')
    .option('--revoke', 'Revoke instead of grant (trust)')
    .option('--all', 'Update every installed plugin (update)')
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
          if (!target) return fail('usage: brainrouter plugin install <path|git-url|name>');
          const { loadOrInitConfig, resolveCliKnobs } = await import('@kinqs/brainrouter-core/config');
          const config = loadOrInitConfig();
          const altManifestNames = resolveCliKnobs(config).plugins.altManifestNames;
          const raw = String(target);
          // Resolve the source form: a local path or git url installs directly;
          // a plain NAME (no path separator, not a git url, not an existing dir)
          // resolves BY NAME across configured marketplaces (P2).
          const fs = await import('node:fs');
          const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.');
          const isGit = plugin.classifySource(raw) === 'git';
          const existsLocal = (() => { try { return fs.statSync(raw).isDirectory(); } catch { return false; } })();
          const byName = !isGit && !existsLocal && !looksLikePath;

          if (byName) {
            const r = plugin.installPluginByName(raw, { scope, workspaceRoot, force: options.force, config });
            if (!r.ok) return fail(r.error ?? 'install failed');
            const res = r.result!;
            if (!res.ok) return fail(res.error);
            if (options.json) { process.stdout.write(JSON.stringify({ ...res, marketplace: r.marketplace }) + '\n'); return; }
            console.log(chalk.green(`Installed "${res.name}" (${scope}) from marketplace "${r.marketplace}" → ${res.installedTo}`));
            for (const w of res.warnings) console.log(chalk.yellow(`  ! ${w}`));
            console.log(chalk.gray(`Enable it with:  brainrouter plugin enable ${res.name}${options.workspace ? ' --workspace' : ''}`));
            return;
          }

          const res = plugin.installPlugin(raw, { scope, workspaceRoot, ref: options.ref, force: options.force, altManifestNames });
          if (!res.ok) return fail(res.error);
          if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return; }
          console.log(chalk.green(`Installed "${res.name}" (${scope}) → ${res.installedTo}`));
          for (const w of res.warnings) console.log(chalk.yellow(`  ! ${w}`));
          console.log(chalk.gray(`Enable it with:  brainrouter plugin enable ${res.name}${options.workspace ? ' --workspace' : ''}`));
          return;
        }

        case 'validate': {
          if (!target) return fail('usage: brainrouter plugin validate <path>');
          const { loadOrInitConfig, resolveCliKnobs } = await import('@kinqs/brainrouter-core/config');
          const altManifestNames = resolveCliKnobs(loadOrInitConfig()).plugins.altManifestNames;
          const res = plugin.discoverPlugin(String(target), { altManifestNames });
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
          // P3 — consent/disclosure: on ENABLE, show what the plugin contributes
          // and flag risky (shell/MCP) capabilities that still need `plugin trust`.
          if (enabled) {
            const { loadOrInitConfig } = await import('@kinqs/brainrouter-core/config');
            const { VERSION } = await import('@kinqs/brainrouter-core/version');
            const cfg = loadOrInitConfig();
            const root = plugin.pluginInstallRoot(scope, String(target), workspaceRoot);
            const disc = plugin.discoverPlugin(root);
            if (disc.ok) {
              const summary = plugin.buildConsentSummary(disc.plugin, {
                approved: plugin.pluginConsent(cfg, String(target)),
                runtime: { brainrouterVersion: VERSION },
              });
              if (!options.json) {
                console.log(chalk.gray(summary.disclosure));
                for (const w of summary.compatibilityWarnings) console.log(chalk.yellow(`  ! ${w}`));
                if (summary.requiresConsent && !(summary.shellApproved && summary.mcpApproved)) {
                  console.log(chalk.yellow(`  This plugin ships executable capabilities that stay DISABLED until approved:`));
                  if (summary.hookCommands.length && !summary.shellApproved) console.log(chalk.yellow(`    brainrouter plugin trust ${target} --shell`));
                  if (summary.mcpCommands.length && !summary.mcpApproved) console.log(chalk.yellow(`    brainrouter plugin trust ${target} --mcp`));
                }
              }
            }
          }
          plugin.setPluginEnabled(String(target), enabled);
          if (options.json) { process.stdout.write(JSON.stringify({ name: String(target), enabled }) + '\n'); return; }
          console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} plugin "${target}".`));
          return;
        }

        case 'search': {
          if (!target) return fail('usage: brainrouter plugin search <query>');
          const { loadOrInitConfig } = await import('@kinqs/brainrouter-core/config');
          const registryUrl = loadOrInitConfig().cli?.plugins?.registryUrl;
          const res = await plugin.fetchAndSearch(registryUrl, String(target), {
            category: options.category,
            tag: options.tag,
            limit: options.limit ? Number(options.limit) : undefined,
          });
          if (!res.ok) return fail(res.error);
          if (options.json) { process.stdout.write(JSON.stringify(res.hits.map((h) => h.entry)) + '\n'); return; }
          if (res.hits.length === 0) { console.log(chalk.gray(`No plugins matched "${target}".`)); return; }
          for (const { entry } of res.hits) {
            const stars = entry.stars ? chalk.yellow(` ★${entry.stars}`) : '';
            const cat = entry.category ? chalk.gray(` [${entry.category}]`) : '';
            console.log(`${chalk.bold(entry.name)}${entry.version ? chalk.gray(` v${entry.version}`) : ''}${cat}${stars}`);
            if (entry.description) console.log(chalk.gray(`  ${entry.description}`));
            console.log(chalk.gray(`  install:  brainrouter plugin install ${entry.repo || entry.id}`));
          }
          return;
        }

        case 'trust': {
          if (!target) return fail('usage: brainrouter plugin trust <name> [--shell] [--mcp] [--revoke]');
          if (!options.shell && !options.mcp) return fail('specify --shell and/or --mcp to approve the capability');
          const grant = !options.revoke;
          const consent: { shell?: boolean; mcp?: boolean } = {};
          if (options.shell) consent.shell = grant;
          if (options.mcp) consent.mcp = grant;
          plugin.setPluginConsent(String(target), consent);
          if (options.json) { process.stdout.write(JSON.stringify({ name: String(target), consent }) + '\n'); return; }
          const verb = grant ? 'Approved' : 'Revoked';
          const caps = [options.shell ? 'shell (command hooks)' : '', options.mcp ? 'MCP command-servers' : ''].filter(Boolean).join(' + ');
          console.log(chalk.green(`${verb} ${caps} for plugin "${target}".`));
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

        case 'publish': {
          // P5 — validate + hash + build a registry entry, then emit PR/gh instructions
          // (or write a local file + gh instructions when no publishRepo is configured).
          const dir = (target && String(target).trim()) || workspaceRoot;
          const { loadOrInitConfig } = await import('@kinqs/brainrouter-core/config');
          const publishRepo = loadOrInitConfig().cli?.plugins?.publishRepo;
          const res = plugin.planPublish(dir, { publishRepo });
          if (!res.ok) return fail(res.error);
          const { plan } = res;
          // Always write the entry to a local file so the user has an artifact to attach.
          const write = plugin.writeRegistryEntryFile(plan);
          if (options.json) { process.stdout.write(JSON.stringify({ ...plan, localFileWritten: write.ok }) + '\n'); return; }
          console.log(chalk.bold(`Registry entry for "${plan.name}":`));
          console.log(plan.entryJson);
          console.log(chalk.gray(`\nintegrity: ${plan.integrity}`));
          for (const w of plan.warnings) console.log(chalk.yellow(`  ! ${w}`));
          if (write.ok) console.log(chalk.green(`\nWrote ${plan.localFile}`));
          console.log('');
          for (const line of plan.instructions) console.log(line.startsWith('#') ? chalk.gray(line) : line);
          return;
        }

        case 'update': {
          // P5 — re-resolve installed plugin(s) from install.json, atomic-swap a newer
          // version, preserving enabled + consent state. `--all` or no target = all.
          const { loadOrInitConfig } = await import('@kinqs/brainrouter-core/config');
          const config = loadOrInitConfig();
          const name = options.all ? undefined : (target ? String(target) : undefined);
          const results = plugin.updatePlugins({ name, workspaceRoot, config });
          if (options.json) { process.stdout.write(JSON.stringify(results) + '\n'); return; }
          if (results.length === 0) { console.log(chalk.gray('No plugins installed.')); return; }
          for (const r of results) {
            if (!r.ok) { console.log(chalk.red(`✗ ${r.name} — ${r.error ?? 'update failed'}`)); process.exitCode = 1; continue; }
            if (r.updated) {
              const from = r.fromVersion ?? (r.fromRevision ? r.fromRevision.slice(0, 8) : '?');
              const to = r.toVersion ?? (r.toRevision ? r.toRevision.slice(0, 8) : '?');
              console.log(chalk.green(`✓ ${r.name} — updated ${from} → ${to} (${r.scope}, enabled state preserved)`));
            } else {
              console.log(chalk.gray(`= ${r.name} — already up to date (${r.scope})`));
            }
          }
          return;
        }

        default:
          return fail(`Unknown plugin action "${act}". Use: init | install | list | info | validate | enable | disable | remove | search | trust | publish | update.`);
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
