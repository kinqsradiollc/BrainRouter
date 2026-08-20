import type { Command } from 'commander';
import { runtimeCompositionSnapshot } from '@kinqs/brainrouter-core/runtime';

/**
 * ADR-041 A41-11 — `brainrouter dump-composition`. Prints what the runtime is
 * composed of, read straight from the registries the A41-7 rows landed: the
 * builtin agent tools (and which dispatch through the D8 handler registry), the
 * provider catalog, the extension contributions, and the CLI slash commands.
 * `--json` emits the machine-readable snapshot for diffing across builds.
 */
export function registerDumpCompositionCommand(program: Command): void {
  program
    .command('dump-composition')
    .description('Print the composed runtime — agent tools, providers, extensions, and slash commands.')
    .option('--json', 'Emit the machine-readable JSON snapshot instead of a human summary')
    .action((opts: { json?: boolean }) => {
      const snapshot = runtimeCompositionSnapshot();
      if (opts.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      const { builtinTools, migratedBuiltinTools, providers, slashCommands, extensions } = snapshot;
      console.log('Runtime composition\n');
      console.log(`  builtin tools:  ${builtinTools.length}  (${migratedBuiltinTools.length} dispatch via the D8 handler registry)`);
      console.log(`  providers:      ${providers.length}`);
      if (providers.length) console.log(`    ${providers.join(', ')}`);
      console.log(`  slash commands: ${slashCommands.length}`);
      console.log(
        `  extensions:     ${extensions.tools.length} tool(s), ${extensions.providers.length} provider(s), ` +
          `${extensions.hooks} hook(s), ${extensions.panels.length} panel(s)`,
      );
      if (!extensions.tools.length && !extensions.providers.length && !extensions.panels.length) {
        console.log('    (no extensions loaded in this process — run inside a workspace session to include them)');
      }
      console.log('\n  Re-run with --json for the full machine-readable snapshot.');
    });
}
