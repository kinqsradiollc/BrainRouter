import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { buildRootContextEnvelope } from '../context/contextEnvelope.js';
import {
  buildDelegatedTaskPacket,
  renderDelegatedTaskPacket,
} from '../orchestration/delegation/taskPacket.js';
import { summarize } from '../orchestration/tools/summarize.js';

const EMPTY_CAPABILITIES = {
  active: [],
  reasons: [],
  skillPacks: [],
  skills: [],
  toolProfiles: [],
  promptBlocks: [],
};

function packet(overrides: Record<string, unknown> = {}) {
  return buildDelegatedTaskPacket({
    task: 'Inspect the API authorization boundary and report evidence.',
    personaId: 'engineer',
    roleId: 'reviewer',
    capabilities: {
      ...EMPTY_CAPABILITIES,
      active: ['backend'],
      reasons: ['task describes server or API work'],
    },
    accessMode: 'read',
    localTools: ['read_file', 'grep_search'],
    mcpTools: ['mcp_docs_search'],
    disallowedTools: ['run_command'],
    budgets: {
      maxWallClockMs: 120_000,
      maxPromptTokens: 32_000,
      maxCompletionTokens: 4_000,
      maxIterations: 20,
      maxDepth: 2,
      maxOutputChars: 12_000,
    },
    ...overrides,
  } as any);
}

test('delegated packet is bounded, versioned, and carries recomputed capability state', () => {
  const result = packet({
    planState: 'step '.repeat(1_000),
    recalledRecordIds: Array.from({ length: 90 }, (_, index) => `record-${index}`),
    sourceFiles: Array.from({ length: 130 }, (_, index) => `src/file-${index}.ts`),
  });

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.capabilities.active, ['backend']);
  assert.ok((result.planState?.length ?? 0) <= 1_500);
  assert.equal(result.memoryBriefing.recordIds.length, 50);
  assert.equal(result.sources.files.length, 100);
  assert.deepEqual(result.toolPolicyCeiling.localTools, ['read_file', 'grep_search']);
});

test('delegated packet references selected envelope layers without inheriting transcript or capability overlay', () => {
  const envelope = buildRootContextEnvelope([
    { role: 'system', content: 'base policy' },
    { role: 'system', content: '<!--brainrouter:goal-anchor-->\nShip safely.' },
    { role: 'system', content: '<!--brainrouter:workspace-capabilities-->\nParent backend overlay.' },
    { role: 'user', content: 'parent-only conversation detail' },
    { role: 'tool', tool_call_id: 'call-1', content: 'parent-only tool output' },
  ]);

  const result = packet({ parentEnvelope: envelope });
  assert.deepEqual(
    result.contextLayers.map((layer) => layer.kind),
    ['required-policy', 'plan-state'],
  );
  const rendered = renderDelegatedTaskPacket(result);
  assert.doesNotMatch(rendered, /parent-only conversation detail/);
  assert.doesNotMatch(rendered, /parent-only tool output/);
  assert.doesNotMatch(rendered, /Parent backend overlay/);
});

test('delegated MCP discovery is constrained by the explicit parent ceiling', async () => {
  const tools = [
    { name: 'mcp_docs_search', __rawName: 'search', __serverId: 'docs' },
    { name: 'mcp_admin_delete', __rawName: 'delete', __serverId: 'admin' },
  ];
  const mcp: any = {
    listTools: async () => ({ tools }),
    callTool: async () => ({ content: [] }),
    close: async () => {},
    getServerIds: () => ['docs', 'admin'],
  };
  const agent = new Agent(
    mcp,
    { provider: 'openai', apiKey: 'test', model: 'test-model' },
    {
      workspaceRoot: process.cwd(),
      launchCwd: process.cwd(),
      silent: true,
      authorityToolCeiling: {
        local: [],
        mcp: ['mcp_docs_search'],
      },
    },
  );

  assert.deepEqual(
    (await agent.visibleMcpToolList()).map((tool) => tool.name),
    ['mcp_docs_search'],
  );
  assert.equal(await agent.findVisibleMcpTool('mcp_admin_delete'), undefined);
});

test('wait/list projection exposes a generic structured child result', () => {
  const result = summarize({
    id: 'child-1',
    role: 'worker',
    access: 'write',
    parentSessionKey: 'parent',
    prompt: 'implement',
    status: 'completed',
    startedAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    completedAt: '2026-07-26T00:00:01.000Z',
    pid: 1,
    finalOutput: [
      '## Headline',
      'Implemented the boundary.',
      '## Files changed',
      '- src/api.ts',
      '## Summary',
      'Added the required guard.',
      '## Tests to run',
      '- npm test',
      '## Risks',
      'None known.',
    ].join('\n'),
    delegatedTaskPacket: packet(),
  }, true) as any;

  assert.deepEqual(result.result.conclusions, ['Implemented the boundary.']);
  assert.deepEqual(result.result.changes, ['- src/api.ts', 'Added the required guard.']);
  assert.deepEqual(result.result.verification, ['- npm test']);
  assert.deepEqual(result.result.unresolved, ['None known.']);
  assert.equal(result.taskPacket.schemaVersion, 1);
});
