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
  targetScope: z.enum(['global', 'local']).optional(),
  project: z.string().optional(),
});

export async function updateSkill(registry: Registry, args: z.infer<typeof updateSkillSchema>) {
  const manifest = registry.getSkill(args.name);
  if (!manifest) {
    throw new Error(`Skill "${args.name}" not found.`);
  }

  const localRoot = registry.getLocalRoot();
  const globalRoot = registry.getGlobalRoot();
  const localProjectName = registry.getLocalProjectName();
  
  // Decide where to write
  const scope = args.targetScope ?? (manifest.scope === 'global' ? 'local' : 'local');
  const targetRoot = scope === 'global' ? globalRoot : localRoot;

  if (!targetRoot) {
    throw new Error(`No ${scope} root detected.`);
  }

  let filePath = manifest.filePath;

  if (scope === 'global') {
    // We want to write to global. If it's currently local, we determine the global destination.
    if (manifest.scope === 'local') {
      const project = args.project ?? manifest.project ?? localProjectName;
      if (!project) {
        throw new Error('Project name is required to promote a skill to global scope.');
      }
      const baseFolder = 'projects';
      const projectFolder = project;
      
      const globalSkillDir = join(globalRoot, baseFolder, projectFolder, 'skills', manifest.category, manifest.name);
      filePath = join(globalSkillDir, 'SKILL.md');
      
      if (!readFileSync(filePath, { flag: 'a+' })) {
        mkdirSync(globalSkillDir, { recursive: true });
        const localContent = readFileSync(manifest.filePath, 'utf-8');
        writeFileSync(filePath, localContent, 'utf-8');
      }
    }
  } else {
    // Default/Local scope: shadow global if necessary
    if (!localRoot) {
      throw new Error('Local root not detected. Cannot update local skills.');
    }
    
    if (manifest.scope === 'global') {
      // In local repos, we MUST use projects/ folder
      const project = localProjectName;
      if (!project) {
        throw new Error('Project name is required to shadow a global skill locally.');
      }
      const localSkillDir = join(localRoot, 'projects', project, 'skills', manifest.category, manifest.name);
      const localSkillPath = join(localSkillDir, 'SKILL.md');
      
      if (!readFileSync(localSkillPath, { flag: 'a+' })) {
         mkdirSync(localSkillDir, { recursive: true });
         const globalContent = readFileSync(manifest.filePath, 'utf-8');
         writeFileSync(localSkillPath, globalContent, 'utf-8');
      }
      filePath = localSkillPath;
    }
  }

  updateSkillSection(
    filePath,
    args.section as Extract<SkillSection, 'overview' | 'workflow' | 'usage' | 'detailed_instructions' | 'checklist' | 'full'>,
    args.content,
    targetRoot
  );

  registry.refresh();

  return {
    content: [
      {
        type: 'text',
        text: `Successfully updated section "${args.section}" of skill "${args.name}" in ${scope} registry.`,
      },
    ],
    metadata: {
      scope: registry.getSkill(args.name)?.scope ?? scope,
    },
  };
}
