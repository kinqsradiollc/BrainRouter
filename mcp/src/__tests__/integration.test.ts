import { describe, it, expect } from 'vitest';
import { Registry } from '../registry.js';
import { resolveRegistryConfig } from '../resolver.js';
import { loadSkillSection } from '../loader.js';
import { existsSync } from 'fs';

describe('BrainRouter Skill Compliance', () => {
  const config = resolveRegistryConfig();
  const registry = new Registry(config);
  registry.build();
  
  const allSkills = registry.listSkills(); // No arguments = all categories, all scopes

  it('should have indexed skills', () => {
    expect(allSkills.length).toBeGreaterThan(0);
  });

  // Dynamically create a test case for every single skill in the repo
  allSkills.forEach((skill) => {
    describe(`Skill: ${skill.name}`, () => {
      it('should have valid frontmatter (name and description)', () => {
        expect(skill.name).toBeDefined();
        expect(skill.description).toBeDefined();
        expect(skill.description.length).toBeGreaterThan(10);
      });

      it('should have a Workflow or Core Process section', () => {
        const fragment = loadSkillSection(skill.filePath, 'workflow');
        // If it returns the "Section not found" comment, it means it failed to find a workflow
        expect(fragment.content).not.toContain('Section "workflow" not found');
        expect(fragment.content.length).toBeGreaterThan(50);
      });

      it('should have an Overview section', () => {
        const fragment = loadSkillSection(skill.filePath, 'overview');
        expect(fragment.content).not.toContain('Section "overview" not found');
      });

      it('should produce a valid token estimate', () => {
        const fragment = loadSkillSection(skill.filePath, 'full');
        expect(fragment.tokenEstimate).toBeGreaterThan(0);
      });
    });
  });
});

describe('BrainRouter Persona Compliance', () => {
  const config = resolveRegistryConfig();
  const registry = new Registry(config);
  registry.build();
  const personas = registry.listPersonas();

  personas.forEach((persona) => {
    it(`Persona "${persona.name}" should be a valid markdown file`, () => {
      expect(existsSync(persona.filePath)).toBe(true);
      expect(persona.filePath.endsWith('.md')).toBe(true);
    });
  });
});
