// 0.3.8-R4 — Single source of truth for which tool calls are safe to
// dispatch concurrently within one LLM response.
//
// Pre-R4 the runtime executed every tool call from one assistant message
// strictly serially. That's safe but it's pure latency loss for the common
// case of "read 5 files in one turn" — none of those reads share state or
// depend on each other's results. Writes and shell commands still need to
// serialize to preserve causality.
//
// `isParallelSafe(toolName)` is the conservative whitelist. Anything not on
// the list is treated as serial — the failure mode is "we ran something
// sequentially that could have been concurrent," which is the same
// performance the pre-R4 code shipped with. Adding tools here is the only
// way to opt them in.

/**
 * Local read-only tools whose execution is independent and has no
 * observable side effect on the workspace, on child-session state, or on
 * the agent's own bookkeeping. These can run concurrently within a single
 * LLM response.
 *
 * Explicitly EXCLUDED (must stay serial):
 *   - write_file / edit_file / apply_patch / run_command  — workspace mutation.
 *   - spawn_agent / spawn_agents / task_agent / delegate_agent
 *     / wait_agent / wait_agents / close_agent / route_agent
 *     / read_agent_transcript  — orchestration / child-session mutation.
 *     (R1's child-drain guardrail tracks every spawn/wait one-by-one;
 *     running them in parallel would let bookkeeping diverge.)
 *   - update_plan / goal_complete / goal_blocked  — session state mutation.
 *   - ask_user_choice  — interactive picker; must not interleave with other UI.
 *   - list_agents  — reads orchestration state but classified serial out of
 *     caution; cheap and rarely batched.
 */
const PARALLEL_SAFE_LOCAL_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'grep_search',
  'glob_files',
  'fetch_url',
  'web_search',
]);

/**
 * MCP read tools — bare tool names (without the `mcp_<server>_` prefix)
 * that BrainRouter knows to be read-only. The pool exposes both the
 * legacy double-underscore `mcp__<server>__<tool>` shape and the R5
 * single-underscore `mcp_<server>_<tool>` shape; isParallelSafe accepts
 * either. Survives identity / profile renames because the prefix is
 * matched structurally, not by literal string.
 */
const PARALLEL_SAFE_MCP_READ_TOOLS = new Set<string>([
  'memory_recall',
  'memory_search',
  'memory_file_history',
  'memory_task_state',
  'memory_contradictions',
  'memory_inspect',
  'memory_list_records',
]);

/**
 * True iff `toolName` is on the conservative parallel-safe whitelist.
 * Accepts both the bare local tool name (`read_file`) and the MCP-prefixed
 * forms (`mcp__brainrouter__memory_recall`, `mcp_brainrouter_memory_recall`).
 * Anything else — including any unknown tool name — returns false so the
 * caller falls back to safe serial execution.
 */
export function isParallelSafe(toolName: string): boolean {
  if (!toolName) return false;
  if (PARALLEL_SAFE_LOCAL_TOOLS.has(toolName)) return true;
  const bare = stripMcpPrefix(toolName);
  if (bare && PARALLEL_SAFE_MCP_READ_TOOLS.has(bare)) return true;
  return false;
}

/** Companion to `isParallelSafe` — true iff the name resolves to a known MCP read tool. */
export function isMcpReadTool(toolName: string): boolean {
  const bare = stripMcpPrefix(toolName);
  return !!bare && PARALLEL_SAFE_MCP_READ_TOOLS.has(bare);
}

function stripMcpPrefix(name: string): string | undefined {
  // Legacy double-underscore shape: mcp__<server>__<tool>.
  if (name.startsWith('mcp__')) {
    const idx = name.indexOf('__', 'mcp__'.length);
    if (idx >= 0) return name.slice(idx + 2);
  }
  // R5 single-underscore shape: mcp_<server>_<tool>. Server names may
  // contain underscores so we suffix-match against known bare tools
  // instead of guessing where the server segment ends.
  if (name.startsWith('mcp_')) {
    for (const known of PARALLEL_SAFE_MCP_READ_TOOLS) {
      if (name.endsWith('_' + known)) return known;
    }
  }
  return undefined;
}

/**
 * Kill switch: `BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS=false` (or `0`/`off`/`no`)
 * forces every batch back to strict serial execution — the pre-R4 shape.
 * Useful when debugging an issue and you want to rule out concurrency, or
 * when running against an LLM provider that rate-limits tool dispatch.
 */
export function parallelExecutionEnabled(): boolean {
  const raw = (process.env.BRAINROUTER_PARALLEL_SAFE_TOOL_CALLS ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return true;
}
