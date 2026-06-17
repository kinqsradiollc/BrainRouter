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

/**
 * Workspace GENERATION tagging for async query results. Each query id is sent as
 * `base#generation`; the generation bumps on every workspace switch. A result
 * whose generation no longer matches the current one is stale (it was in flight
 * when the user switched away) and must be dropped, so workspace A's late
 * list-sessions/git/files results can't paint into workspace B's surfaces.
 */
export function tagQueryId(baseId: string, generation: number): string {
  return `${baseId}#${generation}`;
}

export function parseQueryId(id: string): { base: string; generation: number | null } {
  const m = id.match(/^(.*)#(\d+)$/);
  return m ? { base: m[1], generation: Number(m[2]) } : { base: id, generation: null };
}

export function isStaleQueryResult(id: string, currentGeneration: number): boolean {
  const { generation } = parseQueryId(id);
  return generation !== null && generation !== currentGeneration;
}

/**
 * Item 4 — fold a tagged turn event into the set of WORKSPACES with a turn in
 * flight. Because the host pool keeps background work alive, the sidebar can
 * show a "running" dot on a project that isn't on screen. Must be applied
 * BEFORE the stale-workspace drop (above), since a background workspace's turn
 * events are exactly the ones that drop would discard. Returns the SAME set
 * reference when nothing changes, so it's a cheap no-op for the common case.
 */
export function nextRunningWorkspaces(
  current: Set<string>,
  eventKind: string | undefined,
  workspaceRoot: string | undefined,
): Set<string> {
  if (!workspaceRoot) return current;
  if (eventKind === 'turn-start') {
    return current.has(workspaceRoot) ? current : new Set(current).add(workspaceRoot);
  }
  if (eventKind === 'turn-complete' || eventKind === 'turn-error') {
    if (!current.has(workspaceRoot)) return current;
    const next = new Set(current);
    next.delete(workspaceRoot);
    return next;
  }
  return current;
}
