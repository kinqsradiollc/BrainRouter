import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';

export const memoryContradictionsToolSchema = {
  name: 'memory_contradictions',
  description: 'List unresolved semantic contradictions in memory or resolve them. Default action is "list". If action is "resolve", provide contradictionId and resolutionStatus.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier' },
      action: { type: 'string', enum: ['list', 'resolve'], description: 'Action to perform. Default is list.' },
      contradictionId: { type: 'string', description: 'ID of the contradiction to resolve (required if action is resolve)' },
      resolutionStatus: { type: 'string', enum: ['resolved', 'dismissed'], description: 'Status to set (required if action is resolve)' },
    },
    required: ['userId'],
  },
};

export const memoryContradictionsSchema = z.object({
  userId: z.string(),
  action: z.enum(['list', 'resolve']).default('list'),
  contradictionId: z.string().optional(),
  resolutionStatus: z.enum(['resolved', 'dismissed']).optional(),
});

export async function handleMemoryContradictions(args: unknown) {
  const { userId, action, contradictionId, resolutionStatus } = memoryContradictionsSchema.parse(args);

  if (action === 'resolve') {
    if (!contradictionId || !resolutionStatus) {
      throw new Error('contradictionId and resolutionStatus are required when action is "resolve"');
    }
    
    memoryEngine.resolveContradiction(contradictionId, userId, resolutionStatus);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully marked contradiction ${contradictionId} as ${resolutionStatus}.`,
        },
      ],
    };
  }

  // Handle 'list' action
  const results = memoryEngine.getPendingContradictions(userId);
  
  return {
    content: [
      {
        type: 'text',
        text: results.length > 0 
          ? JSON.stringify(results, null, 2)
          : "No pending contradictions found.",
      },
    ],
  };
}
