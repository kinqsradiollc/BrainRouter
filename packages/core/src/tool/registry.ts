import type { AccessMode, ActionKind } from '../exec/execPolicy.js';

/**
 * CODEX-TOOL-REGISTRY (0.4.7) — one declarative contract per access-gated tool.
 *
 * Before this, a tool's facts lived in FOUR separate places that could drift:
 *   - model-visible spec      → `LOCAL_TOOLS` (tools/specs.ts)
 *   - exposure per access mode → `Agent.allowedToolsForAccess()` (hard-coded sets)
 *   - execution action kind    → `actionKindForTool()` (execPolicy.ts)
 *   - parallel-dispatch safety → `PARALLEL_SAFE_LOCAL_TOOLS` (toolSafety.ts)
 * That drift was the root cause of the REVIEW-FIX bug (a tool exposed in read
 * mode but action-kind'd as `child_write`, so it was denied). Codex keeps one
 * `ToolExecutor` entry per tool (`tool_executor.rs:35/51`).
 *
 * This registry is the single source for the access-gated surface: the agent's
 * exposure set is now GENERATED from `accessTier` here, and a guard test
 * (`tool-registry.test.ts`) fails on any registry↔policy↔parallel mismatch.
 *
 * Scope note: the worker-thread tools (`spawn_worker_thread`, `wait_worker`,
 * `read_worker_summary`, `close_worker`) ARE registered here so the model can
 * see and call them, but their exposure is further gated at runtime to depth-0 /
 * non-worker-tier agents (workers can't spawn workers) — see `Agent.runTurn`.
 * Other dynamic tools (`extract_result`, `workflow_progress`) remain a separate
 * goal-scoped surface and are the guard test's known registry exceptions.
 */
export interface LocalToolEntry {
  name: string;
  /** Lowest access mode that exposes the tool (read ⊂ write ⊂ shell). */
  accessTier: AccessMode;
  /** Execution action kind — must equal `actionKindForTool(name)`. */
  actionKind: ActionKind;
  /** Safe to dispatch concurrently within one assistant message. */
  parallelSafe: boolean;
}

export const LOCAL_TOOL_REGISTRY: LocalToolEntry[] = [
  // --- read tier: always available (no workspace mutation) ----------------
  { name: 'read_file', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'list_dir', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'grep_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'glob_files', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'fetch_url', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'web_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'lsp', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'update_plan', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'goal_complete', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'goal_blocked', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'ask_user_choice', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // Orchestration surface (added dynamically as specs, but access-gated here).
  // NB: child-spawn action kind is resolved per-call from the requested child
  // `access` (REVIEW-FIX); `child_write` is the name-only default they share.
  { name: 'task_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true },
  { name: 'delegate_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true },
  { name: 'spawn_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  { name: 'spawn_agents', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  { name: 'list_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'wait_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'wait_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'read_agent_transcript', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'close_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'route_task', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // CC-P11.2 — blocking observer; waiting mutates nothing.
  { name: 'wait_until', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // CC-P11.1 — incremental reader for background run_command logs.
  { name: 'task_output', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // CC-P12.3 — transcript chapter marker (writes session state, not workspace).
  { name: 'mark_chapter', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // WF-TOOL — run_workflow launches a fan-out of child agents (child_write), like spawn_*.
  { name: 'run_workflow', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  // §AV-4 — artifact_write persists an Artifact Record (BrainRouter state, not
  // workspace source), so it gates like update_plan / mark_chapter: read tier,
  // read_only action kind, no approval. Not parallel-safe (serialized JSON store).
  { name: 'artifact_write', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // Worker-thread surface — durable, detached background agents the model can
  // launch from a prompt (like spawn_agents, but outliving the turn). Exposure
  // is further gated to depth-0 / non-worker tier in Agent.runTurn (workers
  // can't spawn workers). spawn gates as child_write; the rest are observers.
  { name: 'spawn_worker_thread', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  { name: 'wait_worker', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'read_worker_summary', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'close_worker', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // --- write tier: + structured file edits --------------------------------
  { name: 'write_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'edit_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'apply_patch', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  // --- shell tier: + command execution ------------------------------------
  { name: 'run_command', accessTier: 'shell', actionKind: 'shell', parallelSafe: false },
];

const TIER_RANK: Record<AccessMode, number> = { read: 0, write: 1, shell: 2 };

/**
 * The model-visible tool set for an access mode, GENERATED from the registry:
 * every tool whose `accessTier` is at or below `mode`. This is the single
 * definition `Agent.allowedToolsForAccess()` delegates to.
 */
export function registryAllowedTools(mode: AccessMode): Set<string> {
  const ceiling = TIER_RANK[mode];
  return new Set(LOCAL_TOOL_REGISTRY.filter((t) => TIER_RANK[t.accessTier] <= ceiling).map((t) => t.name));
}

/** The parallel-safe local tools, generated from the registry. */
export function registryParallelSafeLocal(): Set<string> {
  return new Set(LOCAL_TOOL_REGISTRY.filter((t) => t.parallelSafe).map((t) => t.name));
}

/**
 * The worker-thread tool surface. Registered (so the model can call them) but
 * exposure is runtime-gated by `hideWorkerToolsFor` — see `Agent.runTurn`.
 */
export const WORKER_THREAD_TOOLS = new Set([
  'spawn_worker_thread',
  'wait_worker',
  'read_worker_summary',
  'close_worker',
]);

/**
 * Whether to hide the worker-thread surface from an agent. Workers can't spawn
 * workers (`MAX_WORKER_DEPTH = 1`) and a child agent owns no workers of its own,
 * so only a depth-0, non-worker orchestrator should see these tools — everyone
 * else would only ever see tools that throw. Pure → unit-tested.
 */
export function hideWorkerToolsFor(depth: number, tier?: string): boolean {
  return depth > 0 || tier === 'worker';
}

/** Lookup an entry by tool name. */
export function registryEntry(name: string): LocalToolEntry | undefined {
  return LOCAL_TOOL_REGISTRY.find((t) => t.name === name);
}
