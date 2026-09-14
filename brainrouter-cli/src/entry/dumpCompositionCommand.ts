import type { Command } from 'commander';
import { runtimeCompositionSnapshot, resolveHostProfile, hostProfileIds, type HostProfileSurfaces, SERVICE_PROFILES, serviceProfileIds, resolveDerivedProfile, derivedProfileIds } from '@kinqs/brainrouter-core/runtime';

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
    .option('--profile <host>', `Show a profile (${[...hostProfileIds(), ...derivedProfileIds()].join(' | ')}) — which surfaces it composes`)
    .option('--services', 'List the registered service profiles (runnable services + remote-bindability)')
    .action((opts: { json?: boolean; profile?: string; services?: boolean }) => {
      const snapshot = runtimeCompositionSnapshot();
      // ADR-041 A41-12 — the service profiles: runnable services described declaratively.
      if (opts.services) {
        const services = serviceProfileIds().map((id) => SERVICE_PROFILES[id as keyof typeof SERVICE_PROFILES]);
        if (opts.json) {
          console.log(JSON.stringify(services, null, 2));
          return;
        }
        console.log('Service profiles\n');
        for (const svc of services) {
          console.log(`  ${svc.id}  (${svc.transport}:${svc.defaultPort}${svc.remoteCapable ? ', remote-bindable' : ''})`);
          console.log(`    ${svc.description}`);
        }
        return;
      }
      // ADR-041 A41-11 — a host profile names which composition surfaces a host
      // activates; render it against the live registries so declared and actual
      // sit side by side.
      if (opts.profile) {
        const live: Partial<Record<keyof HostProfileSurfaces, number>> = {
          agentTools: snapshot.builtinTools.length,
          slashCommands: snapshot.slashCommands.length,
          providers: snapshot.providers.length,
        };
        const liveNote = (name: keyof HostProfileSurfaces, on: boolean): string => {
          const count = live[name];
          return on && count !== undefined ? `  (${count} in this process)` : '';
        };
        const profile = resolveHostProfile(opts.profile);
        if (profile) {
          if (opts.json) {
            console.log(JSON.stringify({ profile, live }, null, 2));
            return;
          }
          console.log(`Host profile: ${profile.host}\n  ${profile.description}\n`);
          console.log('  Surfaces:');
          for (const [name, on] of Object.entries(profile.surfaces)) {
            console.log(`    ${on ? '✓' : '·'} ${name}${liveNote(name as keyof HostProfileSurfaces, on)}`);
          }
          return;
        }
        // ADR-041 A41-11 / D11 — a derived profile is a base host profile with an
        // overlay folded onto it; render each row with the layer that set it.
        const derived = resolveDerivedProfile(opts.profile);
        if (!derived) {
          console.error(
            `Unknown profile "${opts.profile}". Known: ${[...hostProfileIds(), ...derivedProfileIds()].join(', ')}.`,
          );
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({ profile: derived, live }, null, 2));
          return;
        }
        console.log(`Derived profile: ${derived.id}  (base: ${derived.base})\n  ${derived.description}\n`);
        console.log('  Surfaces:');
        for (const row of derived.rows) {
          const layerTag = row.layer === 'base' ? '[base]' : `[${row.layer}]`;
          console.log(`    ${row.value ? '✓' : '·'} ${row.id}  ${layerTag}${liveNote(row.id, row.value)}`);
        }
        return;
      }
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
