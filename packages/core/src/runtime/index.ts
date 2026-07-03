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
// MC-A4 adds the runtime MANAGER: LRU parking under `cli.runtime.maxLive`,
// resume-by-id (in-process, worktree re-attach, process re-host), and boot
// reconcile of records a dead process left live-ish.
// MC-A6 adds WORKSPACE ARCHIVES: worktree dispose writes a durable
// patch + tarball + manifest under the runtime archives root
// (`cli.runtime.archiveOnDispose`), resumable via `resumeFromArchive` and
// bounded by `listArchives`/`pruneArchives` (`cli.runtime.archiveKeep`).
export * from './runtimeTypes.js';
export * from './registry.js';
export * from './backends/process.js';
export * from './backends/worktree.js';
export * from './state/runtimeStateStore.js';
export * from './manager.js';
export * from './archive.js';
