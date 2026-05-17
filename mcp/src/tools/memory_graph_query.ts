import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';

export const memoryGraphQueryToolSchema = {
  name: 'memory_graph_query',
  description: 'Query the GraphRAG knowledge graph to retrieve entities and relationships within 2 hops of a starting entity, optionally filtered by active skill.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier for isolation' },
      entity: { type: 'string', description: 'The starting entity to search for' },
      skillTag: { type: 'string', description: 'Filter relationships matching this skill' },
      maxHops: { type: 'number', description: 'Max hops to traverse (default 2)' },
    },
    required: ['userId', 'entity'],
  },
};

export const memoryGraphQuerySchema = z.object({
  userId: z.string(),
  entity: z.string(),
  skillTag: z.string().optional(),
  maxHops: z.number().optional(),
});

export async function handleMemoryGraphQuery(args: unknown) {
  const params = memoryGraphQuerySchema.parse(args);
  const result = memoryEngine.queryGraph(
    params.userId,
    params.entity,
    params.skillTag,
    params.maxHops
  );
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
