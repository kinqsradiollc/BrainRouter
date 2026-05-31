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
export type ActionKind = 'read_only' | 'file_edit' | 'child_write' | 'shell' | 'network' | 'bg';
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
      return 'child_write';
    case 'fetch_url':
      return 'network';
    default:
      // Observation / planning orchestration tools (wait_*, list_agents,
      // route_task, read_agent_transcript, close_*) + MCP reads → read-only.
      return 'read_only';
  }
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
 */
export function resolveToolPolicy(name: string, mode: AccessMode): ToolPolicyResult {
  const action = actionKindForTool(name);
  const { decision, reason } = decideExecutionPolicy(action, mode);
  const mutating = action === 'file_edit' || action === 'child_write' || action === 'shell';
  return { action, decision, reason, mutating };
}
