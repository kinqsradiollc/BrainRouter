import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import type { Registry } from '../registry.js';
import { updateSkillSection } from '../writer.js';
import type { SkillSection } from '../types.js';

export const updateSkillSchema = z.object({
  name: z.string(),
  section: z.enum(['overview', 'workflow', 'usage', 'detailed_instructions', 'checklist', 'full']),
  content: z.string(),
});

export async function updateSkill(registry: Registry, args: z.infer<typeof updateSkillSchema>) {
  const manifest = registry.getSkill(args.name);
  if (!manifest) {
    throw new Error(`Skill "${args.name}" not found.`);
  }

  const localRoot = registry.getLocalRoot();
  if (!localRoot) {
    throw new Error('No local root detected. Skill updates are only allowed in project repositories.');
  }

  let filePath = manifest.filePath;

  // If it's a global skill, shadow it locally
  if (manifest.scope === 'global') {
    const localSkillDir = join(localRoot, 'skills', manifest.category, manifest.name);
    const localSkillPath = join(localSkillDir, 'SKILL.md');
    
    if (!readFileSync(localSkillPath, { flag: 'a+' })) { // Check if exists or create shadowed copy
       mkdirSync(localSkillDir, { recursive: true });
       const globalContent = readFileSync(manifest.filePath, 'utf-8');
       writeFileSync(localSkillPath, globalContent, 'utf-8');
    }
    filePath = localSkillPath;
  }

  const updatedPath = updateSkillSection(
    filePath,
    args.section as Extract<SkillSection, 'overview' | 'workflow' | 'usage' | 'detailed_instructions' | 'checklist' | 'full'>,
    args.content,
    localRoot
  );

  registry.refresh();

  return {
    content: [
      {
        type: 'text',
        text: `Successfully updated section "${args.section}" of skill "${args.name}".`,
      },
    ],
    metadata: {
      path: updatedPath,
      scope: registry.getSkill(args.name)?.scope ?? 'local',
    },
  };
}
