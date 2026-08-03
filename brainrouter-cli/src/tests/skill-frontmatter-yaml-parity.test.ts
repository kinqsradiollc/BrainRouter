/**
 * ADR-027 D3 — the CLI's regex frontmatter reader must agree with the brain's
 * real YAML parser about `disable-model-invocation`.
 *
 * A disagreement is a control bypass, not a cosmetic bug: a skill the brain
 * treats as human-only would remain in the CLI's ambient catalog, leaking its
 * description into the model's turn window. The property asserted here is the
 * security one — a human-only skill is ABSENT from the catalog the model sees.
 *
 * Inline comments are the case that actually diverged: an unquoted YAML scalar
 * ends at the first whitespace-preceded `#`, so `true # note` is `true`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFilesystemSkills } from '../prompt/skillCatalog.js';

const SKILL = 'yaml-parity-probe';

/** True when the skill is visible in the catalog the model is shown. */
function inModelCatalog(frontmatterLine: string): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-skill-yaml-'));
  try {
    const dir = path.join(root, 'skills', SKILL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${SKILL}`,
        'description: a description that must not reach the model catalog',
        frontmatterLine,
        '---',
        '',
        'Body.',
      ].join('\n'),
      'utf8',
    );
    return listFilesystemSkills(root).some((s) => s.name === SKILL);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('every YAML-truthy spelling keeps the skill out of the model catalog', () => {
  for (const line of [
    'disable-model-invocation: true',
    'disable-model-invocation: yes',
    'disable-model-invocation: on',
    "disable-model-invocation: 'true'",
    'disable-model-invocation: "true"',
    'disable-model-invocation: TRUE',
  ]) {
    assert.equal(inModelCatalog(line), false, `expected hidden for: ${line}`);
  }
});

test('an inline comment does not defeat the flag', () => {
  // The regression: `true # note` read as the literal "true # note", matched no
  // truthy spelling, and left the skill in the CLI catalog while the brain —
  // which parses real YAML — treated it as human-only.
  assert.equal(inModelCatalog('disable-model-invocation: true # keep it manual'), false);
  assert.equal(inModelCatalog("disable-model-invocation: 'true'  # quoted too"), false);
});

test('falsey and absent values leave the skill model-invocable', () => {
  for (const line of [
    'disable-model-invocation: false',
    'disable-model-invocation: no',
    'triggers: []',
  ]) {
    assert.equal(inModelCatalog(line), true, `expected visible for: ${line}`);
  }
});

test('a `#` inside a quoted description is data, not a comment', () => {
  // Guards the other half of the scalar rule: tightening comment handling must
  // not start truncating legitimate values.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-skill-yaml-desc-'));
  try {
    const dir = path.join(root, 'skills', SKILL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      ['---', `name: ${SKILL}`, 'description: "handles C# and F# projects"', '---', '', 'Body.'].join('\n'),
      'utf8',
    );
    const found = listFilesystemSkills(root).find((s) => s.name === SKILL);
    assert.ok(found);
    assert.equal(found.description, 'handles C# and F# projects');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
