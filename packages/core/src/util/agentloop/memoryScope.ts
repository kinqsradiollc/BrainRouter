/**
 * Point a model-issued memory read at where the agent actually is.
 *
 * `memory_search` and `memory_recall` rank by the caller's session and
 * workspace, but the model cannot know either: the session key is an opaque
 * id and the workspace identities are hashes of a path and a git remote. Left
 * to the model, the search was simply unscoped — a user-wide query that let a
 * record from an unrelated repository lead the answer, which is how a session
 * came to be handed 126 KB of another workspace's context.
 *
 * So the dispatcher fills them in, the same way `applyFederationIdentity`
 * fills in the federation key. It is safe to always do: on these two reads a
 * workspace scope is a PREFERENCE (rank here first, label the rest), never a
 * filter, so nothing the model could have found becomes unfindable.
 *
 * Only BrainRouter's own brain. `memory_search` is a common name among memory
 * servers, and adding arguments to a third party's tool can fail its schema.
 * Pure, so it unit-tests without a live brain.
 */

export interface MemoryCallScope {
  /** The agent's real session key — the one its turns are captured under. */
  sessionKey?: string;
  /** Every identity of the workspace — see memory/workspaceScope.ts. */
  workspaceTags?: readonly string[];
}

const SCOPED_READS = new Set(['memory_search', 'memory_recall']);

/**
 * `scope` may be a function: resolving the workspace's identities can shell out
 * to git, and every MCP call passes through here, so it is only resolved for
 * the two reads that use it.
 */
export function applyMemoryScope(
  rawName: string,
  args: unknown,
  scope: MemoryCallScope | (() => MemoryCallScope),
  isBrainRouterServer: boolean,
): unknown {
  if (!isBrainRouterServer || !SCOPED_READS.has(rawName)) return args;
  if (typeof scope === 'function') scope = scope();
  const base: Record<string, unknown> =
    args && typeof args === 'object' && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  if (scope.sessionKey) base.sessionKey = scope.sessionKey;
  if (scope.workspaceTags && scope.workspaceTags.length > 0) base.workspaceTags = [...scope.workspaceTags];
  return base;
}
