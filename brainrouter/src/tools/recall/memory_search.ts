import { z } from 'zod';
import type { RecalledMemory } from '@kinqs/brainrouter-types';
import { memoryEngine } from '../../memory/engine.js';
import { preferCallerScope, type ScopeMatch } from '../../memory/scope.js';

/** Results when the caller does not say. The schema has always promised 10. */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
/** A search is a lookup, not an export. */
export const MEMORY_SEARCH_MAX_LIMIT = 50;
/**
 * One hit's content, at most. A search answers "which records match", and a
 * record long enough to need more than this is one to open, not to inline —
 * the unbounded version of this tool once returned 126 KB for one question.
 */
export const MEMORY_SEARCH_MAX_HIT_CHARS = 1_200;

export const memorySearchToolSchema = {
  name: 'memory_search',
  description:
    'Perform a semantic or keyword search across memory records. ' +
    'Use this when automatic recall was insufficient. ' +
    'Results are ranked by where they came from — this session, then this workspace, then untagged records, ' +
    'then other workspaces — and every hit carries `scopeMatch` so you can tell a record about THIS repository ' +
    'from one about another. Nothing is hidden. The client fills in the session and workspace; you do not need to. ' +
    'Optionally pass `asOf` (ISO 8601) to query what memories were valid at a specific point in time, ' +
    'or `filters` to narrow by type / scene / time window / priority / skillTag.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier for isolation' },
      query: { type: 'string', description: 'Search query' },
      sessionKey: { type: 'string', description: 'Session identifier. Filled in by the client.' },
      workspaceTag: { type: 'string', description: 'This workspace\'s identity (16-char hash). Filled in by the client.' },
      workspaceTags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every identity of this workspace — folder hash and repo hash. Filled in by the client.',
      },
      activeSkill: { type: 'string', description: 'Current active skill boost' },
      limit: { type: 'number', description: `Max results to return (default ${MEMORY_SEARCH_DEFAULT_LIMIT}, at most ${MEMORY_SEARCH_MAX_LIMIT}).` },
      asOf: {
        type: 'string',
        description:
          'Optional ISO 8601 timestamp for point-in-time recall. ' +
          'Returns memories that existed AND were valid at this moment. ' +
          'Example: "2025-03-15T12:00:00.000Z"',
      },
      filters: {
        type: 'object',
        description: 'Optional filters narrowing the candidate pool before ranking.',
        properties: {
          types: { type: 'array', items: { type: 'string' }, description: "Whitelist of memory types (e.g. ['instruction', 'feedback'])." },
          scenes: { type: 'array', items: { type: 'string' }, description: 'Whitelist of contextual focus scene names.' },
          capturedAfter: { type: 'string', description: 'ISO 8601 lower bound on created_time.' },
          capturedBefore: { type: 'string', description: 'ISO 8601 upper bound on created_time.' },
          minPriority: { type: 'number', description: 'Drop records whose stored priority is below this threshold (0-100).' },
          skillTag: { type: 'string', description: 'Restrict to records produced under this skill tag.' },
        },
      },
    },
    // A search with no session is a valid search: the Memory panel has none.
    // It simply cannot see another session's session-scoped records.
    required: ['query'],
  },
};

export const memorySearchSchema = z.object({
  userId: z.string().optional(),
  query: z.string(),
  sessionKey: z.string().optional(),
  workspaceTag: z.string().optional(),
  workspaceTags: z.array(z.string()).max(8).optional(),
  activeSkill: z.string().optional(),
  limit: z.number().int().positive().optional(),
  asOf: z.string().optional(),
  filters: z.object({
    types: z.array(z.string()).optional(),
    scenes: z.array(z.string()).optional(),
    capturedAfter: z.string().optional(),
    capturedBefore: z.string().optional(),
    minPriority: z.number().optional(),
    skillTag: z.string().optional(),
  }).optional(),
});

export async function handleMemorySearch(args: unknown, options?: { defaultUserId?: string; defaultOrgId?: string }) {
  const params = memorySearchSchema.parse(args);
  // An authenticated transport owns the tenant address. Retain the explicit
  // userId only for direct/legacy callers that do not provide that context.
  const effectiveUserId = options?.defaultUserId ?? params.userId ?? "default";

  try {
    // Point-in-time search path
    const limit = Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(1, params.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT));
    // Ranking by scope reorders what the search returned; it cannot promote a
    // record the search never surfaced. So ask for a wider pool than we will
    // show, then let this workspace's records take the slots.
    const pool = Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(limit * 3, 15));
    const callerScope = {
      sessionKey: params.sessionKey,
      workspaceTag: params.workspaceTag,
      workspaceTags: params.workspaceTags,
    };

    // Point-in-time search. The same preference as the live path — a
    // historical question about THIS repository should not be answered first
    // by another one — in the shape this path has always returned.
    if (params.asOf) {
      const result = await memoryEngine.searchAsOf(
        effectiveUserId,
        params.query,
        params.asOf,
        pool,
        options?.defaultOrgId,
        { includeProvenance: true },
      );
      const ranked = preferCallerScope(result.memories, callerScope).slice(0, limit);
      const compact = compactSearchResult(params.query, undefined, ranked);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asOf: result.asOf,
            count: compact.results,
            scope: compact.scope,
            memories: compact.recalledCognitiveMemories,
          }, null, 2),
        }],
      };
    }

    // Use the MCP session's pinned active org. Looking up the user's mutable
    // default here could cross partitions after an active-org switch.
    const filters = options?.defaultOrgId
      ? { ...(params.filters ?? {}), orgId: options.defaultOrgId }
      : params.filters;

    const result = await memoryEngine.recall({
      userId: effectiveUserId,
      sessionKey: params.sessionKey ?? '',
      query: params.query,
      activeSkill: params.activeSkill,
      filters,
      includeProvenance: true,
      // Order inside the pipeline too, so the pool is already scope-first.
      preferScope: callerScope,
      // How many to RETURN is this tool's contract; how much to RETRIEVE is
      // not. `ftsLimit`/`vecLimit` are left to the per-org recall settings, so
      // an admin's retrieval cap is never lifted by a search.
      limitsOverride: { topResults: pool, rerankPool: pool },
    });

    const ranked = preferCallerScope(result.recalledCognitiveMemories ?? [], callerScope).slice(0, limit);

    return {
      content: [{ type: 'text', text: JSON.stringify(compactSearchResult(params.query, result.recallStrategy, ranked), null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `memory_search failed: ${err.message}` }],
    };
  }
}

/**
 * What a search returns: the hits, and nothing that belongs in a system prompt.
 *
 * `memory_recall` exists to build prompt context, so it carries the core
 * identity, the focus navigation and the tools guide. A SEARCH answering the
 * same question returned all of that too, every call — the one-hit payload was
 * 7 KB, and with a large identity and graph block it reached 126 KB. The hits
 * keep the shape the CLI and the desktop already read (`recalledCognitiveMemories`),
 * minus the provenance hashes, which mean nothing to a reader: `scopeMatch` is
 * the useful form of them.
 */
export function compactSearchResult(
  query: string,
  recallStrategy: string | undefined,
  hits: ReadonlyArray<RecalledMemory & { scopeMatch: ScopeMatch }>,
) {
  const scope = { session: 0, workspace: 0, untagged: 0, otherWorkspace: 0 };
  const recalledCognitiveMemories = hits.map((hit) => {
    if (hit.scopeMatch === 'other-workspace') scope.otherWorkspace += 1;
    else scope[hit.scopeMatch] += 1;
    const { workspaceTag: _tag, sessionKey: _session, content, ...rest } = hit;
    const truncated = content.length > MEMORY_SEARCH_MAX_HIT_CHARS;
    return {
      ...rest,
      content: truncated
        ? `${content.slice(0, MEMORY_SEARCH_MAX_HIT_CHARS)}… [truncated, ${content.length} chars]`
        : content,
    };
  });
  return {
    query,
    ...(recallStrategy ? { recallStrategy } : {}),
    results: recalledCognitiveMemories.length,
    scope,
    recalledCognitiveMemories,
  };
}
