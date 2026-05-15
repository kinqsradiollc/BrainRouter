import { z } from 'zod';
import type { Registry } from '../registry.js';
import { loadSkillSection } from '../loader.js';
import type { SkillSection } from '../types.js';

export const getSkillSchema = z.object({
  name: z.string(),
  section: z.enum([
    'description',
    'overview',
    'when_to_use',
    'workflow',
    'usage',
    'detailed_instructions',
    'phases',
    'checklist',
    'red_flags',
    'rationalizations',
    'full',
  ]).optional().default('workflow'),
});

export async function getSkill(registry: Registry, args: z.infer<typeof getSkillSchema>) {
  const manifest = registry.getSkill(args.name);
  if (!manifest) {
    throw new Error(`Skill "${args.name}" not found.`);
  }

  const fragment = loadSkillSection(manifest.filePath, args.section as SkillSection, manifest.scope);
  return {
    content: [
      {
        type: 'text',
        text: fragment.content,
      },
    ],
    metadata: {
      source: fragment.source,
      scope: fragment.scope,
      tokenEstimate: fragment.tokenEstimate,
    },
  };
}
