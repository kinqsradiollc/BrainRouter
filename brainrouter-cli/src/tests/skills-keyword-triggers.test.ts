import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchTriggeredSkills,
  resolveStackedSkills,
  buildStackedSkillPrompt,
} from '../prompt/skillRunner.js';
import {
  parseSkillTriggersFrontmatter,
  listFilesystemSkills,
} from '../prompt/skillCatalog.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '@kinqs/brainrouter-core/config';

/**
 * MC-E2 — keyword-triggered JIT skill injection. A skill may declare hard
 * keyword triggers in its SKILL.md frontmatter (`triggers:` / `keywords:`);
 * a plain user prompt containing one of those words (case-insensitive,
 * word-boundary) injects the skill's body into the turn like an explicit
 * /skill invocation, sharing the stacked-skill composition path + cap.
 * Kill-switch: `cli.skillsKeywordTriggers` (default true).
 */

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-skill-triggers-'));
}

function writeSkill(root: string, name: string, frontmatterExtra = '', body = 'Body.'): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\n${frontmatterExtra ? frontmatterExtra + '\n' : ''}---\n\n# ${name}\n\n${body}\n`,
  );
}

// ── frontmatter parsing ────────────────────────────────────────────────────

test('MC-E2 parseSkillTriggersFrontmatter: flow form [a, b]', () => {
  const raw = '---\nname: x\ntriggers: [deploy, rollback]\n---\n# x';
  assert.deepEqual(parseSkillTriggersFrontmatter(raw), ['deploy', 'rollback']);
});

test('MC-E2 parseSkillTriggersFrontmatter: block form (- items) under keywords:', () => {
  const raw = '---\nname: x\nkeywords:\n  - deploy\n  - hot fix\ndescription: y\n---\n# x';
  assert.deepEqual(parseSkillTriggersFrontmatter(raw), ['deploy', 'hot fix']);
});

test('MC-E2 parseSkillTriggersFrontmatter: triggers + keywords merge, case-insensitive dedupe', () => {
  const raw = '---\nname: x\ntriggers: [Deploy, release]\nkeywords: [deploy, "canary"]\n---\n# x';
  // "deploy" (from keywords) is a case-variant dup of "Deploy" — first spelling wins.
  assert.deepEqual(parseSkillTriggersFrontmatter(raw), ['Deploy', 'release', 'canary']);
});

test('MC-E2 parseSkillTriggersFrontmatter: absent keys → empty list', () => {
  const raw = '---\nname: x\ndescription: y\n---\n# x';
  assert.deepEqual(parseSkillTriggersFrontmatter(raw), []);
});

test('MC-E2 parseSkillTriggersFrontmatter: comma-separated (phrases keep their spaces)', () => {
  const raw = '---\nname: x\ntriggers: [hot fix, incident response]\n---\n# x';
  assert.deepEqual(parseSkillTriggersFrontmatter(raw), ['hot fix', 'incident response']);
});

test('MC-E2 listFilesystemSkills surfaces declared triggers on the list items', () => {
  _resetCliKnobsCache();
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'deployer', 'triggers: [deploy, ship]');
    writeSkill(path.join(ws, 'skills'), 'plain', '');
    const list = listFilesystemSkills(ws);
    const deployer = list.find((s) => s.name === 'deployer');
    const plain = list.find((s) => s.name === 'plain');
    assert.ok(deployer);
    assert.deepEqual(deployer!.triggers, ['deploy', 'ship']);
    assert.ok(plain);
    assert.equal(plain!.triggers, undefined, 'no triggers key when none declared');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    _resetCliKnobsCache();
  }
});

// ── trigger matching ───────────────────────────────────────────────────────

const catalog = [
  { name: 'deployer', triggers: ['deploy', 'ship'] },
  { name: 'planner', triggers: ['plan'] },
  { name: 'dormant-no-triggers' }, // no triggers → can never fire
];

test('MC-E2 matchTriggeredSkills: case-insensitive whole-word hit', () => {
  const hits = matchTriggeredSkills('Time to DEPLOY the app', catalog, { enabled: true, cap: 5 });
  assert.deepEqual(hits, [{ name: 'deployer', trigger: 'deploy' }]);
});

test('MC-E2 matchTriggeredSkills: word-boundary — no substring false-positives', () => {
  // "planning" and "airplane" contain "plan" but must NOT fire it.
  assert.deepEqual(matchTriggeredSkills('the airplane is planning ahead', catalog, { enabled: true, cap: 5 }), []);
  // "shipped" contains "ship" but must NOT fire it.
  assert.deepEqual(matchTriggeredSkills('we shipped yesterday', catalog, { enabled: true, cap: 5 }), []);
  // The bare word DOES fire.
  assert.deepEqual(
    matchTriggeredSkills('plan the rollout', catalog, { enabled: true, cap: 5 }),
    [{ name: 'planner', trigger: 'plan' }],
  );
});

test('MC-E2 matchTriggeredSkills: one hit per skill (first matching trigger wins)', () => {
  const hits = matchTriggeredSkills('deploy and ship it', catalog, { enabled: true, cap: 5 });
  assert.deepEqual(hits, [{ name: 'deployer', trigger: 'deploy' }]);
});

test('MC-E2 matchTriggeredSkills: skills without triggers stay dormant forever', () => {
  const hits = matchTriggeredSkills('dormant-no-triggers deploy', catalog, { enabled: true, cap: 5 });
  assert.deepEqual(hits.map((h) => h.name), ['deployer']);
});

// ── composition with an explicit stack, under the shared cap ──────────────

test('MC-E2 matchTriggeredSkills: excluded (already-stacked) skills are not re-triggered', () => {
  const hits = matchTriggeredSkills('deploy and plan', catalog, { enabled: true, cap: 5, exclude: ['deployer'] });
  assert.deepEqual(hits, [{ name: 'planner', trigger: 'plan' }]);
});

test('MC-E2 matchTriggeredSkills: explicit stack + triggered share ONE cap', () => {
  // 4 explicit skills leave a single slot at cap 5 → only the first hit lands.
  const hits = matchTriggeredSkills('deploy and plan everything', catalog, {
    enabled: true,
    cap: 5,
    exclude: ['a', 'b', 'c', 'd'],
  });
  assert.deepEqual(hits, [{ name: 'deployer', trigger: 'deploy' }]);
  // A full stack (5 explicit) leaves no room — nothing fires.
  const none = matchTriggeredSkills('deploy and plan everything', catalog, {
    enabled: true,
    cap: 5,
    exclude: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.deepEqual(none, []);
});

test('MC-E2 matchTriggeredSkills: cap is hard-limited to 5 like the stack', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, triggers: [`word${i}`] }));
  const prompt = many.map((s) => s.triggers[0]).join(' ');
  const hits = matchTriggeredSkills(prompt, many, { enabled: true, cap: 99 });
  assert.equal(hits.length, 5, 'even cap:99 clamps to the hard max of 5');
});

test('MC-E2 triggered skills compose through the stacked-skill prompt path', async () => {
  const ws = mkWorkspace();
  try {
    writeSkill(path.join(ws, 'skills'), 'deployer', 'triggers: [deploy]', 'Deploy safely.');
    writeSkill(path.join(ws, 'skills'), 'planner', 'triggers: [plan]', 'Plan first.');
    const hits = matchTriggeredSkills('plan then deploy the service', listFilesystemSkills(ws), { enabled: true, cap: 5 });
    assert.equal(hits.length, 2);
    const stubClient: any = { callTool: async () => { throw new Error('no mcp'); } };
    const { resolved } = await resolveStackedSkills(stubClient, hits.map((h) => h.name), ws);
    assert.equal(resolved.length, 2);
    const prompt = buildStackedSkillPrompt(resolved, { input: 'plan then deploy the service' });
    assert.match(prompt, /Phase 1 — skill: /);
    assert.match(prompt, /Phase 2 — skill: /);
    assert.match(prompt, /plan then deploy the service/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── kill-switch ────────────────────────────────────────────────────────────

test('MC-E2 kill-switch: enabled:false → no injection regardless of matches', () => {
  const hits = matchTriggeredSkills('deploy now', catalog, { enabled: false, cap: 5 });
  assert.deepEqual(hits, []);
});

test('MC-E2 kill-switch: cli.skillsKeywordTriggers=false disables the default path', () => {
  _resetCliKnobsCache();
  try {
    setCliKnobOverride({ skillsKeywordTriggers: false });
    assert.deepEqual(matchTriggeredSkills('deploy now', catalog), []);
    setCliKnobOverride({ skillsKeywordTriggers: true });
    assert.deepEqual(matchTriggeredSkills('deploy now', catalog), [{ name: 'deployer', trigger: 'deploy' }]);
  } finally {
    _resetCliKnobsCache();
  }
});
