import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { executeOrchestrationTool, type OrchestrationContext } from '../orchestration/tools.js';
import { createSession, getSession, updateSession } from '../orchestration/session/orchestrator.js';
import { childSessionKey } from '../mcp/mcpUtils.js';
import { appendTranscriptEntry } from '../session/sessionStore.js';

function ctx(workspace: string): OrchestrationContext {
  return {
    workspaceRoot: workspace,
    parentSessionKey: 'parent-session',
    parentAccessMode: 'shell',
    mcpClient: {
      async listTools() { return { tools: [] }; },
      async callTool() { return { isError: false, content: [] }; },
    } as any,
    llmConfig: { provider: 'openai', apiKey: 'k', model: 'test-model' },
    launchCwd: workspace,
  };
}

test('send_input resumes an existing child transcript for one more turn', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-send-input-'));
  const child = createSession(workspace, {
    role: 'explorer',
    prompt: 'Map the code',
    parentSessionKey: 'parent-session',
    access: 'read',
  });
  appendTranscriptEntry(workspace, childSessionKey('parent-session', child.id), {
    role: 'user',
    content: 'Map the code',
  });
  updateSession(workspace, child.id, { status: 'completed', finalOutput: 'Mapped.' });

  const original = Agent.prototype.runTurn;
  const prompts: string[] = [];
  (Agent.prototype as any).runTurn = async function (prompt: string) {
    prompts.push(prompt);
    return `continued:${prompt}`;
  };
  try {
    const result = JSON.parse(await executeOrchestrationTool('send_input', {
      id: child.id,
      message: 'Now inspect the tests.',
    }, ctx(workspace)));

    assert.equal(result.resumed, true);
    assert.equal(result.id, child.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.finalOutput, 'continued:Now inspect the tests.');
    assert.deepEqual(prompts, ['Now inspect the tests.']);
    assert.equal(getSession(workspace, child.id)?.finalOutput, 'continued:Now inspect the tests.');
  } finally {
    (Agent.prototype as any).runTurn = original;
  }
});

test('resume_agent supplies a default continuation prompt', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-resume-agent-'));
  const child = createSession(workspace, {
    role: 'explorer',
    prompt: 'Map the code',
    parentSessionKey: 'parent-session',
    access: 'read',
  });
  updateSession(workspace, child.id, { status: 'closed', finalOutput: 'Closed.' });

  const original = Agent.prototype.runTurn;
  let promptSeen = '';
  (Agent.prototype as any).runTurn = async function (prompt: string) {
    promptSeen = prompt;
    return 'resumed output';
  };
  try {
    const result = JSON.parse(await executeOrchestrationTool('resume_agent', { id: child.id }, ctx(workspace)));

    assert.equal(result.resumed, true);
    assert.match(promptSeen, /Continue from the current child-agent transcript/);
    assert.equal(getSession(workspace, child.id)?.status, 'completed');
    assert.equal(getSession(workspace, child.id)?.finalOutput, 'resumed output');
  } finally {
    (Agent.prototype as any).runTurn = original;
  }
});
