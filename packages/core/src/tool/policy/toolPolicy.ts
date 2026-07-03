/**
 * Per-tool enable/disable policy — the `cli.toolOverrides` knob made effective.
 *
 * The agent's tool surface is built in layers: HARD gates (access tier,
 * worker-thread / computer-use capability, model-hidden) decide what the agent is
 * even ALLOWED to call, then SOFT gates (the local-model L2 allowlist, the MCP
 * relevance budget) trim what's worth showing. User overrides flip only the SOFT
 * layer — they can re-enable a tool the L2 allowlist hid, or hide a noisy one — but
 * they can NEVER bypass a hard gate (a read-only agent can't be handed
 * `run_command` via an override), and they can never disable a PROTECTED core tool.
 */

/**
 * Tools the user cannot force-disable: turn-control lifecycle + the file/shell
 * working core. Disabling these would brick most workflows, so a `false` override
 * is ignored for them. (They are still subject to the HARD access-tier gate —
 * protection only means "the toggle can't turn it off", not "always granted".)
 */
export const PROTECTED_CORE_TOOLS: ReadonlySet<string> = new Set<string>([
  // turn control / lifecycle
  'update_plan',
  'goal_complete',
  'goal_blocked',
  'ask_user_choice',
  'extract_result',
  'mark_chapter',
  'task_output',
  // file + search + edit + shell core (read + edit + run)
  'read_file',
  'write_file',
  'list_dir',
  'grep_search',
  'glob_files',
  'edit_file',
  'apply_patch',
  'run_command',
]);

export function isProtectedCoreTool(name: string): boolean {
  return PROTECTED_CORE_TOOLS.has(name);
}

/**
 * Apply the user override to a tool that has ALREADY passed its hard gate.
 * `softVisible` is the tool's default visibility from the soft layers (L2 allowlist
 * / MCP budget). Returns the final visibility:
 *   - override `false` → hidden, UNLESS the tool is protected (then unchanged).
 *   - override `true`  → shown (re-enables an L2-hidden / budget-trimmed tool).
 *   - no override      → `softVisible` unchanged.
 */
export function resolveToolVisible(
  name: string,
  softVisible: boolean,
  overrides: Record<string, boolean>,
): boolean {
  const ov = overrides[name];
  if (ov === false) return isProtectedCoreTool(name) ? softVisible : false;
  if (ov === true) return true;
  return softVisible;
}
