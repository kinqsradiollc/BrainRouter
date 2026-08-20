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
import { invariantCompanions, verifyInvariants } from './invariants.js';
import { registerBuiltinInvariantCompanions } from './invariantCompanions.js';
import { activeLoopDriverId } from './loopDriver.js';

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
  /**
   * ADR-041 A41-14 — the runtime-invariants registry, as the glass box sees it:
   * each area's companion (invariant names or the reason it is empty) plus a count
   * of any invariants currently violated. `violations` should always be 0 in a
   * healthy build — a non-zero count here is a live drift the verify gate would fail on.
   */
  invariants: {
    areas: Array<{ area: string; invariants: string[]; emptyReason?: string }>;
    violations: number;
  };
  /** ADR-041 A41-11 — the active agent loop-driver row (`default` until a host swaps it). */
  loopDriver: string;
}

export function runtimeCompositionSnapshot(): RuntimeCompositionSnapshot {
  // Ensure the baseline invariant companions are registered before we read them —
  // this is the real (non-test) consumer of the registry.
  registerBuiltinInvariantCompanions();
  return {
    builtinTools: BUILTIN_TOOL_SPECS.map((spec) => spec.name).sort(),
    migratedBuiltinTools: [...registeredHandlerNames()].sort(),
    extensions: extensionContributionSummary(),
    providers: [...PROVIDER_REGISTRY.entries()].map(([id]) => id).sort(),
    slashCommands: [...SLASH_COMMANDS].sort(),
    invariants: {
      areas: invariantCompanions().map((c) => ({
        area: c.area,
        invariants: c.invariants.map((i) => i.name),
        ...(c.emptyReason ? { emptyReason: c.emptyReason } : {}),
      })),
      violations: verifyInvariants().length,
    },
    loopDriver: activeLoopDriverId(),
  };
}
