/**
 * CLI-11 (0.4.3) — unified execution-policy decision.
 *
 * One pure place that maps (action kind, access mode) → allow / ask / deny
 * (+ reason), so shell, file edits, child writes, network, and `/bg` stop
 * deriving their own answer from scattered access-mode checks. This encodes
 * the SAME tiers the agent's allowed-tool set uses today (read → read-only;
 * write → + file edits; shell → + run_command):
 *
 *   read:  read-only allowed; everything mutating denied
 *   write: + file edits / child writes; shell still denied
 *   shell: everything allowed
 *
 * This is the decision core (tested in isolation). Routing every I/O path
 * through it — replacing the scattered checks in agent.ts — is the follow-up.
 */

export type AccessMode = 'read' | 'write' | 'shell';
export type ActionKind = 'read_only' | 'file_edit' | 'child_write' | 'shell' | 'computer' | 'network' | 'bg';
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

export function decideExecutionPolicy(action: ActionKind, mode: AccessMode): PolicyResult {
  switch (action) {
    case 'read_only':
      return { decision: 'allow', reason: 'read-only action — always permitted' };
    case 'network':
      // Not access-mode gated today (MCP/recall calls run in every mode).
      return { decision: 'allow', reason: 'network/MCP calls are not access-mode gated' };
    case 'bg':
      // Detaching a turn is a process concern; the turn's own actions are
      // already gated by this same policy.
      return { decision: 'allow', reason: 'detachment does not change capability' };
    case 'file_edit':
    case 'child_write':
      return mode === 'read'
        ? { decision: 'deny', reason: `access mode is "read" — ${action} not permitted` }
        : { decision: 'allow', reason: `access mode "${mode}" permits ${action}` };
    case 'shell':
      return mode === 'shell'
        ? { decision: 'allow', reason: 'access mode "shell" permits command execution' }
        : { decision: 'deny', reason: `command execution requires "shell" mode (current: "${mode}")` };
    case 'computer':
      return mode === 'shell'
        ? { decision: 'allow', reason: 'access mode "shell" permits local computer control' }
        : { decision: 'deny', reason: `computer control requires "shell" mode (current: "${mode}")` };
    default:
      return { decision: 'deny', reason: `unknown action kind` };
  }
}

/**
 * POLICY-1 / POLICY-2 (0.4.4) — map a built-in tool name to the execution
 * ActionKind it represents, so the agent can route EVERY tool (local AND
 * orchestration / worker / MCP — POLICY-2) through `decideExecutionPolicy`.
 * Anything not listed is treated as read-only (the safe default — read-only is
 * always permitted, so an unrecognised tool is never wrongly allowed to mutate;
 * MCP `memory_*`/etc. land here and are allowed in every mode).
 */
export function actionKindForTool(name: string): ActionKind {
  // POLICY-2 — synthesized `delegate_<id>` tools spawn a child agent.
  if (name.startsWith('delegate_')) return 'child_write';
  switch (name) {
    case 'run_command':
      return 'shell';
    case 'computer_use':
      return 'computer';
    case 'write_file':
    case 'edit_file':
    case 'apply_patch':
      return 'file_edit';
    // Child-spawning / delegation (orchestration + worker tools) all create a
    // potentially-writing child, so they gate as child_write (denied in read mode).
    case 'spawn_agent':
    case 'spawn_agents':
    case 'spawn_worker_thread':
    case 'task_agent':
    case 'delegate_agent':
    case 'run_workflow':
    case 'run_workflow_graph':
    case 'send_input':
    case 'resume_agent':
      return 'child_write';
    case 'fetch_url':
    case 'web_search':
    // mcp_call proxies a real MCP tool call (not access-mode gated, like other
    // MCP/recall calls); its handler re-applies the MCP approval gate.
    case 'mcp_call':
    // connector_run does network ingestion + memory writes; its shell-tier
    // exposure (registry) gates WHO sees it, `network` lets it execute once seen.
    case 'connector_run':
      return 'network';
    default:
      // Observation / planning orchestration tools (wait_*, list_agents,
      // route_task, read_agent_transcript, close_*) + MCP reads → read-only.
      return 'read_only';
  }
}

/** The child-spawning / delegation tools (orchestration + worker + synthesized). */
const CHILD_SPAWN_TOOLS = new Set([
  'spawn_agent',
  'spawn_agents',
  'spawn_worker_thread',
  'task_agent',
  'delegate_agent',
  'run_workflow',
  'send_input',
  'resume_agent',
]);

/** True for a tool that launches a child agent / worker. */
export function isChildSpawnTool(name: string): boolean {
  return name.startsWith('delegate_') || CHILD_SPAWN_TOOLS.has(name);
}

/**
 * Map a child's requested `access` to the ActionKind the *spawn* represents.
 * A child can only ever read → spawning it is a read-only fan-out; a write/shell
 * child gates as `child_write`/`shell`. An unspecified access falls back to
 * `child_write` — the safe, unchanged default (the spawn handler resolves the
 * real role default + clamps to the parent, so a missing arg never escalates).
 */
function accessToActionKind(access: unknown): ActionKind {
  switch (access) {
    case 'read':
      return 'read_only';
    case 'write':
      return 'child_write';
    case 'shell':
      return 'shell';
    default:
      return 'child_write';
  }
}

/**
 * REVIEW-FIX (0.4.7) — the action kind for a child-spawning tool depends on the
 * child's REQUESTED access, not just the tool name. This is the root-cause fix
 * for the policy bug where a **read-mode** parent could not fan out even an
 * `access:'read'` reviewer: `actionKindForTool` mapped every spawn to
 * `child_write` (denied in read mode) before the child's access was considered.
 *
 * With the call's args in hand: a single spawn maps from its `access`; a batch
 * `spawn_agents` maps from its **most-powerful** entry (shell > write > read);
 * everything else delegates to the name-only `actionKindForTool`. The
 * "child ≤ parent" invariant is preserved — the spawn handler additionally
 * clamps each child to the parent's mode (`clampAccess`).
 */
export function actionKindForToolCall(name: string, args?: Record<string, unknown> | null): ActionKind {
  // Batch spawn — the most-powerful requested child governs the gate.
  if (name === 'spawn_agents' && Array.isArray(args?.agents)) {
    const kinds = (args!.agents as unknown[]).map((e) =>
      accessToActionKind((e as { access?: unknown } | null)?.access));
    if (kinds.some((k) => k === 'shell')) return 'shell';
    if (kinds.some((k) => k === 'child_write')) return 'child_write';
    return kinds.length > 0 ? 'read_only' : 'child_write';
  }
  // Single spawn / delegate — the requested `access` arg determines the kind.
  if (isChildSpawnTool(name)) {
    return accessToActionKind(args?.access);
  }
  return actionKindForTool(name);
}

export type ExternalDirMode = 'deny' | 'ask' | 'allow';

/**
 * POLICY-3 (0.4.4) — gate writes that target paths OUTSIDE the workspace root.
 * Within-workspace writes are always allowed; an external target is decided by
 * the active profile's `externalDirWrites` mode (deny / ask / allow). Uses the
 * realpath-aware containment from MEM-36 so `..` / symlink escapes are caught.
 */
export function externalDirectoryDecision(
  targetPath: string,
  workspaceRoot: string,
  mode: ExternalDirMode,
  within: (target: string, roots: string[]) => boolean,
): PolicyResult {
  if (within(targetPath, [workspaceRoot])) {
    return { decision: 'allow', reason: 'write target is inside the workspace' };
  }
  switch (mode) {
    case 'allow':
      return { decision: 'allow', reason: 'external-directory writes permitted by policy profile' };
    case 'ask':
      return { decision: 'ask', reason: `write to "${targetPath}" is outside the workspace — approval required` };
    default:
      return { decision: 'deny', reason: `write to "${targetPath}" is outside the workspace — denied by policy profile` };
  }
}

/** Lowercased host of a URL, or '' when unparseable. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * POLICY-3 — per-host network egress decision. An EMPTY allowlist means "no
 * restriction" (current behavior — every host allowed). A non-empty allowlist
 * permits only its hosts (exact or dot-suffix subdomain match) and denies the
 * rest, so a profile can confine outbound `fetch_url` / `web_search` traffic.
 */
export function egressDecision(url: string, allowlist: string[]): PolicyResult {
  if (!allowlist || allowlist.length === 0) {
    return { decision: 'allow', reason: 'no egress allowlist configured — all hosts permitted' };
  }
  const host = hostOf(url);
  if (!host) return { decision: 'deny', reason: `unparseable URL — denied under an active egress allowlist` };
  const ok = allowlist.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^\*\./, '');
    return e !== '' && (host === e || host.endsWith(`.${e}`));
  });
  return ok
    ? { decision: 'allow', reason: `host "${host}" is on the egress allowlist` }
    : { decision: 'deny', reason: `host "${host}" is not on the egress allowlist` };
}

export interface ToolPolicyResult extends PolicyResult {
  action: ActionKind;
  /** True for actions that change state (file/child/shell) — i.e. worth auditing. */
  mutating: boolean;
}

/**
 * POLICY-1 — the unified policy decision for a tool given the session's access
 * mode: maps name → ActionKind → decision in one call. The single entry point
 * the agent's tool-dispatch guard uses.
 *
 * `args` (the tool call's arguments) lets child-spawn tools resolve their
 * action kind from the requested child `access` (REVIEW-FIX): an `access:'read'`
 * fan-out is read-only and thus permitted in read mode. Omit `args` for the
 * name-only decision (unchanged for every non-spawn tool).
 */
export function resolveToolPolicy(name: string, mode: AccessMode, args?: Record<string, unknown> | null): ToolPolicyResult {
  const action = actionKindForToolCall(name, args);
  const { decision, reason } = decideExecutionPolicy(action, mode);
  const mutating = action === 'file_edit' || action === 'child_write' || action === 'shell';
  return { action, decision, reason, mutating };
}
