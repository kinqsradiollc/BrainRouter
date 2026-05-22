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
  scope: z.enum(['global', 'local']).optional().default('local'),
  project: z.string().optional(),
});

export async function createSkill(registry: Registry, args: z.infer<typeof createSkillSchema>) {
  const localRoot = registry.getLocalRoot();
  const globalRoot = registry.getGlobalRoot();
  const localProjectName = registry.getLocalProjectName();
  
  const targetRoot = args.scope === 'global' ? globalRoot : localRoot;

  if (!targetRoot) {
    throw new Error(`No ${args.scope} root detected.`);
  }

  // Check if skill exists
  if (registry.getSkill(args.name)) {
    throw new Error(`Skill "${args.name}" already exists.`);
  }

  const project = args.project || localProjectName;

  scaffoldSkill({
    ...args,
    project,
    targetRoot,
  });

  registry.refresh();

  return {
    content: [
      {
        type: 'text',
        text: `Successfully created ${args.scope} skill "${args.name}"${project ? ` for project "${project}"` : ` in category "${args.category}"`}.`,
      },
    ],
    metadata: {
      scope: args.scope,
      project,
    },
  };
}
