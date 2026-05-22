import { z } from 'zod';
import { readFileSync } from 'fs';
import { dirname, normalize, resolve } from 'path';
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
  file: z.string().optional(),
});

export async function getSkill(registry: Registry, args: z.infer<typeof getSkillSchema>) {
  const manifest = registry.getSkill(args.name);
  if (!manifest) {
    throw new Error(`Skill "${args.name}" not found.`);
  }

  if (args.file) {
    const skillDir = dirname(manifest.filePath);
    const targetPath = resolve(skillDir, normalize(args.file));
    if (!targetPath.startsWith(resolve(skillDir))) {
      throw new Error('Directory traversal is not allowed.');
    }
    
    let content: string;
    try {
      content = readFileSync(targetPath, 'utf-8');
    } catch (err: any) {
      throw new Error(`Could not read file "${args.file}" in skill "${args.name}": ${err.message}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
      metadata: {
        scope: manifest.scope,
      },
    };
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
      scope: fragment.scope,
      tokenEstimate: fragment.tokenEstimate,
    },
  };
}
