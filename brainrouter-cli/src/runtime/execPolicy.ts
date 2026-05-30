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
 * POLICY-1 (0.4.4) — map a built-in tool name to the execution ActionKind it
 * represents, so the agent can route EVERY mutating tool (not just the shell)
 * through `decideExecutionPolicy`. Anything not listed is treated as read-only
 * (the safe default — read-only is always permitted, so an unrecognised tool is
 * never wrongly allowed to mutate).
 */
export function actionKindForTool(name: string): ActionKind {
  switch (name) {
    case 'run_command':
      return 'shell';
    case 'write_file':
    case 'edit_file':
    case 'apply_patch':
      return 'file_edit';
    case 'spawn_agent':
    case 'spawn_agents':
    case 'spawn_worker_thread':
      return 'child_write';
    case 'fetch_url':
      return 'network';
    default:
      return 'read_only';
  }
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
