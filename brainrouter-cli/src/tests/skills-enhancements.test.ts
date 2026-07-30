import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseStackedSkillTokens,
  resolveStackedSkills,
  buildStackedSkillPrompt,
  resolveSkill,
  scaffoldSkill,
  renderSkillTemplate,
  isValidSkillName,
} from '../prompt/skillRunner.js';
import {
  parseAllowedToolsFrontmatter,
  parseDisallowedToolsFrontmatter,
  listFilesystemSkills,
  skillSearchRoots,
} from '../prompt/skillCatalog.js';
import { _resetCliKnobsCache, resolveCliKnobs, setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { clearOrgConventionRepoRoots, setOrgConventionRepoRoots } from '@kinqs/brainrouter-core/plugin';

/**
 * CC-SKILLS D-group — Skills enhancements. These are BrainRouter's OWN skill
 * conventions (roots: `skills/` + `.brainrouter/skills`); there is deliberately
 * no legacy vendor path anywhere in the feature or its tests.
 */

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skills-'));
}

function writeSkill(root: string, name: string, body = 'Body.'): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n\n${body}\n`);
}

// ── D1 — stacked slash-skill parsing ──────────────────────────────────────

test('D1 parseStackedSkillTokens: 2 leading /skill tokens split from the input', () => {
  const { skills, rest } = parseStackedSkillTokens('/plan /review do the thing', 5);
  assert.deepEqual(skills, ['plan', 'review']);
  assert.equal(rest, 'do the thing');
});

test('D1 parseStackedSkillTokens: 3 skills stack in order', () => {
  const { skills, rest } = parseStackedSkillTokens('/a /b /c build X', 5);
  assert.deepEqual(skills, ['a', 'b', 'c']);
  assert.equal(rest, 'build X');
});

test('D1 parseStackedSkillTokens: a single leading /skill is NOT stacked (normal command path)', () => {
  const { skills, rest } = parseStackedSkillTokens('/spec design the API', 5);
  assert.deepEqual(skills, []);
  assert.equal(rest, '/spec design the API');
});

test('D1 parseStackedSkillTokens: caps at 5; overflow folds back into the input', () => {
  const { skills, rest } = parseStackedSkillTokens('/a /b /c /d /e /f /g go', 5);
  assert.equal(skills.length, 5);
  assert.deepEqual(skills, ['a', 'b', 'c', 'd', 'e']);
  // /f and /g are past the cap → carried into the user input as literal text.
  assert.equal(rest, '/f /g go');
});

test('D1 parseStackedSkillTokens: reserved /skill /skills words are not stack tokens', () => {
  const { skills } = parseStackedSkillTokens('/skill /skills foo', 5);
  assert.deepEqual(skills, []);
});

test('D1 resolveStackedSkills + buildStackedSkillPrompt compose bodies as ordered phases', async () => {
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'alpha', 'Alpha body.');
    writeSkill(path.join(ws, 'skills'), 'beta', 'Beta body.');
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const { resolved } = await resolveStackedSkills(stubClient, ['alpha', 'beta'], ws);
    assert.equal(resolved.length, 2);
    const prompt = buildStackedSkillPrompt(resolved, { input: 'ship it' });
    assert.match(prompt, /Phase 1 — skill: alpha/);
    assert.match(prompt, /Phase 2 — skill: beta/);
    assert.ok(prompt.indexOf('Phase 1') < prompt.indexOf('Phase 2'), 'phases in order');
    assert.match(prompt, /ship it/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('D1 resolveStackedSkills skips unknown skills without poisoning the stack', async () => {
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'known', 'Known body.');
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const { resolved } = await resolveStackedSkills(stubClient, ['known', 'nope-not-a-skill'], ws);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].name, 'known');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── D2 — nested-skill collision scoping across BrainRouter roots ───────────

test('D2 listFilesystemSkills: same name in workspace + local roots marks the collision, workspace wins', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  try {
    // Same skill name present in `skills/` (workspace) AND `.brainrouter/skills` (local).
    writeSkill(path.join(ws, 'skills'), 'build', 'Workspace build.');
    writeSkill(path.join(ws, '.brainrouter', 'skills'), 'build', 'Local build.');
    const list = listFilesystemSkills(ws);
    const build = list.find((s) => s.name === 'build');
    assert.ok(build, 'build skill listed');
    // Workspace precedence wins.
    assert.equal(build!.scope, 'workspace');
    assert.equal(build!.collides, true);
    assert.deepEqual(build!.shadowedBy, ['local']);
    assert.equal(build!.qualifiedName, 'workspace:build');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

test('D2 listFilesystemSkills: a uniquely-named skill is not marked as colliding', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'solo', 'Only one.');
    const list = listFilesystemSkills(ws);
    const solo = list.find((s) => s.name === 'solo');
    assert.ok(solo);
    assert.notEqual(solo!.collides, true);
    assert.ok(!solo!.shadowedBy || solo!.shadowedBy.length === 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

test('MC-E4 listFilesystemSkills: workspace wins over org, org is read-only, org roots precede bundled', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  const org = mkWorkspace();
  try {
    const orgRoot = path.join(org, '.brainrouter');
    writeSkill(path.join(ws, 'skills'), 'build', 'Workspace build.');
    writeSkill(path.join(orgRoot, 'skills'), 'build', 'Org build.');
    writeSkill(path.join(orgRoot, 'skills'), 'deploy', 'Org deploy.');
    setOrgConventionRepoRoots([orgRoot]);
    const base = resolveCliKnobs({ activeServer: '', servers: {}, cli: { skills: { orgRepoDiscovery: true }, plugins: { orgScope: true } } } as any);
    setCliKnobOverride({ skills: base.skills, plugins: base.plugins });

    const roots = skillSearchRoots(ws);
    const workspaceIndex = roots.indexOf(path.join(ws, 'skills'));
    const orgIndex = roots.indexOf(path.join(orgRoot, 'skills'));
    const bundledIndex = roots.findIndex((root, index) => index > orgIndex && !root.startsWith(ws) && !root.startsWith(orgRoot));
    assert.ok(workspaceIndex >= 0 && orgIndex > workspaceIndex, 'org roots load after workspace roots');
    assert.ok(bundledIndex > orgIndex, 'bundled roots load after org roots');

    const list = listFilesystemSkills(ws);
    const build = list.find((skill) => skill.name === 'build');
    const deploy = list.find((skill) => skill.name === 'deploy');
    assert.equal(build?.scope, 'workspace');
    assert.equal(build?.collides, true);
    assert.deepEqual(build?.shadowedBy, ['org']);
    assert.equal(deploy?.scope, 'org');
    assert.equal(deploy?.readOnly, true);
  } finally {
    clearOrgConventionRepoRoots();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(org, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

// ── D3 — skill-level disallowed-tools frontmatter ─────────────────────────

test('D3 parseDisallowedToolsFrontmatter: flow form [a, b]', () => {
  const raw = '---\nname: x\ndisallowed-tools: [run_command, write_file]\n---\n# x';
  assert.deepEqual(parseDisallowedToolsFrontmatter(raw), ['run_command', 'write_file']);
});

test('D3 parseDisallowedToolsFrontmatter: block form (- items)', () => {
  const raw = '---\nname: x\ndisallowed-tools:\n  - run_command\n  - write_file\ndescription: y\n---\n# x';
  assert.deepEqual(parseDisallowedToolsFrontmatter(raw), ['run_command', 'write_file']);
});

test('D3 parseDisallowedToolsFrontmatter: absent key → empty list', () => {
  const raw = '---\nname: x\ndescription: y\n---\n# x';
  assert.deepEqual(parseDisallowedToolsFrontmatter(raw), []);
});

test('D3 resolveSkill surfaces disallowedTools parsed from frontmatter', async () => {
  const ws = mkWorkspace();
  try {
    const dir = path.join(ws, 'skills', 'locked');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: locked\ndisallowed-tools: [run_command]\n---\n# locked\nDo the safe thing.\n',
    );
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const skill = await resolveSkill(stubClient, 'locked', ws);
    assert.equal(skill.source, 'filesystem');
    assert.deepEqual(skill.disallowedTools, ['run_command']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── Skill-level allowed-tools frontmatter ─────────────────────────────────

test('parseAllowedToolsFrontmatter distinguishes absent, empty, flow, and block forms', () => {
  assert.equal(parseAllowedToolsFrontmatter('---\nname: x\n---\n# x'), undefined);
  assert.deepEqual(parseAllowedToolsFrontmatter('---\nname: x\nallowed-tools: []\n---\n# x'), []);
  assert.deepEqual(
    parseAllowedToolsFrontmatter('---\nname: x\nallowed-tools: [read_file, mcp_docs_search]\n---\n# x'),
    ['read_file', 'mcp_docs_search'],
  );
  assert.deepEqual(parseAllowedToolsFrontmatter([
    '---',
    'name: x',
    'allowed-tools:',
    '  - read_file',
    '  - grep_search',
    'description: y',
    '---',
  ].join('\n')), ['read_file', 'grep_search']);
});

test('resolveSkill surfaces allowedTools and stacked skills intersect declared lists', async () => {
  const ws = mkWorkspace();
  try {
    const first = path.join(ws, 'skills', 'first');
    const second = path.join(ws, 'skills', 'second');
    const unrestricted = path.join(ws, 'skills', 'unrestricted');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.mkdirSync(unrestricted, { recursive: true });
    fs.writeFileSync(path.join(first, 'SKILL.md'),
      '---\nname: first\nallowed-tools: [read_file, grep_search]\n---\n# first\n');
    fs.writeFileSync(path.join(second, 'SKILL.md'),
      '---\nname: second\nallowed-tools: [read_file, write_file]\n---\n# second\n');
    fs.writeFileSync(path.join(unrestricted, 'SKILL.md'),
      '---\nname: unrestricted\n---\n# unrestricted\n');
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const resolved = await resolveSkill(stubClient, 'first', ws);
    assert.deepEqual(resolved.allowedTools, ['read_file', 'grep_search']);

    const stacked = await resolveStackedSkills(stubClient, ['first', 'unrestricted', 'second'], ws);
    assert.deepEqual(stacked.allowedTools, ['read_file']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── D4 — /skill init scaffold + robust in-repo autoload ───────────────────

test('D4 isValidSkillName accepts kebab/underscore, rejects paths and dots-only', () => {
  assert.equal(isValidSkillName('my-skill'), true);
  assert.equal(isValidSkillName('my_skill2'), true);
  assert.equal(isValidSkillName('bad/name'), false);
  assert.equal(isValidSkillName('.hidden'), false);
  assert.equal(isValidSkillName(''), false);
});

test('D4 renderSkillTemplate uses BrainRouter frontmatter and never references a legacy vendor path', () => {
  const tpl = renderSkillTemplate('demo');
  assert.match(tpl, /^---\nname: demo/);
  assert.match(tpl, /# allowed-tools: \[read_file, grep_search\]/);
  assert.match(tpl, /# disallowed-tools: \[run_command, write_file\]/);
  assert.match(tpl, /# demo/);
  const legacyPathPattern = new RegExp(`\\${['.', 'clau', 'de'].join('')}`, 'i');
  assert.doesNotMatch(tpl, legacyPathPattern);
});

test('D4 scaffoldSkill writes under .brainrouter/skills/<name>/SKILL.md', () => {
  const ws = mkWorkspace();
  try {
    const res = scaffoldSkill(ws, 'fresh');
    assert.equal(res.created, true);
    const expected = path.join(ws, '.brainrouter', 'skills', 'fresh', 'SKILL.md');
    assert.equal(res.path, expected);
    assert.ok(fs.existsSync(expected), 'SKILL.md exists');
    const legacyDir = ['.', 'clau', 'de'].join('');
    assert.ok(!fs.existsSync(path.join(ws, legacyDir)), 'no legacy vendor path was ever created');
    // Re-running does not overwrite without --force.
    const again = scaffoldSkill(ws, 'fresh');
    assert.equal(again.created, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('D4 autoload: a SKILL.md dropped into BOTH skills/ and .brainrouter/skills is detected', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'from-workspace', 'WS skill.');
    writeSkill(path.join(ws, '.brainrouter', 'skills'), 'from-local', 'Local skill.');
    const names = new Set(listFilesystemSkills(ws).map((s) => s.name));
    assert.ok(names.has('from-workspace'), 'skills/ root detected');
    assert.ok(names.has('from-local'), '.brainrouter/skills root detected');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

test('D4 scaffolded skill is immediately discoverable by the autoload scan', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  try {
    scaffoldSkill(ws, 'scaffolded');
    const names = new Set(listFilesystemSkills(ws).map((s) => s.name));
    assert.ok(names.has('scaffolded'), 'the newly-scaffolded skill is picked up with no restart');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

// ── D1 config knob — skillsStackMax clamps to 1..5 ────────────────────────

test('D1 skillsStackMax knob clamps the stack cap (override honored, hard-capped at 5)', () => {
  _resetCliKnobsCache();
  try {
    setCliKnobOverride({ skillsStackMax: 2 });
    const { skills } = parseStackedSkillTokens('/a /b /c /d go');
    assert.equal(skills.length, 2, 'config cap of 2 applied');
  } finally {
    _resetCliKnobsCache();
  }
});
