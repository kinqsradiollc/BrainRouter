/**
 * ADR-031 D2/D2b — the CLI ships the whole skill library, generated.
 *
 * `brainrouter-cli/skills/` used to be thirteen hand-committed copies kept in
 * agreement by a sync script and this test. It is now generated from the monorepo
 * root `skills/` at build time and gitignored, so an edit to a copy cannot be
 * committed at all. What still has to be proved here is that the copy runs, that
 * it carries the library verbatim, and that discovery still finds it — a CLI-only
 * or desktop install has no other bundled skills.
 *
 * The mechanism itself (breaking a copy, the third-party notice) is exercised in
 * packages/core/src/tests/skills-bundling.test.ts; each package checks its own
 * shipped copy so a package's suite fails on that package's drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skillSearchRoots } from '../prompt/skillCatalog.js';

// dist/tests/ → package root is two levels up; monorepo root one above that.
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(cliRoot, '..');
const library = path.join(repoRoot, 'skills');
const bundlerPath = path.join(repoRoot, 'scripts', 'bundle-content.mjs');
const inMonorepo = fs.existsSync(bundlerPath) && fs.existsSync(library);

interface Bundler {
  listContentFiles(root: string): string[];
  checkBundledSkills(packageDir: string, options?: { libraryRoot?: string }): string[];
}

const bundler = (inMonorepo
  ? ((await import(pathToFileURL(bundlerPath).href)) as unknown as Bundler)
  : (undefined as unknown as Bundler));

test('the CLI ships the whole library, byte for byte', (t) => {
  if (!inMonorepo) return t.skip('published install — no monorepo source to compare');
  const problems = bundler.checkBundledSkills(cliRoot);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the starter workflow skills /init depends on are among them', (t) => {
  if (!inMonorepo) return t.skip('published install — no monorepo source to compare');
  const shipped = new Set(
    bundler
      .listContentFiles(path.join(cliRoot, 'skills'))
      .filter((rel) => path.posix.basename(rel) === 'SKILL.md')
      .map((rel) => rel.split('/').at(-2)),
  );
  for (const skill of ['bootstrap-skill', 'planning-skill', 'spec-driven-skill', 'verify-loop']) {
    assert.ok(shipped.has(skill), `${skill} must ship with the CLI — /init and onboarding call it`);
  }
});

test('the package declares its generated content in published files', () => {
  const files: string[] = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8')).files ?? [];
  assert.ok(files.includes('skills'), 'brainrouter-cli must ship skills/ in files');
  assert.ok(files.includes('THIRD-PARTY-NOTICES.md'), 'brainrouter-cli must ship its third-party notice');
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
