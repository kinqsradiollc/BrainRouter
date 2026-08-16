import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import { resolveWorkspaceMemoryCaptureContext } from '../workspace/memoryCapture.js';

function makeCaptureClient(calls: Array<Record<string, unknown>>): any {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === 'memory_capture_turn') calls.push(args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ cognitiveExtractionStatus: 'skipped' }) }],
      };
    },
    listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
    close: async () => {},
  };
}

function writeManifest(workspace: string, profile: 'engineering' | 'research'): void {
  saveWorkspaceManifest(
    workspace,
    createWorkspaceManifest({ name: path.basename(workspace), profile, by: 'wizard' }),
  );
}

test('workspace memory context normalizes reviewed tags and fails closed on hand-edited values', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-memory-tags-normalize-'));
  try {
    const manifest = createWorkspaceManifest({
      name: 'tagged',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        memory: {
          tags: ['Engineering', 'engineering', 'ui:react', 'not a tag', 'x'.repeat(129)],
          captureHint: '',
        },
      },
    });
    saveWorkspaceManifest(workspace, manifest);

    assert.deepEqual(resolveWorkspaceMemoryCaptureContext(workspace), {
      memoryTags: ['engineering', 'ui:react'],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('capture replaces manifest memory tags across workspace switches', async () => {
  const engineering = fs.mkdtempSync(path.join(os.tmpdir(), 'br-memory-tags-engineering-'));
  const research = fs.mkdtempSync(path.join(os.tmpdir(), 'br-memory-tags-research-'));
  try {
    writeManifest(engineering, 'engineering');
    writeManifest(research, 'research');
    const calls: Array<Record<string, unknown>> = [];
    const agent = new Agent(
      makeCaptureClient(calls),
      { provider: 'openai', apiKey: 'test', model: 'test-model' },
      { workspaceRoot: engineering, launchCwd: engineering, sessionKey: 'session:memory-tags' },
    );

    await agent.captureTurn('Implement the component.', 'Implemented the component.');
    agent.workspaceRoot = research;
    await agent.captureTurn('Compare the sources.', 'Compared the sources.');

    assert.deepEqual(calls.map((call) => call.memoryTags), [['engineering'], ['research']]);
    // ADR-017 D3 — the main per-turn capture now sends the workspace root so the
    // brain hashes it to a stable workspace_tag; it tracks the active workspace
    // across switches (previously this hot path sent no workspaceRoot at all).
    assert.deepEqual(calls.map((call) => call.workspaceRoot), [engineering, research]);
  } finally {
    fs.rmSync(engineering, { recursive: true, force: true });
    fs.rmSync(research, { recursive: true, force: true });
  }
});

test('capture keeps the exact legacy memory context when no manifest exists', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-memory-tags-legacy-'));
  try {
    const calls: Array<Record<string, unknown>> = [];
    const agent = new Agent(
      makeCaptureClient(calls),
      { provider: 'openai', apiKey: 'test', model: 'test-model' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 'session:legacy' },
    );

    await agent.captureTurn('Keep legacy behavior.', 'Legacy behavior remains.');

    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], 'memoryTags'), false);
    assert.equal(calls[0].workspaceRoot, workspace); // ADR-017 D3 — workspace root now sent (drives workspace_tag)
    assert.equal(Object.hasOwn(calls[0], 'projectName'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
