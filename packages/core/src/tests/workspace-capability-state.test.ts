/**
 * W4a workspace capability runtime state remains additive, task-scoped, and an
 * exact prompt no-op when no readable manifest exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshWorkspaceCapabilityState } from '../agent/workspaceCapabilityState.js';
import { findById } from '../orchestration/agents/agentRegistry.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import type { WorkspaceCapabilityStateHost } from '../agent/workspaceCapabilityState.js';

function makeHost(workspaceRoot: string, workspaceAgentId?: string) {
  const calls: Array<{ kind: 'replace' | 'remove'; tag: string; content?: string }> = [];
  let messages = [{ role: 'system', content: 'unchanged base prompt' }];
  const host: WorkspaceCapabilityStateHost = {
    workspaceRoot,
    workspaceAgentId,
    activeWorkspacePersonaId: undefined,
    activeWorkspaceCapabilities: {
      active: [], reasons: [], skillPacks: [], skills: [], toolProfiles: [], promptBlocks: [],
    },
    replaceTaggedSystemMessage(tag, content) {
      const marker = `<!--brainrouter:${tag}-->\n`;
      messages = messages.filter((message) => !message.content.startsWith(marker));
      messages.push({ role: 'system', content: `${marker}${content}` });
      calls.push({ kind: 'replace', tag, content });
    },
    removeTaggedSystemMessage(tag) {
      const marker = `<!--brainrouter:${tag}-->\n`;
      messages = messages.filter((message) => !message.content.startsWith(marker));
      calls.push({ kind: 'remove', tag });
    },
  };
  return { host, calls, messages: () => messages };
}

test('missing manifests do not add a model-visible capability prompt', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-empty-'));
  try {
    const { host, calls, messages } = makeHost(workspace);
    const before = JSON.stringify(messages());
    const resolved = refreshWorkspaceCapabilityState(host, 'Build a responsive React dashboard.');
    assert.deepEqual(resolved.active, []);
    assert.deepEqual(calls, [
      { kind: 'remove', tag: 'workspace-domain-persona' },
      { kind: 'remove', tag: 'workspace-capabilities' },
    ]);
    assert.equal(JSON.stringify(messages()), before, 'no manifest keeps model-visible prompt bytes unchanged');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('frontend task paths activate the engineer prompt and reviewed task-time tool profiles', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-engineer-'));
  try {
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
    manifest.agents.enabled.push('worker');
    saveWorkspaceManifest(workspace, manifest);
    const { host, calls } = makeHost(workspace, 'worker');
    const resolved = refreshWorkspaceCapabilityState(host, 'Please repair src/components/Card.tsx.');

    assert.equal(host.activeWorkspacePersonaId, 'engineer', 'reserved harness role falls back to domain default');
    assert.deepEqual(resolved.active, ['frontend']);
    assert.deepEqual(resolved.skills, [], 'prompt activation does not grant catalog entries');
    assert.deepEqual(resolved.toolProfiles, ['browser', 'artifacts', 'interactive-browser']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.tag, 'workspace-domain-persona');
    assert.match(calls[0]?.content ?? '', /Profile: Engineering \(engineering\)/);
    assert.match(calls[0]?.content ?? '', /Available task capabilities: frontend, backend/);
    assert.match(calls[0]?.content ?? '', /Active task capabilities: frontend/);
    assert.match(calls[0]?.content ?? '', /Active domain persona: Engineer/);
    assert.equal(calls[1]?.kind, 'replace');
    assert.equal(calls[1]?.tag, 'workspace-capabilities');
    assert.match(calls[1]?.content ?? '', /Stay in the engineer persona/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('backend tasks activate the engineer prompt without granting new tool groups', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-backend-'));
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'service', profile: 'engineering', by: 'wizard' }),
    );
    const { host, calls } = makeHost(workspace);
    const resolved = refreshWorkspaceCapabilityState(
      host,
      'Add authorization checks to the API endpoint and database transaction.',
    );

    assert.equal(host.activeWorkspacePersonaId, 'engineer');
    assert.deepEqual(resolved.active, ['backend']);
    assert.deepEqual(resolved.skills, [], 'prompt activation does not grant catalog entries');
    assert.deepEqual(resolved.toolProfiles, ['coding', 'shell', 'artifacts']);
    assert.match(calls[0]?.content ?? '', /Active task capabilities: backend/);
    assert.match(calls[1]?.content ?? '', /does not itself grant shell, network, database, or write access/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('reviewed Writing academic-paper capability activates only for matching tasks', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-paper-'));
  try {
    const manifest = createWorkspaceManifest({ name: 'paper', profile: 'writing', by: 'wizard' });
    manifest.capabilities.enabled.push('academic-paper');
    saveWorkspaceManifest(workspace, manifest);
    const { host, calls } = makeHost(workspace);
    const resolved = refreshWorkspaceCapabilityState(
      host,
      'Audit the citations in this academic paper.',
    );

    assert.equal(host.activeWorkspacePersonaId, 'writer');
    assert.deepEqual(resolved.active, ['academic-paper']);
    assert.deepEqual(resolved.skills, [], 'prompt activation does not grant catalog entries');
    assert.deepEqual(resolved.toolProfiles, [
      'workspace-files', 'browser', 'research-notes', 'artifacts',
    ]);
    assert.match(calls[0]?.content ?? '', /Available task capabilities: academic-paper/);
    assert.match(calls[1]?.content ?? '', /Stay in the writer persona/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('reviewed Research computational capability activates without changing persona', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-computational-'));
  try {
    const manifest = createWorkspaceManifest({ name: 'analysis', profile: 'research', by: 'wizard' });
    manifest.capabilities.enabled.push('computational-research');
    saveWorkspaceManifest(workspace, manifest);
    const { host, calls } = makeHost(workspace);
    const resolved = refreshWorkspaceCapabilityState(
      host,
      'Run a reproducible computational analysis of this dataset.',
    );

    assert.equal(host.activeWorkspacePersonaId, 'researcher');
    assert.deepEqual(resolved.active, ['computational-research']);
    assert.deepEqual(resolved.toolProfiles, [
      'coding', 'shell', 'browser', 'research-notes', 'artifacts',
    ]);
    assert.match(calls[0]?.content ?? '', /Available task capabilities: computational-research/);
    assert.match(calls[1]?.content ?? '', /Preserve the active domain persona/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('reviewed Data Science visualization capability activates without changing persona', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-visualization-'));
  try {
    const manifest = createWorkspaceManifest({
      name: 'visual-analysis',
      profile: 'data-science',
      by: 'wizard',
    });
    manifest.capabilities.enabled.push('data-visualization');
    saveWorkspaceManifest(workspace, manifest);
    const { host, calls } = makeHost(workspace);
    const resolved = refreshWorkspaceCapabilityState(
      host,
      'Build an accessible analytical dashboard and verify every chart.',
    );

    assert.equal(host.activeWorkspacePersonaId, 'data-scientist');
    assert.deepEqual(resolved.active, ['data-visualization']);
    assert.deepEqual(resolved.toolProfiles, [
      'coding', 'shell', 'artifacts', 'interactive-browser',
    ]);
    assert.match(calls[0]?.content ?? '', /Available task capabilities: data-visualization/);
    assert.match(calls[1]?.content ?? '', /Stay in the data-scientist persona/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('switching workspaces replaces profile, persona, and capability briefing state', () => {
  const engineering = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-switch-engineering-'));
  const research = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-switch-research-'));
  try {
    saveWorkspaceManifest(
      engineering,
      createWorkspaceManifest({ name: 'app', profile: 'engineering', by: 'wizard' }),
    );
    saveWorkspaceManifest(
      research,
      createWorkspaceManifest({ name: 'sources', profile: 'research', by: 'wizard' }),
    );
    const { host, messages } = makeHost(engineering);
    refreshWorkspaceCapabilityState(host, 'Build a responsive dashboard.');
    host.workspaceRoot = research;
    refreshWorkspaceCapabilityState(host, 'Compare the cited sources.');

    const rendered = messages().map((message) => message.content).join('\n');
    assert.match(rendered, /Profile: Research \(research\)/);
    assert.match(rendered, /Active domain persona: Researcher/);
    assert.match(rendered, /Available task capabilities: none/);
    assert.match(rendered, /Active task capabilities: none/);
    assert.doesNotMatch(rendered, /Profile: Engineering/);
    assert.doesNotMatch(rendered, /Active domain persona: Engineer/);
    assert.doesNotMatch(rendered, /Frontend engineering capability is active/);
  } finally {
    fs.rmSync(engineering, { recursive: true, force: true });
    fs.rmSync(research, { recursive: true, force: true });
  }
});

test('custom workspaces still brief the reviewed profile without inventing a persona', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-custom-'));
  try {
    saveWorkspaceManifest(
      workspace,
      createWorkspaceManifest({ name: 'blank', profile: 'custom', by: 'wizard' }),
    );
    const { host, calls } = makeHost(workspace);
    refreshWorkspaceCapabilityState(host, 'Inspect this workspace.');

    assert.equal(host.activeWorkspacePersonaId, undefined);
    assert.equal(calls[0]?.kind, 'replace');
    assert.equal(calls[0]?.tag, 'workspace-domain-persona');
    assert.match(calls[0]?.content ?? '', /Profile: Custom \(custom\)/);
    assert.match(calls[0]?.content ?? '', /Available task capabilities: none/);
    assert.doesNotMatch(calls[0]?.content ?? '', /Active domain persona:/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('an enabled non-engineering domain agent retracts a stale frontend prompt', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-domain-'));
  try {
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
    manifest.agents.enabled.push('researcher');
    saveWorkspaceManifest(workspace, manifest);
    const { host, calls } = makeHost(workspace, 'researcher');
    const resolved = refreshWorkspaceCapabilityState(host, 'Build a responsive React dashboard.');

    assert.equal(host.activeWorkspacePersonaId, 'researcher');
    assert.deepEqual(resolved.active, []);
    assert.equal(calls[0]?.tag, 'workspace-domain-persona');
    assert.match(calls[0]?.content ?? '', /Active domain persona: Researcher/);
    assert.deepEqual(calls[1], { kind: 'remove', tag: 'workspace-capabilities' });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('project JSON execution policy becomes a domain identity only with a same-id Markdown persona', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cap-state-paired-'));
  try {
    const agentsDir = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'specialist.json'), JSON.stringify({
      id: 'specialist',
      displayName: 'Project specialist',
      whenToUse: 'Use for this project.',
      prompt: 'Apply the project execution policy.',
      model: null,
      effort: null,
      defaultAccess: 'read',
      toolScope: { local: [], mcp: [] },
      disallowedTools: [],
      maxIterations: 4,
      timeoutMs: 60_000,
      maxResultChars: 8_000,
      subagents: [],
      delegateName: 'delegate_specialist',
      tier: 'worker',
      outputContract: null,
    }), 'utf8');
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
    manifest.persona.enabled.push('specialist');
    manifest.orchestration.availableRoles.push('specialist');
    saveWorkspaceManifest(workspace, manifest);

    assert.equal(findById('specialist', workspace)?.source, 'workspace', 'JSON remains an executable definition');
    const jsonOnly = makeHost(workspace, 'specialist');
    refreshWorkspaceCapabilityState(jsonOnly.host, 'Investigate this project.');
    assert.equal(jsonOnly.host.activeWorkspacePersonaId, 'engineer', 'JSON-only executor uses the domain default');

    fs.writeFileSync(path.join(agentsDir, 'specialist.md'), [
      '---',
      'name: specialist',
      'description: Project-specific domain specialist.',
      '---',
      'Use the project-specific specialist perspective.',
      '',
    ].join('\n'), 'utf8');
    const paired = makeHost(workspace, 'specialist');
    refreshWorkspaceCapabilityState(paired.host, 'Investigate this project.');
    assert.equal(paired.host.activeWorkspacePersonaId, 'specialist');
    assert.match(paired.calls[0]?.content ?? '', /project-specific specialist perspective/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
