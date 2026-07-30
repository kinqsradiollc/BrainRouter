/**
 * Bundled starter skills: the CLI (and core) ship synced copies of the
 * monorepo's starter skill set so a CLI-only or desktop install still has the
 * onboarding/workflow skills (`skills/` is only edited at the monorepo root;
 * scripts/sync-bundled-skills.mjs copies them). These tests fail on DRIFT —
 * fix by re-running the sync script, never by hand-editing a copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillSearchRoots } from '../prompt/skillCatalog.js';

// dist/tests/ → package root is two levels up; monorepo root one above that.
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(cliRoot, '..');

const STARTER_SKILLS = [
  'agent/bootstrap-skill',
  'agent/planning-skill',
  'agent/spec-driven-skill',
  'agent/adr-skill',
  'agent/debugging-and-error-recovery',
  'agent/handover-skill',
  'api/testing-skill',
  'codebase/conventions-skill',
  'codebase/code-review-and-quality',
  'lifecycle/incremental-skill',
  'lifecycle/shipping-skill',
  'lifecycle/changelog-generator',
  'qa/verify-loop',
];

test('every starter skill ships inside the CLI package', () => {
  for (const skill of STARTER_SKILLS) {
    const copy = path.join(cliRoot, 'skills', skill, 'SKILL.md');
    assert.ok(fs.existsSync(copy), `missing bundled copy: skills/${skill}/SKILL.md — run scripts/sync-bundled-skills.mjs`);
  }
});

test('bundled copies match the monorepo source (no drift)', (t) => {
  const sourceRoot = path.join(repoRoot, 'skills');
  if (!fs.existsSync(sourceRoot)) return t.skip('published install — no monorepo source to compare');
  for (const skill of STARTER_SKILLS) {
    const source = fs.readFileSync(path.join(sourceRoot, skill, 'SKILL.md'), 'utf8');
    for (const pkgSkills of [path.join(cliRoot, 'skills'), path.join(repoRoot, 'packages', 'core', 'skills')]) {
      const copyPath = path.join(pkgSkills, skill, 'SKILL.md');
      assert.equal(
        fs.readFileSync(copyPath, 'utf8'),
        source,
        `${path.relative(repoRoot, copyPath)} drifted from skills/${skill}/SKILL.md — run scripts/sync-bundled-skills.mjs`,
      );
    }
  }
});

test('the packages declare skills/ in their published files', () => {
  for (const pkgJson of [path.join(cliRoot, 'package.json'), path.join(repoRoot, 'packages', 'core', 'package.json')]) {
    if (!fs.existsSync(pkgJson)) continue;
    const files: string[] = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).files ?? [];
    assert.ok(files.includes('skills'), `${pkgJson} must ship skills/ in files`);
  }
});

test('skill discovery includes the CLI package own skills root (bundled tier)', () => {
  const roots = skillSearchRoots('/tmp/definitely-not-a-workspace');
  const own = path.join(cliRoot, 'skills');
  assert.ok(roots.some((root) => path.resolve(root) === path.resolve(own)), 'own bundled skills root missing from skillSearchRoots');
  // and it must come AFTER the workspace roots so workspace skills always win
  const wsIdx = roots.findIndex((root) => root.includes('definitely-not-a-workspace'));
  const ownIdx = roots.findIndex((root) => path.resolve(root) === path.resolve(own));
  assert.ok(wsIdx !== -1 && wsIdx < ownIdx, 'workspace roots must precede the bundled own-package root');
});
