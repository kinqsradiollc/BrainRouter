/**
 * T2/T3 — workspace identity on the event stream.
 *
 * main tags every `agent-event` it pipes with the originating host's
 * `workspaceRoot`. The renderer tracks the ACTIVE workspace (from the
 * authoritative `session-changed`) and drops events from any other workspace
 * generation — so a chat/turn from workspace A can never paint into workspace
 * B's surfaces. Pure + unit-tested; the renderer just applies it.
 */
export interface WorkspaceTaggedMessage {
  /** Injected by main from the owning host's pair; absent on legacy/untagged events. */
  workspaceRoot?: string;
  sessionKey?: string;
  event?: { kind?: string };
}

/**
 * Should this event be dropped because it belongs to a different workspace than
 * the one on screen? Conservative: only drops when BOTH the event is tagged AND
 * an active workspace is established AND they differ. Untagged events (or before
 * the first session-changed) always pass, so existing single-host flow is
 * unaffected — this only bites once multiple workspaces are live (T2).
 *
 * `session-changed` is NEVER stale: it is the authoritative switch signal that
 * REDEFINES the active workspace, so it must always be processed (otherwise the
 * active workspace could never advance past the first one).
 */
export function isStaleWorkspaceEvent(msg: WorkspaceTaggedMessage, activeWorkspace: string | null): boolean {
  if (msg.event?.kind === 'session-changed') return false;
  if (!msg.workspaceRoot || !activeWorkspace) return false;
  return msg.workspaceRoot !== activeWorkspace;
}

/**
 * The active workspace after applying an event: a `session-changed` carrying a
 * workspaceRoot is the authoritative switch signal and updates it; every other
 * event leaves it unchanged.
 */
export function nextActiveWorkspace(
  msg: WorkspaceTaggedMessage,
  current: string | null,
): string | null {
  if (msg.event?.kind === 'session-changed' && msg.workspaceRoot) return msg.workspaceRoot;
  return current;
}

/**
 * Did a session-changed land us in a DIFFERENT workspace than before? Drives the
 * refresh tier: a workspace change needs the FULL workspace/git refresh (branches,
 * git-info, changed-files, PR, log) so branch state doesn't vanish; a same-
 * workspace session change only needs the light refresh (git is identical across
 * chats in one workspace). Untagged / first event → treat as a workspace change
 * so the initial git state always loads.
 */
export function workspaceChanged(eventWorkspace: string | undefined, prevWorkspace: string | null): boolean {
  if (!eventWorkspace) return false;        // untagged → caller keeps its current tier
  return eventWorkspace !== prevWorkspace;  // includes prev === null (boot/first switch)
}
