/**
 * ADR-056 D-B4 — the routed design vocabulary holds against the shipped
 * skill: every verb has its playbook file and its row in the skill's table,
 * every mode has a row in modes.md, every demoted style skill is a world the
 * skill can route to, the frontend pack and capability deliver exactly one
 * visual-craft skill, the design profile enables none of the style skills
 * directly, and the prompt a `/design <verb>` turn starts from is bounded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESIGN_SKILL_ID, DESIGN_VERBS, DESIGN_VERB_IDS, DESIGN_MODES, DESIGN_STYLE_SKILL_IDS, DESIGN_GENRE_IDS,
  designVerbPrompt, designVerbReference, isDesignVerb, isDesignMode,
} from '../design/index.js';
import { WORKSPACE_PROFILES } from '../workspace/profiles.js';
import { WORKSPACE_CAPABILITY_DEFINITIONS } from '../workspace/capabilities.js';
import { WORKSPACE_PROFILE_PLUGIN_DEFINITIONS } from '../workspace/profilePlugins.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_DIR = path.join(PACKAGE_ROOT, 'skills', 'design', DESIGN_SKILL_ID);
const VISUAL_CRAFT = new Set<string>([DESIGN_SKILL_ID, ...DESIGN_STYLE_SKILL_IDS]);

test('B4 every verb has a playbook under references/verbs and a row in the skill table', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /^## Routed verbs — `\/design <verb>`/m);
  for (const verb of DESIGN_VERBS) {
    const ref = path.join(SKILL_DIR, designVerbReference(verb.id));
    assert.ok(fs.existsSync(ref), `${verb.id} has no playbook at ${designVerbReference(verb.id)}`);
    assert.ok(fs.readFileSync(ref, 'utf8').startsWith('# '), `${verb.id} playbook has no title`);
    assert.match(skill, new RegExp(`^\\| \`${verb.id}\` \\| ${verb.edits ? 'yes' : 'no'} \\|`, 'm'), `${verb.id} row (edits=${verb.edits}) missing from the table`);
  }
  const listed = fs.readdirSync(path.join(SKILL_DIR, 'references', 'verbs')).map((f) => f.replace(/\.md$/, ''));
  assert.deepEqual(listed.sort(), [...DESIGN_VERB_IDS].sort(), 'verbs/ has a file the vocabulary does not name (or vice versa)');
  assert.ok(isDesignVerb('polish') && !isDesignVerb('sparkle'));
});

test('B4 modes and worlds: modes.md rows, worlds.md names every genre and demoted style skill', () => {
  const modes = fs.readFileSync(path.join(SKILL_DIR, 'references', 'modes.md'), 'utf8');
  for (const mode of DESIGN_MODES) assert.match(modes, new RegExp(`^\\| \`${mode.id}\` \\|`, 'm'), `${mode.id} row missing from modes.md`);
  assert.ok(isDesignMode('operate') && !isDesignMode('loud'));
  const worlds = fs.readFileSync(path.join(SKILL_DIR, 'references', 'genres', 'worlds.md'), 'utf8');
  for (const id of [...DESIGN_GENRE_IDS, ...DESIGN_STYLE_SKILL_IDS]) assert.match(worlds, new RegExp(`\`${id}\``), `${id} is not a world`);
  for (const id of DESIGN_STYLE_SKILL_IDS) assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'skills', 'design', id, 'SKILL.md')), `${id} still ships as a readable world`);
});

test('B4 one visual-craft skill: pack + capability deliver only hallmark; the design profile enables no style skill', () => {
  const capability = WORKSPACE_CAPABILITY_DEFINITIONS.find((c) => c.id === 'frontend');
  const pack = WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.find((p) => p.id === 'frontend');
  assert.ok(capability && pack);
  const delivered = [...pack.skillIds, ...pack.librarySkillIds].filter((id) => VISUAL_CRAFT.has(id));
  assert.deepEqual(delivered, [DESIGN_SKILL_ID]);
  assert.deepEqual(capability.skillIds.filter((id) => VISUAL_CRAFT.has(id)), [DESIGN_SKILL_ID]);
  assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, 'profile-plugins', 'frontend', 'skills', 'taste-skill')), false, 'the pack still owns a copy of a style skill');
  const design = WORKSPACE_PROFILES.find((p) => p.id === 'design');
  assert.ok(design);
  assert.deepEqual(design.skills.enabled.filter((id) => VISUAL_CRAFT.has(id)), [], 'the design profile enables a visual-craft skill directly');
  assert.deepEqual(design.skills.packs, ['design']);
});

test('B4 the verb prompt is bounded and names the skill, the playbook, the mode, and the two shared rules', () => {
  const p = designVerbPrompt({ verb: 'polish', targets: ['src/pages/landing.tsx'], mode: 'persuade', world: 'editorial', brief: 'keep the hero' });
  assert.match(p, /^\/design polish: run the `polish` verb of the `hallmark` design skill/);
  assert.match(p, /references\/verbs\/polish\.md/); assert.match(p, /Mode: persuade/); assert.match(p, /World: editorial/);
  assert.match(p, /src\/pages\/landing\.tsx/); assert.match(p, /Run design_detect on the target before/); assert.match(p, /count must not rise/); assert.match(p, /Brief: keep the hero/);
  assert.ok(p.length < 1_500);
  const c = designVerbPrompt({ verb: 'critique' });
  assert.match(c, /edits nothing\. Report only/); assert.match(c, /Infer the mode/); assert.match(c, /ask once if that is unclear/);
  const s = designVerbPrompt({ verb: 'shape', brief: 'a pricing page' });
  assert.match(s, /detector has nothing to check/);
});
