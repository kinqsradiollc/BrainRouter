/**
 * ADR-027 D3 — skill loader gaps.
 *
 * `## Workflow` is the DEFAULT section served to agents, so a prose-first skill
 * with no explicit Workflow heading must still serve something useful rather
 * than a "not found" comment. Phases must be recognised at H2 as well as H3.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillSection } from '../loader.js';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-loader-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function writeSkill(body: string): string {
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('workflow section fallback', () => {
  it('serves the body when a skill has no explicit ## Workflow heading', () => {
    const file = writeSkill([
      '---', 'name: prose-first', 'description: no workflow heading', '---', '',
      'A preamble that is comfortably longer than the twenty character floor.', '',
      '## Detailed Instructions', '',
      'Do the first thing, then the second thing, then verify the result.',
    ].join('\n'));
    const out = loadSkillSection(file, 'workflow');
    expect(out.content).not.toMatch(/not found/i);
    expect(out.content).toMatch(/Detailed Instructions/);
    expect(out.content).toMatch(/verify the result/);
  });

  it('falls back to the preamble when there is no body section either', () => {
    const file = writeSkill([
      '---', 'name: preamble-only', 'description: preamble only', '---', '',
      'This preamble is the entire skill and is longer than twenty characters.',
    ].join('\n'));
    const out = loadSkillSection(file, 'workflow');
    expect(out.content).not.toMatch(/not found/i);
    expect(out.content).toMatch(/entire skill/);
  });

  it('still prefers a real ## Workflow heading when present', () => {
    const file = writeSkill([
      '---', 'name: explicit', 'description: has workflow', '---', '',
      '## Overview', '', 'Some overview prose here for context.', '',
      '## Workflow', '', 'The canonical steps live here.',
    ].join('\n'));
    const out = loadSkillSection(file, 'workflow');
    expect(out.content).toMatch(/canonical steps/);
  });
});

describe('phase extraction', () => {
  it('recognises phases written at H2, not only H3', () => {
    const file = writeSkill([
      '---', 'name: h2-phases', 'description: phases at h2', '---', '',
      '## Phase 1: Reproduce', '', 'Find a command that fails deterministically.', '',
      '## Phase 2: Localize', '', 'Bisect toward the smallest failing surface.',
    ].join('\n'));
    const out = loadSkillSection(file, 'phases');
    expect(out.content).toMatch(/Phase 1: Reproduce/);
    expect(out.content).toMatch(/Phase 2: Localize/);
    expect(out.content).toMatch(/Bisect toward/);
  });

  it('still recognises H3 phases', () => {
    const file = writeSkill([
      '---', 'name: h3-phases', 'description: phases at h3', '---', '',
      '## The Process', '', '### Phase 1: Plan', '', 'Write the plan down first.',
    ].join('\n'));
    const out = loadSkillSection(file, 'phases');
    expect(out.content).toMatch(/Phase 1: Plan/);
    expect(out.content).toMatch(/Write the plan down/);
  });
});
