// ADR-041 A41-11 — the composition dump. A single structured snapshot of what the
// runtime is composed of, answered by READING the registries the A41-7 rows landed
// rather than by hand-maintained lists:
//   - the builtin agent tools, and which of them dispatch through the D8 handler
//     registry (the strangler's progress, visible),
//   - the current extension contributions (tools / providers / hooks / panels),
//   - the provider catalog (builtin + any registered extension providers),
//   - the CLI slash-command catalog.
// `brainrouter dump-composition` prints this. Extension contributions reflect
// whatever is registered when the snapshot is taken (empty at a cold CLI start,
// populated once a workspace's extensions have loaded).
import { BUILTIN_TOOL_SPECS } from '../extension/builtin/toolSpecs.js';
import { registeredHandlerNames } from '../extension/builtin/handlers/index.js';
import { extensionContributionSummary } from '../extension/registry.js';
import { PROVIDER_REGISTRY } from '../provider/providers/index.js';
import { SLASH_COMMANDS } from '../command/catalog.js';

export interface RuntimeCompositionSnapshot {
  /** Every builtin agent tool name, sorted. */
  builtinTools: string[];
  /** The subset dispatched through the D8 handler registry (vs the shrinking switch). */
  migratedBuiltinTools: string[];
  /** Current extension contributions (empty until a workspace's extensions load). */
  extensions: { tools: string[]; providers: string[]; hooks: number; panels: string[] };
  /** All registered provider ids (builtin catalog + extension providers), sorted. */
  providers: string[];
  /** The CLI slash-command catalog, sorted. */
  slashCommands: string[];
}

export function runtimeCompositionSnapshot(): RuntimeCompositionSnapshot {
  return {
    builtinTools: BUILTIN_TOOL_SPECS.map((spec) => spec.name).sort(),
    migratedBuiltinTools: [...registeredHandlerNames()].sort(),
    extensions: extensionContributionSummary(),
    providers: [...PROVIDER_REGISTRY.entries()].map(([id]) => id).sort(),
    slashCommands: [...SLASH_COMMANDS].sort(),
  };
}
