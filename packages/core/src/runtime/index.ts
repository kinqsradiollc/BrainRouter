// Public entrypoint for the `runtime` subsystem (MC-A1) — the runtime PLANE:
// where an agent conversation runs. Consumers import
// `@kinqs/brainrouter-core/runtime`; the file layout stays an internal detail.
//
// MC-A1 ships the port (`IAgentRuntime`), the `process` backend (today's
// in-process execution wrapped with zero behavior change), the backend
// registry/factory (`resolveRuntime`), and the minimal durable instance-state
// store. MC-A2 adds the `worktree` backend — the existing git-worktree child
// isolation promoted to a first-class runtime (opt-in). Further isolated
// backends (container/remote) slot in behind the same port later.
export * from './runtimeTypes.js';
export * from './registry.js';
export * from './backends/process.js';
export * from './backends/worktree.js';
export * from './state/runtimeStateStore.js';
