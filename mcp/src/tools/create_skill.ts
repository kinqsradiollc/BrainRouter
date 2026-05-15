import { z } from 'zod';
import type { Registry } from '../registry.js';
import { scaffoldSkill } from '../writer.js';

export const createSkillSchema = z.object({
  name: z.string(),
  category: z.string(),
  description: z.string(),
  overview: z.string().optional(),
  when_to_use: z.string().optional(),
  workflow: z.array(z.string()).optional(),
  usage: z.string().optional(),
  checklist: z.array(z.string()).optional(),
});

export async function createSkill(registry: Registry, args: z.infer<typeof createSkillSchema>) {
  const localRoot = registry.getLocalRoot();
  if (!localRoot) {
    throw new Error('No local root detected. Skill creation is only allowed in project repositories.');
  }

  // Check if skill exists
  if (registry.getSkill(args.name)) {
    throw new Error(`Skill "${args.name}" already exists.`);
  }

  const createdPath = scaffoldSkill({
    ...args,
    localRoot,
  });

  registry.refresh();

  return {
    content: [
      {
        type: 'text',
        text: `Successfully created skill "${args.name}" in category "${args.category}".`,
      },
    ],
    metadata: {
      path: createdPath,
    },
  };
}
