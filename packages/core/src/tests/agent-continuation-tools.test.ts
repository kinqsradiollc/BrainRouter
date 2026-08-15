import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { executeOrchestrationTool, type OrchestrationContext } from '../orchestration/tools.js';
import { createSession, getSession, updateSession } from '../orchestration/session/orchestrator.js';
import { childSessionKey } from '../mcp/mcpUtils.js';
import { appendTranscriptEntry } from '../session/transcript/sessionStore.js';

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

test('ADR-040 reviewed PhasePlans keep every child and lifecycle edge executor-owned', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-reviewed-edges-'));
  const unrelated = createSession(workspace, {
    role: 'explorer',
    prompt: 'Unrelated work',
    parentSessionKey: 'other-parent',
    access: 'read',
  });
  const launchContext = ctx(workspace);
  launchContext.executionLaunch = {
    assertAuthorityCurrent: () => {},
  } as OrchestrationContext['executionLaunch'];
  const descendantContext = {
    ...ctx(workspace),
    executionAuthorityGuard: () => {},
  };

  for (const name of [
    'profile_stage',
    'task_agent',
    'delegate_agent',
    'delegate_reviewer',
    'spawn_agent',
    'spawn_agents',
    'list_agents',
    'wait_agent',
    'wait_agents',
    'read_agent_transcript',
    'close_agent',
    'send_input',
    'resume_agent',
    'route_task',
    'run_workflow',
    'run_workflow_graph',
  ]) {
    await assert.rejects(
      () => executeOrchestrationTool(name, { id: unrelated.id }, descendantContext),
      /deterministic executor owns every declared child and lifecycle edge/,
      `${name} must not cross the reviewed PhasePlan tree`,
    );
  }
  assert.equal(getSession(workspace, unrelated.id)?.status, 'pending');

  await assert.rejects(
    () => executeOrchestrationTool('send_input', { id: unrelated.id, message: 'Continue.' }, launchContext),
    /exact PhasePlan does not declare child-continuation edges/,
  );
  await assert.rejects(
    () => executeOrchestrationTool('resume_agent', { id: unrelated.id }, launchContext),
    /exact PhasePlan does not declare child-continuation edges/,
  );
});

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
