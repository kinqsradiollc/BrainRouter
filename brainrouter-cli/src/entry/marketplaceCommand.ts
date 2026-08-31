/**
 * PLUGIN-MARKETPLACE P2 — the `brainrouter marketplace` command group.
 *
 *   brainrouter marketplace add <name> <source>  — register a marketplace source
 *   brainrouter marketplace remove <name>        — deregister a marketplace
 *   brainrouter marketplace list                 — configured marketplaces
 *   brainrouter marketplace update [name]        — refresh (git pull / re-read) + record revision
 *
 * A marketplace indexes plugins via a `brainrouter-marketplace.json` at its root.
 * `brainrouter plugin install <name>` then resolves a plugin BY NAME across every
 * configured marketplace and atomic-installs it (reuses P1). BrainRouter's own
 * conventions only — never `.claude`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerMarketplaceCommand(program: Command): void {
  program
    .command('marketplace <action> [name] [source]')
    .description('Plugin marketplaces: add <name> <source> | remove <name> | list | update [name]')
    .option('--ref <ref>', 'git ref (branch/tag/commit) for a git marketplace source (add)')
    .option('--sparse <paths...>', 'git sub-paths to check out (monorepo marketplaces)')
    .option('--force', 'replace an existing marketplace of the same name (add)')
    .option('--json', 'Machine-readable output')
    .action(async (action, name, source, options) => {
      const plugin = await import('@kinqs/brainrouter-core/plugin');
      const act = String(action ?? '').toLowerCase();
      const fail = (msg: string): void => { console.error(chalk.red(msg)); process.exitCode = 1; };

      switch (act) {
        case 'add': {
          if (!name || !source) return fail('usage: brainrouter marketplace add <name> <source>');
          const res = plugin.addMarketplace(String(name), String(source), {
            ref: options.ref,
            sparsePaths: options.sparse,
            force: options.force,
          });
          if (!res.ok || !res.entry) return fail(res.error ?? 'add failed');
          if (options.json) { process.stdout.write(JSON.stringify(res.entry) + '\n'); return; }
          console.log(chalk.green(`Added marketplace "${res.entry.name}" (${res.entry.sourceType}) → ${res.entry.source}`));
          console.log(chalk.gray(`Install a plugin from it with:  brainrouter plugin install <plugin-name>`));
          return;
        }

        case 'remove': {
          if (!name) return fail('usage: brainrouter marketplace remove <name>');
          const res = plugin.removeMarketplace(String(name));
          if (!res.ok) return fail(res.error ?? 'remove failed');
          if (options.json) { process.stdout.write(JSON.stringify({ removed: String(name) }) + '\n'); return; }
          console.log(chalk.green(`Removed marketplace "${name}".`));
          return;
        }

        case 'list': {
          const list = plugin.listMarketplaces();
          if (options.json) { process.stdout.write(JSON.stringify(list) + '\n'); return; }
          if (list.length === 0) { console.log(chalk.gray('No marketplaces configured. Add one with `brainrouter marketplace add <name> <source>`.')); return; }
          for (const m of list) {
            const rev = m.lastRevision ? chalk.gray(` @${m.lastRevision.slice(0, 8)}`) : '';
            const upd = m.lastUpdated ? chalk.gray(` (updated ${m.lastUpdated})`) : '';
            console.log(`${chalk.bold(m.name)} ${chalk.gray(`[${m.sourceType}]`)} ${m.source}${m.ref ? chalk.gray(`#${m.ref}`) : ''}${rev}${upd}`);
          }
          return;
        }

        case 'update': {
          const results = await plugin.updateMarketplaces(name ? String(name) : undefined);
          if (options.json) { process.stdout.write(JSON.stringify(results) + '\n'); return; }
          if (results.length === 0) { console.log(chalk.gray('No marketplaces to update.')); return; }
          for (const r of results) {
            if (r.ok) console.log(chalk.green(`✓ ${r.name}`) + chalk.gray(` — ${r.plugins ?? 0} plugin(s)${r.revision ? ` @${r.revision.slice(0, 8)}` : ''}`));
            else { console.log(chalk.red(`✗ ${r.name} — ${r.error ?? 'update failed'}`)); process.exitCode = 1; }
          }
          return;
        }

        default:
          return fail(`Unknown marketplace action "${act}". Use: add | remove | list | update.`);
      }
    });
}
