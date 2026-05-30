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
