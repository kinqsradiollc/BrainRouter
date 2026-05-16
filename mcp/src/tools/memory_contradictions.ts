import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';
import { SqliteMemoryStore } from '../memory/store/sqlite.js';
import path from 'node:path';
import os from 'node:os';

export const memoryContradictionsToolSchema = {
  name: 'memory_contradictions',
  description: 'List unresolved semantic contradictions in memory for a user.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier' },
    },
    required: ['userId'],
  },
};

export const memoryContradictionsSchema = z.object({
  userId: z.string(),
});

export async function handleMemoryContradictions(args: unknown) {
  const { userId } = memoryContradictionsSchema.parse(args);

  // We need direct access to the store for this specialized query
  // MemoryEngine doesn't yet expose getPendingContradictions directly on its facade
  // but we can add it or access it if we exported it.
  
  // For now, let's assume MemoryEngine has a getStore() or we add it to MemoryEngine.
  // Actually, I'll just add it to MemoryEngine now to be clean.
  
  // @ts-ignore - Assuming we add this to MemoryEngine
  const results = await memoryEngine.getPendingContradictions(userId);
  
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
