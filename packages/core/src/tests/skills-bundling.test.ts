/**
 * ADR-031 D2/D2b/D3 — the teeth on the generated skill library.
 *
 * `packages/core/skills/` is generated from the monorepo's root `skills/` and
 * gitignored, so nobody can commit an edit to it. That stops silent drift but it
 * does not prove the copy runs, carries everything, or brings the licences with
 * it — and a sync mechanism nobody has watched fail is a sync mechanism nobody
 * knows works. These tests run the copy, break it on purpose, and confirm the
 * check refuses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const LIBRARY = path.join(REPO_ROOT, 'skills');
const BUNDLER = path.join(REPO_ROOT, 'scripts', 'bundle-content.mjs');

/** The monorepo is absent in a published install; the tests then have nothing to compare. */
const inMonorepo = fs.existsSync(BUNDLER) && fs.existsSync(LIBRARY);

/** The slice of scripts/bundle-content.mjs these tests drive. */
interface Bundler {
  listContentFiles(root: string): string[];
  syncContentDir(sourceDir: string, destDir: string): number;
  bundleSkills(packageDir: string, options?: { libraryRoot?: string }): { copied: number };
  checkBundledSkills(packageDir: string, options?: { libraryRoot?: string }): string[];
}

const bundler = (inMonorepo
  ? ((await import(pathToFileURL(BUNDLER).href)) as unknown as Bundler)
  : (undefined as unknown as Bundler));

function tempPackage(name: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundle-content-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
    'utf8',
  );
  return dir;
}

function writeSkill(root: string, relDir: string, files: Record<string, string>): void {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

test('the package ships the whole library, byte for byte', (t) => {
  if (!inMonorepo) return t.skip('published install — no monorepo library to compare');
  const problems: string[] = bundler.checkBundledSkills(PACKAGE_ROOT);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the skills a workspace profile offers are the skills that ship', (t) => {
  if (!inMonorepo) return t.skip('published install — no monorepo library to compare');
  // ADR-031 §3: the design profile names these five, the hand-copied bundle
  // carried none of them, and an offer the product cannot honour is worse than
  // an absence (ADR-029 F1).
  const offered = ['a11y-skill', 'taste-skill', 'concept-diagrams', 'redesign-skill', 'output-skill'];
  const shipped = new Set(
    bundler
      .listContentFiles(path.join(PACKAGE_ROOT, 'skills'))
      .filter((rel: string) => path.posix.basename(rel) === 'SKILL.md')
      .map((rel: string) => rel.split('/').at(-2)),
  );
  for (const skill of offered) assert.ok(shipped.has(skill), `${skill} is offered by a profile but not shipped`);
});

test('the package declares its generated content in npm files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('skills'), 'skills/ must be published');
  assert.ok(manifest.files.includes('THIRD-PARTY-NOTICES.md'), 'the notice must be published');
});

test('the notice names the third-party runtime this package redistributes', (t) => {
  if (!inMonorepo) return t.skip('published install — the notice is generated at build time');
  const notice = fs.readFileSync(path.join(PACKAGE_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  // ADR-030's document parser: MIT, redistributed in our tarball and in the
  // desktop binary, and it had no notice anywhere before this.
  assert.match(notice, /@firecrawl\/pdf-inspector-wasm@/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
});

test('a hand-edited copy fails the check', (t) => {
  if (!inMonorepo) return t.skip('published install — nothing to generate from');
  const pkg = tempPackage('@kinqs/bundle-check-fixture');
  try {
    bundler.bundleSkills(pkg, { libraryRoot: LIBRARY });
    assert.deepEqual(bundler.checkBundledSkills(pkg, { libraryRoot: LIBRARY }), []);

    const victim = path.join(pkg, 'skills', bundler.listContentFiles(path.join(pkg, 'skills'))[0]);
    fs.appendFileSync(victim, '\nedited by hand\n');
    const problems: string[] = bundler.checkBundledSkills(pkg, { libraryRoot: LIBRARY });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /differs from the library/);
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

test('a skill deleted from the copy fails the check', (t) => {
  if (!inMonorepo) return t.skip('published install — nothing to generate from');
  const pkg = tempPackage('@kinqs/bundle-missing-fixture');
  try {
    bundler.bundleSkills(pkg, { libraryRoot: LIBRARY });
    const first: string = bundler.listContentFiles(path.join(pkg, 'skills'))[0];
    fs.rmSync(path.join(pkg, 'skills', first));
    const problems: string[] = bundler.checkBundledSkills(pkg, { libraryRoot: LIBRARY });
    assert.deepEqual(problems, [`skills/${first} is missing from the package`]);
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

test('a vendored skill carries its licence into the generated notice', (t) => {
  if (!inMonorepo) return t.skip('published install — nothing to generate from');
  const library = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-library-'));
  const pkg = tempPackage('@kinqs/bundle-notice-fixture');
  try {
    writeSkill(library, 'design/vendored-skill', {
      'SKILL.md': '---\nname: vendored-skill\ndescription: fixture\n---\n\n# Vendored\n',
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Somebody Else\n',
    });
    writeSkill(library, 'agent/our-own-skill', {
      'SKILL.md': '---\nname: our-own-skill\ndescription: fixture\n---\n\n# Ours\n',
    });

    bundler.bundleSkills(pkg, { libraryRoot: library });
    const notice = fs.readFileSync(path.join(pkg, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    assert.match(notice, /### skills\/design\/vendored-skill/);
    assert.match(notice, /Copyright \(c\) 2026 Somebody Else/);
    assert.doesNotMatch(notice, /our-own-skill/);
    assert.deepEqual(bundler.checkBundledSkills(pkg, { libraryRoot: library }), []);
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});

test('licensed content that reached the package without reaching the notice fails the check', (t) => {
  if (!inMonorepo) return t.skip('published install — nothing to generate from');
  const library = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-library-'));
  const pkg = tempPackage('@kinqs/bundle-uncovered-fixture');
  try {
    writeSkill(library, 'agent/our-own-skill', {
      'SKILL.md': '---\nname: our-own-skill\ndescription: fixture\n---\n\n# Ours\n',
    });
    bundler.bundleSkills(pkg, { libraryRoot: library });

    // A vendored skill lands in the library after the notice was generated —
    // the case that makes shipping licensed material without its notice
    // impossible rather than merely discouraged.
    writeSkill(library, 'design/vendored-skill', {
      'SKILL.md': '---\nname: vendored-skill\ndescription: fixture\n---\n\n# Vendored\n',
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Somebody Else\n',
    });
    bundler.syncContentDir(library, path.join(pkg, 'skills'));

    const problems: string[] = bundler.checkBundledSkills(pkg, { libraryRoot: library });
    assert.ok(
      problems.some((problem) => /THIRD-PARTY-NOTICES\.md no longer matches/.test(problem)),
      problems.join('\n'),
    );
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});
