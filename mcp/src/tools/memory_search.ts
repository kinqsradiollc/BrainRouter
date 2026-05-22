import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';

export const memorySearchToolSchema = {
  name: 'memory_search',
  description:
    'Perform a semantic or keyword search across memory records. ' +
    'Use this when automatic recall was insufficient. ' +
    'Optionally pass `asOf` (ISO 8601) to query what memories were valid at a specific point in time, ' +
    'or `filters` to narrow by type / scene / time window / priority / skillTag.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier for isolation' },
      query: { type: 'string', description: 'Search query' },
      sessionKey: { type: 'string', description: 'Session identifier' },
      activeSkill: { type: 'string', description: 'Current active skill boost' },
      limit: { type: 'number', description: 'Max results to return (default 10)' },
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
    required: ['query', 'sessionKey'],
  },
};

export const memorySearchSchema = z.object({
  userId: z.string().optional(),
  query: z.string(),
  sessionKey: z.string(),
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

export async function handleMemorySearch(args: unknown, options?: { defaultUserId?: string }) {
  const params = memorySearchSchema.parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    // Point-in-time search path
    if (params.asOf) {
      const result = memoryEngine.searchAsOf(
        effectiveUserId,
        params.query,
        params.asOf,
        params.limit ?? 10
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    // Standard recall path
    const result = await memoryEngine.recall({
      userId: effectiveUserId,
      sessionKey: params.sessionKey,
      query: params.query,
      activeSkill: params.activeSkill,
      filters: params.filters,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `memory_search failed: ${err.message}` }],
    };
  }
}
