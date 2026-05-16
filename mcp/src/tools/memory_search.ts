import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';

export const memorySearchToolSchema = {
  name: 'memory_search',
  description: 'Perform a semantic or keyword search across memory records. Use this when automatic recall was insufficient.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier for isolation' },
      query: { type: 'string', description: 'Search query' },
      sessionKey: { type: 'string', description: 'Session identifier' },
      activeSkill: { type: 'string', description: 'Current active skill boost' },
      limit: { type: 'number', description: 'Max results to return (default 10)' },
    },
    required: ['userId', 'query', 'sessionKey'],
  },
};

export const memorySearchSchema = z.object({
  userId: z.string(),
  query: z.string(),
  sessionKey: z.string(),
  activeSkill: z.string().optional(),
  limit: z.number().optional(),
});

export async function handleMemorySearch(args: unknown) {
  const params = memorySearchSchema.parse(args);
  
  // Reuse the recall pipeline logic but potentially with more results
  const result = await memoryEngine.recall({
    ...params,
    // Note: recall() currently defaults to top 5, but we can pass limit if we update the engine
  });
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
