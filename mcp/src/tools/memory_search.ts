import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';

export const memorySearchToolSchema = {
  name: 'memory_search',
  description:
    'Perform a semantic or keyword search across memory records. ' +
    'Use this when automatic recall was insufficient. ' +
    'Optionally pass `asOf` (ISO 8601) to query what memories were valid at a specific point in time.',
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
    },
    required: ['userId', 'query', 'sessionKey'],
  },
};

export const memorySearchSchema = z.object({
  userId: z.string(),
  query: z.string(),
  sessionKey: z.string(),
  activeSkill: z.string().optional(),
  limit: z.number().int().positive().optional(),
  asOf: z.string().optional(),
});

export async function handleMemorySearch(args: unknown) {
  const params = memorySearchSchema.parse(args);

  try {
    // Point-in-time search path
    if (params.asOf) {
      const result = memoryEngine.searchAsOf(
        params.userId,
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
      userId: params.userId,
      sessionKey: params.sessionKey,
      query: params.query,
      activeSkill: params.activeSkill,
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
