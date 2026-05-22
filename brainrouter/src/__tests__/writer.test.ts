import { describe, it, expect, beforeEach } from 'vitest';
import { scaffoldSkill, updateSkillSection, updateDocSection } from '../writer.js';
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

describe('writer.ts', () => {
  const localRoot = join(tmpdir(), 'brainrouter-writer-test-local');
  const globalRoot = join(tmpdir(), 'brainrouter-writer-test-global');

  beforeEach(() => {
    rmSync(localRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
  });

  it('should scaffold a new skill in targetRoot (local)', () => {
    const params = {
      name: 'new-skill',
      category: 'agent',
      description: 'New description',
      targetRoot: localRoot,
      project: 'TestProject',
    };

    const path = scaffoldSkill(params);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(localRoot);
    expect(path).toContain(join('projects', 'TestProject', 'skills', 'agent', 'new-skill', 'SKILL.md'));

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('name: new-skill');
    expect(content).toContain('description: New description');
  });

  it('should scaffold a new skill in targetRoot (global)', () => {
    const params = {
      name: 'global-skill',
      category: 'universal',
      description: 'Global description',
      targetRoot: globalRoot,
      project: 'Universal',
    };

    const path = scaffoldSkill(params);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(globalRoot);
    expect(path).toContain(join('projects', 'Universal', 'skills', 'universal', 'global-skill', 'SKILL.md'));

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('name: global-skill');
  });

  it('should scaffold a new project-specific skill in targetRoot (global)', () => {
    const params = {
      name: 'storage-skill',
      category: 'api',
      description: 'Storage description',
      targetRoot: globalRoot,
      project: 'TestProject',
    };

    const path = scaffoldSkill(params);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(join(globalRoot, 'projects', 'TestProject', 'skills', 'api', 'storage-skill', 'SKILL.md'));

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('name: storage-skill');
  });

  it('should block writes outside of targetRoot', () => {
    const outsidePath = resolve('/tmp/not-my-project/SKILL.md');

    expect(() => {
      updateSkillSection(outsidePath, 'workflow', 'content', localRoot);
    }).toThrow(/WRITE BLOCKED/);
  });

  it('should update a skill section and preserve frontmatter', () => {
    const skillDir = join(localRoot, 'projects', 'TestProject', 'skills', 'agent', 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    const initial = `---
name: test-skill
description: old desc
---
## Workflow
Old step.
`;
    writeFileSync(skillPath, initial);

    updateSkillSection(skillPath, 'workflow', 'New step.', localRoot);

    const updated = readFileSync(skillPath, 'utf-8');
    expect(updated).toContain('description: old desc');
    expect(updated).toContain('New step.');
    expect(updated).not.toContain('Old step.');
  });

  it('should update a doc section in localRoot', () => {
    const docDir = join(localRoot, 'docs', 'api');
    mkdirSync(docDir, { recursive: true });
    const docPath = join(docDir, 'API.md');
    writeFileSync(docPath, '## Endpoints\n- GET /old');

    updateDocSection(docPath, 'Endpoints', '- GET /new', localRoot);

    const updated = readFileSync(docPath, 'utf-8');
    expect(updated).toContain('- GET /new');
    expect(updated).not.toContain('- GET /old');
  });
});
