import { z } from 'zod';
import type { Registry } from '../registry.js';
import type { SkillScope } from '../types.js';

export const searchSkillsSchema = z.object({
  query: z.string(),
  scope: z.enum(['global', 'local', 'all']).optional().default('all'),
});

export async function searchSkills(registry: Registry, args: z.infer<typeof searchSkillsSchema>) {
  const results = registry.searchSkills(args.query, args.scope as SkillScope | 'all');
  
  const sanitized = results.map(({ filePath, ...rest }) => rest);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(sanitized, null, 2),
      },
    ],
  };
}
