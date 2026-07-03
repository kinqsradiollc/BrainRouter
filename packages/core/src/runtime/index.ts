// Public entrypoint for the `runtime` subsystem (MC-A1) — the runtime PLANE:
// where an agent conversation runs. Consumers import
// `@kinqs/brainrouter-core/runtime`; the file layout stays an internal detail.
//
// MC-A1 ships the port (`IAgentRuntime`), the `process` backend (today's
// in-process execution wrapped with zero behavior change), the backend
// registry/factory (`resolveRuntime`), and the minimal durable instance-state
// store. Isolated backends (worktree/container/remote) slot in behind the
// same port in later milestones.
export * from './runtimeTypes.js';
export * from './registry.js';
export * from './backends/process.js';
export * from './state/runtimeStateStore.js';
