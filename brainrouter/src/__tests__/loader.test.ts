import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadSkillSection, loadDescription } from '../loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loader.ts', () => {
  const testDir = join(tmpdir(), 'brainrouter-loader-test');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('should extract frontmatter description', () => {
    const filePath = join(testDir, 'SKILL.md');
    writeFileSync(filePath, '---\nname: test-skill\ndescription: A test description\n---\n# Content');
    
    const fragment = loadDescription(filePath);
    expect(fragment.content).toBe('A test description');
  });

  it('should extract a named section', () => {
    const filePath = join(testDir, 'SKILL.md');
    const content = `---
name: test-skill
description: test
---
# Test Skill
## Overview
This is the overview.
## Workflow
1. Step 1
2. Step 2
`;
    writeFileSync(filePath, content);
    
    const fragment = loadSkillSection(filePath, 'workflow');
    expect(fragment.content).toContain('## Workflow');
    expect(fragment.content).toContain('1. Step 1');
    expect(fragment.content).not.toContain('## Overview');
  });

  it('should handle section aliases', () => {
    const filePath = join(testDir, 'SKILL.md');
    const content = `---
name: test-skill
description: test
---
## Core Process
Specific process steps here.
`;
    writeFileSync(filePath, content);
    
    // "workflow" should match "Core Process"
    const fragment = loadSkillSection(filePath, 'workflow');
    expect(fragment.content).toContain('## Core Process');
    expect(fragment.content).toContain('Specific process steps here.');
  });

  it('should extract phases (### Phase N)', () => {
    const filePath = join(testDir, 'SKILL.md');
    const content = `---
name: test-skill
description: test
---
## Steps
### Phase 1: Planning
Do this first.
### Phase 2: Execution
Do this second.
## Other Section
Noise.
`;
    writeFileSync(filePath, content);
    
    const fragment = loadSkillSection(filePath, 'phases');
    expect(fragment.content).toContain('### Phase 1');
    expect(fragment.content).toContain('### Phase 2');
    expect(fragment.content).not.toContain('## Other Section');
  });

  it('should extract checklists', () => {
    const filePath = join(testDir, 'SKILL.md');
    const content = `---
name: test-skill
description: test
---
## Verification
- [ ] Task 1
- [x] Task 2
- Not a task.
`;
    writeFileSync(filePath, content);
    
    const fragment = loadSkillSection(filePath, 'checklist');
    expect(fragment.content).toContain('- [ ] Task 1');
    expect(fragment.content).toContain('- [x] Task 2');
    expect(fragment.content).not.toContain('Not a task.');
  });
});
