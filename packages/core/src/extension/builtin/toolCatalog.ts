import type { AccessMode, ActionKind } from '../../exec/policy/execPolicy.js';

/**
 * CODEX-TOOL-REGISTRY (0.4.7) — one declarative contract per access-gated tool.
 *
 * Each declaration is activated by exactly one required capability extension;
 * exposure, policy, parallel safety, schema, and execution ownership converge
 * through that extension executor.
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
 * Dynamic delegate names resolve through the `delegate_agent` declaration's
 * prefix metadata, so even per-agent tools stay extension-owned.
 */
export interface LocalToolEntry {
  name: string;
  /** Lowest access mode that exposes the tool (read ⊂ write ⊂ shell). */
  accessTier: AccessMode;
  /** Execution action kind — must equal `actionKindForTool(name)`. */
  actionKind: ActionKind;
  /** Safe to dispatch concurrently within one assistant message. */
  parallelSafe: boolean;
  /** Optional turn-scoped visibility predicate owned by the extension. */
  availability?: 'result-cache' | 'active-workflow' | 'active-orchestration-plan' | 'root-agent' | 'computer-use' | 'browser-use' | 'terminal-use' | 'multi-profile' | 'mcp-discovery';
  advertised?: boolean;
  runtimePort?: 'orchestration' | 'browser-control' | 'session-input';
  audited?: boolean;
  workflowLaunch?: boolean;
  afterInvoke?: 'track-automation' | 'goal-reconcile' | 'plan-update' | 'steer-reconcile';
  childAccessPolicy?: 'single' | 'batch';
  /** Resolve per-turn synthesized tool names through this extension executor. */
  dynamicNamePrefix?: string;
}

export const REQUIRED_CORE_TOOL_CATALOG: LocalToolEntry[] = [
  // --- read tier: always available (no workspace mutation) ----------------
  { name: 'read_file', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'list_dir', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'grep_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'glob_files', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'fetch_url', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'web_search', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  // §5.2 — research ledger tools persist session state (research.json), like
  // update_plan / artifact_write: read tier, read_only, serialized (not parallel).
  { name: 'research_note', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'research_brief', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'list_mcp_resources', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'list_mcp_resource_templates', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'read_mcp_resource', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  // MCP progressive discovery (§5.4) — search/describe the catalog cheaply, then
  // call by name through the SAME approval gate as a direct MCP call. mcp_call is
  // `network` (allowed in every mode, like normal MCP calls); the rest are reads.
  { name: 'mcp_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true, availability: 'mcp-discovery' },
  { name: 'mcp_describe', accessTier: 'read', actionKind: 'read_only', parallelSafe: true, availability: 'mcp-discovery' },
  { name: 'mcp_call', accessTier: 'read', actionKind: 'network', parallelSafe: false, availability: 'mcp-discovery' },
  { name: 'mcp_refresh_catalog', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'mcp-discovery' },
  { name: 'lsp', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'extract_result', accessTier: 'read', actionKind: 'read_only', parallelSafe: true, availability: 'result-cache' },
  { name: 'reconcile_steer', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, afterInvoke: 'steer-reconcile' },
  { name: 'update_plan', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, afterInvoke: 'plan-update' },
  { name: 'goal_complete', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, afterInvoke: 'goal-reconcile' },
  { name: 'goal_blocked', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'ask_user_choice', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // Track mode — the project board is workspace STATE (track.json), like the plan,
  // so both are read-tier / read_only (no repo mutation, no approval). The agent
  // can manage the board in any mode (the code-aware differentiator).
  { name: 'track_query', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'track_update', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, afterInvoke: 'track-automation' },
  // Connectors — listing configured connectors is a read of workspace state
  // (connectors.json); running one is shell-tier (network I/O + memory writes),
  // registered further below with the command-execution surface.
  { name: 'connector_list', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  // ADR-028 D6 — the planner. Reads are read-tier and parallel-safe; writes are
  // not parallel-safe because two concurrent writes to the same user-scoped
  // file would each read-modify-write and one would lose.
  { name: 'planner_today', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'planner_find', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  // Writes are `file_edit`: the planner cache IS a file, and classifying them
  // as read-only would exempt them from the write policy that governs every
  // other durable mutation.
  { name: 'planner_add', accessTier: 'read', actionKind: 'file_edit', parallelSafe: false },
  { name: 'planner_schedule', accessTier: 'read', actionKind: 'file_edit', parallelSafe: false },
  { name: 'planner_complete', accessTier: 'read', actionKind: 'file_edit', parallelSafe: false },
  // Pentest findings and finalization write only to the isolated review state;
  // the pentest runtime's allowlist is the security boundary around them.
  { name: 'file_vulnerability', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'finish_scan', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'list_requests', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'view_request', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'repeat_request', accessTier: 'read', actionKind: 'network', parallelSafe: false },
  { name: 'list_sitemap', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'scope_rules', accessTier: 'read', actionKind: 'network', parallelSafe: false },
  // Orchestration surface (added dynamically as specs, but access-gated here).
  // NB: child-spawn action kind is resolved per-call from the requested child
  // `access` (REVIEW-FIX); `child_write` is the name-only default they share.
  { name: 'profile_stage', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'active-orchestration-plan', runtimePort: 'orchestration' },
  { name: 'task_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true, runtimePort: 'orchestration', childAccessPolicy: 'single' },
  { name: 'delegate_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true, runtimePort: 'orchestration', childAccessPolicy: 'single', dynamicNamePrefix: 'delegate_' },
  { name: 'spawn_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration', advertised: false, childAccessPolicy: 'single' },
  { name: 'spawn_agents', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration', advertised: false, childAccessPolicy: 'batch' },
  { name: 'list_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'wait_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'wait_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'read_agent_transcript', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'close_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'send_input', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'resume_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration' },
  { name: 'route_task', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, runtimePort: 'orchestration' },
  // CC-P11.2 — blocking observer; waiting mutates nothing.
  { name: 'wait_until', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // CC-P11.1 — incremental reader for background run_command logs.
  { name: 'task_output', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // CC-P12.3 — transcript chapter marker (writes session state, not workspace).
  { name: 'mark_chapter', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // MC-D3 — agent-initiated switch to a named LLM profile. Mutates session
  // state only (the active model preset), so it gates like update_plan:
  // read tier, read_only kind, serialized. Exposure is further runtime-gated
  // in Agent.runTurn to installs with 2+ configured `cli.llmProfiles`.
  { name: 'switch_model', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'multi-profile' },
  // WF-TOOL — run_workflow launches a fan-out of child agents (child_write), like spawn_*.
  { name: 'run_workflow', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration', workflowLaunch: true },
  // §7 L4 — run_workflow_graph runs a saved visual graph; its agent nodes spawn children (child_write).
  { name: 'run_workflow_graph', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, runtimePort: 'orchestration', workflowLaunch: true },
  { name: 'workflow_progress', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'active-workflow' },
  // §AV-4 — artifact_write persists an Artifact Record (BrainRouter state, not
  // workspace source), so it gates like update_plan / mark_chapter: read tier,
  // read_only action kind, no approval. Not parallel-safe (serialized JSON store).
  { name: 'artifact_write', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // Worker-thread surface — durable, detached background agents the model can
  // launch from a prompt (like spawn_agents, but outliving the turn). Exposure
  // is further gated to depth-0 / non-worker tier in Agent.runTurn (workers
  // can't spawn workers). spawn gates as child_write; the rest are observers.
  { name: 'spawn_worker_thread', accessTier: 'read', actionKind: 'child_write', parallelSafe: false, availability: 'root-agent' },
  { name: 'wait_worker', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'root-agent' },
  { name: 'read_worker_summary', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'root-agent' },
  { name: 'close_worker', accessTier: 'read', actionKind: 'read_only', parallelSafe: false, availability: 'root-agent' },
  // --- write tier: + structured file edits --------------------------------
  { name: 'write_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'edit_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'apply_patch', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'notebook_edit', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  // --- shell tier: + command execution ------------------------------------
  { name: 'run_command', accessTier: 'shell', actionKind: 'shell', parallelSafe: false },
  { name: 'kill_command', accessTier: 'shell', actionKind: 'shell', parallelSafe: false },
  { name: 'terminal_list', accessTier: 'shell', actionKind: 'read_only', parallelSafe: true, availability: 'terminal-use' },
  { name: 'terminal_read', accessTier: 'shell', actionKind: 'read_only', parallelSafe: true, availability: 'terminal-use' },
  { name: 'terminal_write', accessTier: 'shell', actionKind: 'shell', parallelSafe: false, availability: 'terminal-use' },
  { name: 'computer_use', accessTier: 'shell', actionKind: 'computer', parallelSafe: false, availability: 'computer-use' },
  // connector_run performs network ingestion + memory writes, so it's gated to
  // shell tier (exposure) like command execution; its ActionKind is `network`
  // (the same not-mode-gated kind as fetch_url / MCP calls) so it can execute
  // once exposed. Never parallel-safe (serialized connector-store writes).
  { name: 'connector_run', accessTier: 'shell', actionKind: 'network', parallelSafe: false },
];

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
 * The MCP progressive-discovery entry points (§5.4). Registered like any read
 * tool, but only exposed to the model when `cli.mcpProgressiveDiscovery` is on
 * (the agent hides them otherwise so default behaviour is unchanged).
 */
export const MCP_DISCOVERY_TOOLS = new Set([
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_refresh_catalog',
]);

/**
 * Whether to hide the worker-thread surface from an agent. Workers can't spawn
 * workers (`MAX_WORKER_DEPTH = 1`) and a child agent owns no workers of its own,
 * so only a depth-0, non-worker orchestrator should see these tools — everyone
 * else would only ever see tools that throw. Pure → unit-tested.
 */
