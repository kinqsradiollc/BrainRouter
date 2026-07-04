/**
 * MC-A1 — runtime backend registry + factory.
 *
 * `resolveRuntime(kind, options)` is the single place callers obtain a
 * runtime instance. The kind defaults from the `cli.runtime.backend` knob
 * (config.json — never an env var). A VALID kind without a registered
 * backend fails with a clear error instead of silently falling back to a
 * non-isolated runtime.
 */

import { getCliKnobs } from '../config/config.js';
import { normalizeRuntimeBackend } from '../config/configTypes.js';
import type { RuntimeBackendKind } from '../config/configTypes.js';
import type { IAgentRuntime, RuntimeTurnExecutor } from './runtimeTypes.js';
import { createContainerRuntime } from './backends/container.js';
import { createProcessRuntime } from './backends/process.js';
import { createWorktreeRuntime } from './backends/worktree.js';

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

// Built-in backends: `process` (MC-A1 — in-process host execution, the
// default), `worktree` (MC-A2 — isolated git-worktree runtime, opt-in via
// `cli.runtime.backend`), and `container` (MC-A3 — docker-CLI isolated
// runtime; resolving the kind is cheap, but `start()` stays strictly opt-in:
// it refuses to run without `cli.runtime.containerImage` and never pulls).
registerRuntimeBackend('process', (options) => createProcessRuntime({ executeTurn: options.executeTurn }));
registerRuntimeBackend('worktree', (options) => createWorktreeRuntime({ executeTurn: options.executeTurn }));
registerRuntimeBackend('container', (options) => createContainerRuntime({ executeTurn: options.executeTurn }));

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
