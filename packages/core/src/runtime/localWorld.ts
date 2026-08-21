// ADR-041 A41-10 — the concrete `local` execution world.
//
// D10 defined `ExecutionWorld` (a coherent binding of the three capability ports)
// and `resolveExecutionPorts`, but nothing constructed a world, so `executionWorld`
// was always undefined and every tool fell through to its call-site node default.
// This is the default world the Agent runs in: it binds the SAME node port
// implementations those call sites already default to, so making it live is
// byte-identical — but the seam is now actually used, so `--dump-composition` can
// report which world an agent runs in and an extension or host can swap the whole
// set by passing a different `executionWorld`.
//
// The world is constructed here, "where the node implementations live" (per
// executionWorld.ts), rather than in executionWorld.ts itself, which stays
// import-edge-free (type-only port imports). The shell binding is rebuilt from the
// exported `runShell` / `startBackgroundShell` leaves — the same two functions the
// handler's private `nodeShellPort` uses — rather than importing the handler module
// (which would form a cycle back through the Agent).

import { nodeFilesystemPort } from '../agent/fs/filesystemPort.js';
import { defaultSubprocessPort } from '../agent/subprocess/externalCliSubprocess.js';
import type { ShellPort } from '../agent/shell/shellPort.js';
import { runShell } from '../exec/runtime/sandbox.js';
import { startBackgroundShell } from '../exec/runtime/backgroundShell.js';
import type { ExecutionWorld } from './executionWorld.js';

/** Stable id for the default world (surfaced in the composition dump). */
export const LOCAL_EXECUTION_WORLD_NAME = 'local';

let cached: ExecutionWorld | undefined;

/**
 * The default execution world: the three node ports as one coherent, swappable
 * unit. Binding these is byte-identical to the pre-D10 call-site fall-throughs
 * (`this.filesystemPort ?? nodeFilesystemPort`, etc.) — the same function
 * references, now selected as a set.
 *
 * Built LAZILY (and memoized) rather than as a module-load const: the port
 * imports (`defaultSubprocessPort` in particular) sit in an import cycle with the
 * Agent, so touching them at this module's init time throws a TDZ
 * (`Cannot access 'defaultSubprocessPort' before initialization`) under real ESM.
 * Accessing them only when an Agent is actually constructed — long after every
 * module has initialized — sidesteps the cycle without changing what is bound.
 */
export function localExecutionWorld(): ExecutionWorld {
  return (cached ??= {
    name: LOCAL_EXECUTION_WORLD_NAME,
    filesystem: nodeFilesystemPort,
    shell: { runShell, startBackgroundShell } satisfies ShellPort,
    subprocess: defaultSubprocessPort,
  });
}
