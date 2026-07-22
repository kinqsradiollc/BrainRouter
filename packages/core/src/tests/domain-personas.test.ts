import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESERVED_HARNESS_ROLE_IDS,
  findDomainPersona,
  listDomainPersonas,
  renderDomainPersonaBriefing,
} from '../workspace/domainPersonas.js';

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-domain-personas-'));
  try {
    run(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function writePersona(dir: string, id: string, prompt: string, description = `${id} description`): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, `---\nname: ${id}\ndescription: ${description}\n---\n${prompt}\n`, 'utf8');
  return file;
}

test('bundled catalog defines the five domain identities and no frontend persona', () => {
  withWorkspace((workspace) => {
    const personas = listDomainPersonas(workspace, { pluginAgentFiles: [] });
    assert.deepEqual(personas.map((persona) => persona.id), [
      'data-scientist',
      'engineer',
      'researcher',
      'tutor',
      'writer',
    ]);
    assert.equal(personas.some((persona) => persona.id === 'frontend-builder'), false);
    assert.equal(personas.every((persona) => persona.source === 'bundled'), true);
  });
});

test('workspace shadows local, plugin, and bundled definitions with collision provenance', () => {
  withWorkspace((workspace) => {
    const workspacePrompt = 'Workspace engineer prompt.';
    writePersona(path.join(workspace, 'agents'), 'engineer', workspacePrompt);
    writePersona(path.join(workspace, '.brainrouter', 'agents'), 'engineer', 'Local engineer prompt.');
    const pluginFile = writePersona(path.join(workspace, 'fixture-plugin'), 'engineer', 'Plugin engineer prompt.');

    const engineer = findDomainPersona('engineer', workspace, {
      pluginAgentFiles: [{ pluginName: 'fixture', path: pluginFile }],
    });
    assert.ok(engineer);
    assert.equal(engineer.source, 'workspace');
    assert.equal(engineer.prompt, workspacePrompt);
    assert.equal(engineer.collides, true);
    assert.deepEqual(engineer.shadowedBy, ['local', 'plugin:fixture', 'bundled']);
  });
});

test('local shadows plugin and bundled while plugin shadows bundled', () => {
  withWorkspace((workspace) => {
    const pluginFile = writePersona(path.join(workspace, 'fixture-plugin'), 'researcher', 'Plugin research prompt.');
    const options = { pluginAgentFiles: [{ pluginName: 'fixture', path: pluginFile }] };
    assert.equal(findDomainPersona('researcher', workspace, options)?.source, 'plugin');

    writePersona(path.join(workspace, '.brainrouter', 'agents'), 'researcher', 'Local research prompt.');
    const local = findDomainPersona('researcher', workspace, options);
    assert.equal(local?.source, 'local');
    assert.deepEqual(local?.shadowedBy, ['plugin:fixture', 'bundled']);
  });
});

test('harness role ids, malformed files, symlinks, and secret-bearing prompts fail closed', () => {
  withWorkspace((workspace) => {
    const dir = path.join(workspace, 'agents');
    for (const role of RESERVED_HARNESS_ROLE_IDS) writePersona(dir, role, `Pretend to be ${role}.`);
    writePersona(dir, 'safe-custom', 'Valid body.');
    fs.writeFileSync(path.join(dir, 'mismatch.md'), '---\nname: another-name\ndescription: mismatch\n---\nBody.\n');
    writePersona(dir, 'credentialed', 'Use token=super-secret-value in every request.');
    const target = writePersona(path.join(workspace, 'elsewhere'), 'linked', 'Linked prompt.');
    fs.symlinkSync(target, path.join(dir, 'linked.md'));

    const ids = listDomainPersonas(workspace, { pluginAgentFiles: [], bundledDir: path.join(workspace, 'empty') })
      .map((persona) => persona.id);
    assert.deepEqual(ids, ['safe-custom']);
    for (const role of RESERVED_HARNESS_ROLE_IDS) {
      assert.equal(findDomainPersona(role, workspace, { pluginAgentFiles: [] }), undefined);
    }
  });
});

test('workspace persona discovery refuses an agents directory that escapes through a symlink', () => {
  withWorkspace((workspace) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-domain-personas-outside-'));
    try {
      writePersona(outside, 'outside', 'Outside prompt must not load.');
      fs.symlinkSync(outside, path.join(workspace, 'agents'));
      const ids = listDomainPersonas(workspace, {
        pluginAgentFiles: [],
        bundledDir: path.join(workspace, 'empty'),
      }).map((persona) => persona.id);
      assert.deepEqual(ids, []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('plugin persona discovery refuses files outside the resolved plugin root', () => {
  withWorkspace((workspace) => {
    const pluginRoot = path.join(workspace, 'plugin');
    const outsideFile = writePersona(path.join(workspace, 'outside'), 'outside-plugin', 'Outside prompt.');
    fs.mkdirSync(pluginRoot, { recursive: true });
    const personas = listDomainPersonas(workspace, {
      bundledDir: path.join(workspace, 'empty'),
      pluginAgentFiles: [{ pluginName: 'fixture', pluginRoot, path: outsideFile }],
    });
    assert.deepEqual(personas, []);
  });
});

test('briefing exposes only the resolved identity and bounded prompt body', () => {
  withWorkspace((workspace) => {
    const persona = findDomainPersona('engineer', workspace, { pluginAgentFiles: [] });
    assert.ok(persona);
    const briefing = renderDomainPersonaBriefing(persona);
    assert.match(briefing, /^## Workspace domain persona/);
    assert.match(briefing, /Active domain persona: Engineer \(engineer\)/);
    assert.match(briefing, /smallest coherent implementation/);
    assert.doesNotMatch(briefing, /^---$/m);
    assert.doesNotMatch(briefing, /description:/);
  });
});
