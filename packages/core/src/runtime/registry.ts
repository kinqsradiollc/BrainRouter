/**
 * MC-A1 — runtime backend registry + factory.
 *
 * `resolveRuntime(kind, options)` is the single place callers obtain a
 * runtime instance. The kind defaults from the `cli.runtime.backend` knob
 * (config.json — never an env var), which validates to `'process'` today;
 * `'worktree'` is a reserved knob value whose backend lands with MC-A2, so
 * resolving it before then fails with a clear error instead of silently
 * falling back to a non-isolated runtime.
 */

import { getCliKnobs } from '../config/config.js';
import { normalizeRuntimeBackend } from '../config/configTypes.js';
import type { RuntimeBackendKind } from '../config/configTypes.js';
import type { IAgentRuntime, RuntimeTurnExecutor } from './runtimeTypes.js';
import { createProcessRuntime } from './backends/process.js';

export interface ResolveRuntimeOptions {
  /** Turn-execution seam handed to the backend (production: `agentTurnExecutor(agent)`). */
  executeTurn: RuntimeTurnExecutor;
}

export type RuntimeFactory = (options: ResolveRuntimeOptions) => IAgentRuntime;

const factories = new Map<RuntimeBackendKind, RuntimeFactory>();

/** Register (or override — tests) the factory for a backend kind. */
export function registerRuntimeBackend(kind: RuntimeBackendKind, factory: RuntimeFactory): void {
  factories.set(kind, factory);
}

/** Backend kinds with a registered factory (not the full knob-value space). */
export function availableRuntimeBackends(): RuntimeBackendKind[] {
  return [...factories.keys()];
}

// The one backend that exists in MC-A1. `worktree` registers in MC-A2.
registerRuntimeBackend('process', (options) => createProcessRuntime({ executeTurn: options.executeTurn }));

/**
 * Obtain a runtime for `kind` (default: the `cli.runtime.backend` knob).
 * Unknown strings normalize to `'process'` (validated knob semantics); a
 * VALID kind without a registered backend is an explicit error.
 */
export function resolveRuntime(options: ResolveRuntimeOptions, kind?: string): IAgentRuntime {
  const resolved: RuntimeBackendKind = kind === undefined
    ? getCliKnobs().runtime.backend
    : normalizeRuntimeBackend(kind);
  const factory = factories.get(resolved);
  if (!factory) {
    throw new Error(
      `runtime backend '${resolved}' is not available yet (registered: ${availableRuntimeBackends().join(', ') || 'none'})`,
    );
  }
  return factory(options);
}
