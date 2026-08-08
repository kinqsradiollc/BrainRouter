/**
 * ADR-031 D1/D2c/D4 — the vendored design skill, and the capability it belongs to.
 *
 * The question this answers is not "is `hallmark` in a list somewhere" but "does a
 * frontend task in an engineering workspace actually reach it, and does what it
 * reaches serve something". ADR-029 F1: a thing OFFERED that is not there is worse
 * than an absence, and a skill whose default section is empty is offered and not
 * there. So these tests resolve the real selection and read the real shipped file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_CAPABILITY_DEFINITIONS } from '../workspace/capabilities.js';
import { createWorkspaceManifest } from '../workspace/manifest.js';
import {
  inspectWorkspaceProfilePlugins,
  workspaceProfilePluginSkillIds,
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS,
} from '../workspace/profilePlugins.js';
import { WORKSPACE_PROFILES } from '../workspace/profiles.js';
import { resolveWorkspaceSkillSelection } from '../workspace/skillSelection.js';
import { resolveBundledWorkspaceSkill } from '../workspace/skillToolAdapter.js';

const DESIGN_SKILL_ID = 'hallmark';
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHIPPED_SKILLS = path.join(PACKAGE_ROOT, 'skills');

/** An empty workspace: nothing local may shadow the package copy under test. */
function emptyWorkspace(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'design-skill-ws-'));
}

test('the design skill hangs off the frontend capability and no profile', () => {
  const capability = WORKSPACE_CAPABILITY_DEFINITIONS.find((entry) => entry.id === 'frontend');
  const pack = WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.find((entry) => entry.id === 'frontend');
  assert.ok(capability);
  assert.ok(pack);
  assert.ok(capability.skillIds.includes(DESIGN_SKILL_ID));
  assert.ok(pack.librarySkillIds.includes(DESIGN_SKILL_ID));
  // The pack does not OWN it: it has no file under profile-plugins, it lives in
  // the shipped library. Owning it there would be a second editable copy.
  assert.equal(pack.skillIds.includes(DESIGN_SKILL_ID), false);
  assert.equal(
    fs.existsSync(path.join(PACKAGE_ROOT, 'profile-plugins', 'frontend', 'skills', DESIGN_SKILL_ID)),
    false,
  );

  // The capability definition and the pack that delivers it must not drift: the
  // definition is what onboarding shows, the pack is what the runtime selects.
  assert.deepEqual(
    [...capability.skillIds].sort(),
    workspaceProfilePluginSkillIds(pack).sort(),
  );

  // ADR-031 §1: it is a capability, not a profile. No profile enables it directly,
  // which is what keeps `engineering` one profile.
  for (const profile of WORKSPACE_PROFILES) {
    assert.equal(
      profile.skills.enabled.includes(DESIGN_SKILL_ID),
      false,
      `${profile.id} enables the design skill directly instead of through a capability`,
    );
  }
});

test('an engineering workspace reaches the design skill when frontend activates', () => {
  const manifest = createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' });
  // `frontend` is recommended and enabled by default in engineering, so this is
  // the out-of-the-box workspace, not a configured one.
  assert.ok(manifest.capabilities.enabled.includes('frontend'));

  const idle = resolveWorkspaceSkillSelection({ manifest });
  assert.equal(idle.ambientSkillIds.includes(DESIGN_SKILL_ID), false);

  const active = resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] });
  assert.ok(active.ambientSkillIds.includes(DESIGN_SKILL_ID));
  assert.ok(active.bundles.some((bundle) => bundle.id === 'frontend'
    && bundle.skillIds.includes(DESIGN_SKILL_ID)));
});

test('a design workspace can turn the capability on and off again', () => {
  const manifest = createWorkspaceManifest({ name: 'studio', profile: 'design', by: 'wizard' });
  // ADR-031 §1: available in `design`, not enabled — it turns on deliberately.
  assert.equal(manifest.capabilities.enabled.includes('frontend'), false);
  assert.equal(
    resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] })
      .ambientSkillIds.includes(DESIGN_SKILL_ID),
    false,
  );

  manifest.capabilities.enabled.push('frontend');
  assert.ok(
    resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] })
      .ambientSkillIds.includes(DESIGN_SKILL_ID),
  );

  // An explicit disable still wins over the capability, as it does for every skill.
  manifest.skills.disabled.push(DESIGN_SKILL_ID);
  assert.equal(
    resolveWorkspaceSkillSelection({ manifest, activeCapabilities: ['frontend'] })
      .ambientSkillIds.includes(DESIGN_SKILL_ID),
    false,
  );
});

test('what the capability offers is a skill that ships and serves its workflow', () => {
  const workspace = emptyWorkspace();
  try {
    const workflow = resolveBundledWorkspaceSkill(workspace, DESIGN_SKILL_ID, 'workflow');
    assert.ok(workflow, 'the design skill does not resolve from the shipped library');
    // The default section every skill tool serves. A skill whose `workflow` is the
    // parser's not-found placeholder is a catalog entry that hands back nothing.
    assert.doesNotMatch(workflow.content[0]!.text, /Section "workflow" not found/);
    assert.match(workflow.content[0]!.text, /^## Design workflow/m);

    const description = resolveBundledWorkspaceSkill(workspace, DESIGN_SKILL_ID, 'description');
    assert.ok(description);
    assert.ok(description.content[0]!.text.length > 40);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('the vendored skill ships its references and its licence, not just its prose', () => {
  const root = path.join(SHIPPED_SKILLS, 'design', DESIGN_SKILL_ID);
  assert.ok(fs.existsSync(path.join(root, 'SKILL.md')));
  // D3: the licence travels as a file beside the skill; the copy step generates
  // the package notice from the licence files that actually landed.
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(
    fs.readFileSync(path.join(PACKAGE_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8'),
    new RegExp(`### skills/design/${DESIGN_SKILL_ID}\\b`),
  );

  // Its body links to `references/…` on nearly every rule. Shipping the prose
  // without the references it cites is the same defect as an absent skill.
  const body = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const cited = new Set(
    [...body.matchAll(/\(references\/([A-Za-z0-9._/-]+\.md)\)/g)].map((match) => match[1]!),
  );
  assert.ok(cited.size > 5, 'expected the skill body to cite its reference files');
  for (const reference of cited) {
    assert.ok(
      fs.existsSync(path.join(root, 'references', reference)),
      `SKILL.md cites references/${reference}, which does not ship`,
    );
  }
});

test('the boundary against brainrouter-rules is written where the model will read it', () => {
  // D4: two documents telling an agent how to write UI is how they drift apart.
  // The boundary has to be in the skill itself — a rules file the model never
  // loads cannot resolve a conflict at generation time.
  const body = fs.readFileSync(path.join(SHIPPED_SKILLS, 'design', DESIGN_SKILL_ID, 'SKILL.md'), 'utf8');
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]!;
  assert.match(frontmatter, /does not govern work on BrainRouter itself/i);
  assert.match(frontmatter, /brainrouter-rules\//);
  assert.match(body, /^## Where this skill applies, and where it does not$/m);
});

test('every skill a workspace profile offers is a skill that ships', () => {
  // ADR-031 §6.2 / ADR-029 F1. The design profile named five that the old
  // hand-copied bundle did not carry; this asserts the general rule so the next
  // profile edit cannot reintroduce it.
  const shipped = new Set<string>();
  for (const category of fs.readdirSync(SHIPPED_SKILLS, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const skill of fs.readdirSync(path.join(SHIPPED_SKILLS, category.name), { withFileTypes: true })) {
      if (skill.isDirectory() && fs.existsSync(path.join(SHIPPED_SKILLS, category.name, skill.name, 'SKILL.md'))) {
        shipped.add(skill.name);
      }
    }
  }
  const packs = inspectWorkspaceProfilePlugins();
  assert.deepEqual(packs.unavailable, [], 'a package-owned skill pack is unavailable');
  for (const pack of packs.available) {
    for (const id of pack.skillIds) {
      if (fs.existsSync(path.join(pack.skillsRoot, id, 'SKILL.md'))) shipped.add(id);
    }
  }

  for (const profile of WORKSPACE_PROFILES) {
    for (const id of profile.skills.enabled) {
      assert.ok(shipped.has(id), `profile "${profile.id}" offers "${id}", which does not ship`);
    }
  }
});
