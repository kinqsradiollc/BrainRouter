import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeProvides } from '../plugin/discovery.js';
import { parsePersonaDefinition } from '../workspace/personaDefinitionFile.js';
import {
  findWorkspaceProfilePlugin,
  inspectWorkspaceProfilePlugins,
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS,
} from '../workspace/profilePlugins.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function allowedTools(skillId: string): string[] {
  const research = findWorkspaceProfilePlugin('research');
  assert.ok(research);
  const body = fs.readFileSync(path.join(research.skillsRoot, skillId, 'SKILL.md'), 'utf8');
  const flow = body.match(/^allowed-tools:\s*\[([^\]]*)\]$/m)?.[1];
  assert.notEqual(flow, undefined, `${skillId} must declare a bounded allowed-tools list`);
  return flow!.split(',').map((value) => value.trim()).filter(Boolean);
}

function intersection(...lists: readonly string[][]): string[] {
  return lists.reduce<string[]>(
    (shared, list) => shared.filter((tool) => list.includes(tool)),
    [...(lists[0] ?? [])],
  );
}

test('C2 package-owned profile plugins use the standard versioned plugin contract', () => {
  const catalog = inspectWorkspaceProfilePlugins();
  const expectedVersions = new Map([
    ['research', '2.4.0'],
    ['study', '2.2.0'],
    ['data', '2.1.0'],
    ['writing', '2.1.0'],
    ['frontend', '1.1.0'],
    ['backend', '1.0.0'],
  ]);

  assert.deepEqual(catalog.unavailable, []);
  assert.deepEqual(
    catalog.available.map((plugin) => plugin.id),
    ['study', 'research', 'data', 'writing', 'frontend', 'backend'],
  );
  for (const plugin of catalog.available) {
    assert.equal(plugin.version, expectedVersions.get(plugin.id));
    assert.equal(plugin.plugin.manifest.version, plugin.version);
    assert.equal(plugin.plugin.manifest.name, plugin.pluginName);
    assert.equal(summarizeProvides(plugin.plugin).skills, plugin.skillIds.length);
    assert.equal(summarizeProvides(plugin.plugin).personas, plugin.personaIds.length);
    assert.equal(summarizeProvides(plugin.plugin).agents, 0);
    if (plugin.personaIds.length === 0) {
      assert.equal(plugin.personasRoot, undefined);
    } else {
      const personasRoot = plugin.personasRoot;
      assert.ok(personasRoot);
      for (const personaId of plugin.personaIds) {
        const body: string = fs.readFileSync(path.join(personasRoot, `${personaId}.json`), 'utf8');
        assert.equal(parsePersonaDefinition(body, personaId).id, personaId);
      }
    }
  }
});

test('research profile exposes separate task-selectable workflow skills', () => {
  const research = findWorkspaceProfilePlugin('research');

  assert.ok(research);
  assert.equal(research.kind, 'profile');
  assert.equal(research.version, '2.4.0');
  assert.deepEqual(research.skillIds, [
    'research-question-skill',
    'source-strategy-skill',
    'iterative-evidence-skill',
    'evidence-research-skill',
    'claim-ledger-skill',
    'source-synthesis-skill',
    'citation-verification-skill',
    'research-review-skill',
    'academic-paper-drafting-skill',
    'academic-paper-review-skill',
  ]);
});

test('research skills retain folder, artifact, and citation tools through stacked intersections', () => {
  const research = findWorkspaceProfilePlugin('research');
  assert.ok(research);
  for (const skillId of research.skillIds) {
    assert.ok(allowedTools(skillId).includes('list_dir'), `${skillId}: workspace discovery`);
  }

  for (const skillId of ['academic-paper-drafting-skill', 'source-synthesis-skill']) {
    assert.ok(allowedTools(skillId).includes('artifact_write'), `${skillId}: deliverable artifact`);
  }

  const researchAudit = intersection(
    allowedTools('citation-verification-skill'),
    allowedTools('research-review-skill'),
  );
  assert.ok(researchAudit.includes('fetch_url'));
  assert.ok(researchAudit.includes('web_search'));

  const paperAudit = intersection(
    allowedTools('citation-verification-skill'),
    allowedTools('academic-paper-review-skill'),
  );
  assert.ok(paperAudit.includes('fetch_url'));
  assert.ok(paperAudit.includes('web_search'));

  const reviewer = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, 'agents', 'reviewer.json'), 'utf8'),
  ) as { defaultAccess: string; disallowedTools: string[] };
  assert.equal(reviewer.defaultAccess, 'read');
  assert.equal(reviewer.disallowedTools.includes('fetch_url'), false);
  assert.equal(reviewer.disallowedTools.includes('web_search'), false);
});

test('study profile exposes separate task-selectable tutoring workflows', () => {
  const study = findWorkspaceProfilePlugin('study');

  assert.ok(study);
  assert.equal(study.kind, 'profile');
  assert.equal(study.version, '2.2.0');
  assert.deepEqual(study.skillIds, [
    'learner-diagnostic-skill',
    'learning-plan-skill',
    'tutoring-explanation-skill',
    'learning-assessment-skill',
    'error-remediation-skill',
    'retrieval-practice-skill',
  ]);
});

test('C2 every declared profile skill is discoverable and machine-addressable', () => {
  const catalog = inspectWorkspaceProfilePlugins();

  for (const plugin of catalog.available) {
    for (const skillId of plugin.skillIds) {
      const skillFile = path.join(plugin.skillsRoot, skillId, 'SKILL.md');
      const body = fs.readFileSync(skillFile, 'utf8');
      assert.match(body, new RegExp(`^---\\nname: ${skillId}\\n`, 'm'));
      assert.match(body, /^description: .+$/m);
      assert.match(body, /^## Overview$/m);
      assert.match(body, /^## When to Use$/m);
      assert.match(body, /^## Workflow$/m);
      assert.match(body, /^## Verification$/m);
    }
  }
});

test('C2 frontend stays a capability plugin and owns the design verification skills', () => {
  const frontend = findWorkspaceProfilePlugin('frontend');

  assert.ok(frontend);
  assert.equal(frontend.kind, 'capability');
  assert.equal(frontend.pluginName, 'capability-frontend');
  assert.deepEqual(frontend.skillIds, ['a11y-skill', 'browser-testing-skill', 'taste-skill']);
  assert.deepEqual(frontend.personaIds, []);
  assert.equal(frontend.personasRoot, undefined);
  assert.equal(WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.some((plugin) => plugin.pluginName.includes('builder')), false);
});

test('backend stays an engineer capability and owns bounded service workflows', () => {
  const backend = findWorkspaceProfilePlugin('backend');

  assert.ok(backend);
  assert.equal(backend.kind, 'capability');
  assert.equal(backend.pluginName, 'capability-backend');
  assert.deepEqual(backend.skillIds, [
    'api-service-design-skill',
    'authorization-boundary-skill',
    'data-integrity-migration-skill',
    'background-work-skill',
    'production-readiness-skill',
    'backend-testing-skill',
  ]);
  assert.deepEqual(backend.personaIds, []);
  assert.equal(backend.personasRoot, undefined);
});

test('C2 profile plugins declare matching personas without executable specialists', () => {
  const catalog = inspectWorkspaceProfilePlugins();
  const personasByProfile = Object.fromEntries(
    catalog.available.map((plugin) => [plugin.id, plugin.personaIds]),
  );

  assert.deepEqual(personasByProfile, {
    study: ['tutor'],
    research: ['researcher'],
    data: ['data-scientist'],
    writing: ['writer'],
    frontend: [],
    backend: [],
  });
});

test('C2 missing package artifacts are reported as unavailable instead of throwing', (t) => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-plugins-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));

  const catalog = inspectWorkspaceProfilePlugins({ root: emptyRoot });
  assert.equal(catalog.available.length, 0);
  assert.equal(catalog.unavailable.length, WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.length);
  assert.equal(findWorkspaceProfilePlugin('frontend', { root: emptyRoot }), undefined);
});

test('C2 malformed package-owned versions fail availability without affecting sibling plugins', (t) => {
  const source = path.dirname(inspectWorkspaceProfilePlugins().available[0].root);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-plugin-version-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.cpSync(source, fixtureRoot, { recursive: true });
  const manifestPath = path.join(fixtureRoot, 'frontend', '.brainrouter-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: 'draft' }, null, 2)}\n`);

  const catalog = inspectWorkspaceProfilePlugins({ root: fixtureRoot });
  assert.deepEqual(catalog.available.map((plugin) => plugin.id), ['study', 'research', 'data', 'writing', 'backend']);
  assert.equal(catalog.unavailable[0]?.id, 'frontend');
  assert.match(catalog.unavailable[0]?.reason ?? '', /semantic/);
});

test('C2 a missing profile persona fails that plugin closed without affecting siblings', (t) => {
  const source = path.dirname(inspectWorkspaceProfilePlugins().available[0].root);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-plugin-persona-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.cpSync(source, fixtureRoot, { recursive: true });
  fs.rmSync(path.join(fixtureRoot, 'research', 'personas', 'researcher.json'));

  const catalog = inspectWorkspaceProfilePlugins({ root: fixtureRoot });
  assert.deepEqual(catalog.available.map((plugin) => plugin.id), ['study', 'data', 'writing', 'frontend', 'backend']);
  assert.equal(catalog.unavailable[0]?.id, 'research');
  assert.match(catalog.unavailable[0]?.reason ?? '', /missing valid persona file: researcher/);
});

test('C2 the published core package declares its profile plugin assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files?: string[] };
  assert.ok(packageJson.files?.includes('profile-plugins'));
});
