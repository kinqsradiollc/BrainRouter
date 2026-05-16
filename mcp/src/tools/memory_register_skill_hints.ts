import { z } from 'zod';
import { memoryEngine } from '../memory/engine.js';
import { loadSkillHints } from '../memory/skill-hints-loader.js';

export const memoryRegisterSkillHintsToolSchema = {
  name: 'memory_register_skill_hints',
  description: 'Register extraction hints for a specific skill. Hints guide the memory engine to capture the most valuable context when this skill is active. Can load from a SKILL.md file path or accept hints directly.',
  inputSchema: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Canonical skill name (must match the name field in SKILL.md frontmatter)' },
      hints: { type: 'string', description: 'The extraction hints text. Use this for manual registration.' },
      skillPath: { type: 'string', description: 'Absolute path to a SKILL.md file to auto-load hints from.' },
    },
  },
};

export const memoryRegisterSkillHintsSchema = z.object({
  skillName: z.string().optional(),
  hints: z.string().optional(),
  skillPath: z.string().optional(),
}).refine(
  (data) => (data.skillPath) || (data.skillName && data.hints),
  { message: 'Either provide skillPath to auto-load, or both skillName and hints for manual registration.' }
);

export async function handleMemoryRegisterSkillHints(args: unknown) {
  const params = memoryRegisterSkillHintsSchema.parse(args);

  let skillName: string;
  let hints: string;
  let sourceFile = '';

  if (params.skillPath) {
    // Auto-load from SKILL.md
    const loaded = loadSkillHints(params.skillPath);
    if (!loaded) {
      return {
        content: [{ type: 'text', text: `No memory_hints found in ${params.skillPath}. Add a memory_hints field to the YAML frontmatter.` }],
      };
    }
    if (!loaded.name) {
      return {
        content: [{ type: 'text', text: `SKILL.md at ${params.skillPath} has no name field in its frontmatter. Cannot register.` }],
      };
    }
    skillName = loaded.name;
    hints = loaded.hints;
    sourceFile = params.skillPath;
  } else {
    // Manual registration
    skillName = params.skillName!;
    hints = params.hints!;
  }

  memoryEngine.registerSkillHints(skillName, hints, sourceFile);

  return {
    content: [{
      type: 'text',
      text: `✅ Skill hints registered for "${skillName}"\n\nHints:\n${hints}${sourceFile ? `\n\nLoaded from: ${sourceFile}` : ''}`,
    }],
  };
}
