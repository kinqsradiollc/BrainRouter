import { z } from 'zod';
import type { Registry } from '../registry.js';
import type { SkillScope } from '../types.js';

export const listSkillsSchema = z.object({
  category: z.string().optional(),
  scope: z.enum(['global', 'local', 'all']).optional().default('all'),
});

export async function listSkills(registry: Registry, args: z.infer<typeof listSkillsSchema>) {
  const skills = registry.listSkills(args.category, args.scope as SkillScope | 'all');
  
  const sanitized = skills.map(({ filePath, ...rest }) => rest);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(sanitized, null, 2),
      },
    ],
  };
}
