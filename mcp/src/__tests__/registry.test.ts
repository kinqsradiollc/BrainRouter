import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from '../registry.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('registry.ts', () => {
  const globalRoot = join(tmpdir(), 'brainrouter-registry-test-global');
  const localRoot = join(tmpdir(), 'brainrouter-registry-test-local');

  beforeEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
    mkdirSync(join(globalRoot, 'skills', 'agent', 'global-skill'), { recursive: true });
    mkdirSync(join(localRoot, 'skills', 'agent', 'local-skill'), { recursive: true });
    mkdirSync(join(localRoot, 'docs', 'api'), { recursive: true });
    mkdirSync(join(globalRoot, 'agents'), { recursive: true });
    mkdirSync(join(localRoot, 'agents'), { recursive: true });

    writeFileSync(
      join(globalRoot, 'skills', 'agent', 'global-skill', 'SKILL.md'),
      '---\nname: global-skill\ndescription: global desc\n---\n'
    );
    writeFileSync(
      join(localRoot, 'skills', 'agent', 'local-skill', 'SKILL.md'),
      '---\nname: local-skill\ndescription: local desc\n---\n'
    );
    writeFileSync(
      join(localRoot, 'docs', 'api', 'API.md'),
      '# API'
    );
    writeFileSync(join(globalRoot, 'agents', 'global-persona.md'), 'global persona content');
    writeFileSync(join(localRoot, 'agents', 'local-persona.md'), 'local persona content');
  });

  it('should index both global and local skills', () => {
    const registry = new Registry({ globalRoot, localRoot });
    registry.build();
    
    const skills = registry.listSkills();
    expect(skills.length).toBe(2);
    expect(skills.find(s => s.name === 'global-skill')?.scope).toBe('global');
    expect(skills.find(s => s.name === 'local-skill')?.scope).toBe('local');
  });

  it('should shadow global skills with local ones if names conflict', () => {
    // Create a local skill with same name as global
    mkdirSync(join(localRoot, 'skills', 'agent', 'global-skill'), { recursive: true });
    writeFileSync(
      join(localRoot, 'skills', 'agent', 'global-skill', 'SKILL.md'),
      '---\nname: global-skill\ndescription: shadowed desc\n---\n'
    );
    
    const registry = new Registry({ globalRoot, localRoot });
    registry.build();
    
    const skill = registry.getSkill('global-skill');
    expect(skill?.scope).toBe('local');
    expect(skill?.description).toBe('shadowed desc');
  });

  it('should index local docs', () => {
    const registry = new Registry({ globalRoot, localRoot });
    registry.build();
    
    const docs = registry.listDocs();
    expect(docs.length).toBe(1);
    expect(docs[0].name).toBe('api');
  });

  it('should index both global and local personas (agents)', () => {
    const registry = new Registry({ globalRoot, localRoot });
    registry.build();
    
    const personas = registry.listPersonas();
    expect(personas.length).toBe(2);
    expect(personas.find(p => p.name === 'global-persona')).toBeDefined();
    expect(personas.find(p => p.name === 'local-persona')).toBeDefined();
  });
});
