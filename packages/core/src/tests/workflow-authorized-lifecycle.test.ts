/**
 * ADR-040 — regression coverage for foreground durable-workflow termination.
 * Stops and authority revocation must remain retryable as interrupted runs;
 * unexpected executor faults must leave a failed ledger, never `running`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrchestrationContext } from '../orchestration/tools.js';
import type { PhaseRunner } from '../orchestration/workflow/phaseOrchestrator.js';
import {
  activateExecutionIntent,
  consumeExecutionIntent,
  createExecutionDispatchReceipt,
  createExecutionIntentOwnerToken,
  issueExecutionIntent,
} from '../orchestration/execution/authority.js';
import { normalizePhasePlanExecutionTarget } from '../orchestration/execution/normalization.js';
import { readRun } from '../workflow/run/workflowRun.js';
import { runWorkflow, runWorkflowAuthorized } from '../workflow/template/workflowTool.js';

const PLAN = {
  title: 'Lifecycle',
  phases: [
    {
      id: 'first',
      title: 'First',
      agents: [{ role: 'explorer', access: 'read', prompt: 'Inspect the first input.' }],
    },
    {
      id: 'second',
      title: 'Second',
      agents: [{ role: 'explorer', access: 'read', prompt: 'Inspect {{input}}.' }],
      inputFrom: ['first'],
      dependsOn: ['first'],
    },
  ],
};

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-workflow-lifecycle-'));
}

function context(workspaceRoot: string, signal?: AbortSignal): OrchestrationContext {
  return {
    workspaceRoot,
    parentSessionKey: 'parent-session',
    interruptSignal: signal,
  } as OrchestrationContext;
}

function authorizedContext(
  workspaceRoot: string,
  args: Record<string, unknown>,
  assertAuthorityCurrent: () => void,
): OrchestrationContext {
  const normalized = normalizePhasePlanExecutionTarget(args);
  if (!normalized.ok) assert.fail(normalized.errors.join('; '));
  const binding = { workspaceRoot, sessionKey: 'parent-session', userId: 'user-1' };
  const owner = createExecutionIntentOwnerToken(binding);
  const handle = issueExecutionIntent(owner, {
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: normalized.target,
  });
  const activated = activateExecutionIntent(owner, handle, { ...binding, turnId: 'turn-1' });
  if (!activated.ok) assert.fail(activated.reason);
  const consumed = consumeExecutionIntent(owner, handle, {
    ...binding,
    source: 'user-command',
    requestId: 'request-1',
    turnId: 'turn-1',
    target: normalized.target,
  });
  if (!consumed.ok) assert.fail(consumed.reason);
  return {
    ...context(workspaceRoot),
    turnExecutionId: 'turn-1',
    executionLaunch: {
      runId: 'run-1',
      parentExecutionId: 'turn-1',
      record: consumed.record,
      dispatchReceipt: createExecutionDispatchReceipt(owner, handle, {
        runId: 'run-1',
        parentExecutionId: 'turn-1',
        assertAuthorityCurrent,
      }),
    },
  };
}

test('ADR-040 a normal foreground Stop terminalizes pending phases as interrupted', async () => {
  const workspace = temporaryWorkspace();
  const controller = new AbortController();
  let runnerCalls = 0;
  const runner: PhaseRunner = async (_agents, phase) => {
    runnerCalls++;
    controller.abort();
    return [{ id: `${phase.id}-child`, role: 'explorer', status: 'completed', finalOutput: 'done' }];
  };
  try {
    const raw = await runWorkflow(
      { plan: PLAN, slug: 'stopped-run' },
      context(workspace, controller.signal),
      { dispatch: async () => '{}', runner },
    );
    const result = JSON.parse(raw);
    const run = readRun(workspace, 'stopped-run');

    assert.equal(result.status, 'failed', 'the low-level response keeps its established PhasePlan status');
    assert.equal(runnerCalls, 1, 'Stop prevents the second phase from dispatching');
    assert.equal(run?.status, 'interrupted');
    assert.deepEqual(run?.phases?.map((phase) => phase.status), ['completed', 'interrupted']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('ADR-040 authority revocation after ledger creation interrupts the run and rethrows', async () => {
  const workspace = temporaryWorkspace();
  const args = { plan: PLAN, slug: 'revoked-run' };
  let runnerCalls = 0;
  const runner: PhaseRunner = async () => {
    runnerCalls++;
    return [];
  };
  const reviewedContext = authorizedContext(workspace, args, () => {
    if (readRun(workspace, 'revoked-run')) {
      throw new Error('Reviewed execution authority was revoked.');
    }
  });
  try {
    await assert.rejects(
      () => runWorkflowAuthorized(args, reviewedContext, { dispatch: async () => '{}', runner }),
      /authority was revoked/,
    );
    const run = readRun(workspace, 'revoked-run');

    assert.equal(runnerCalls, 0, 'revocation is observed before child dispatch');
    assert.equal(run?.status, 'interrupted');
    assert.deepEqual(run?.phases?.map((phase) => phase.status), ['interrupted', 'interrupted']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('ADR-040 an unexpected foreground executor exception fails the durable run and rethrows', async () => {
  const workspace = temporaryWorkspace();
  const runner: PhaseRunner = async (_agents, phase) => [{
    id: `${phase.id}-child`,
    role: 'explorer',
    status: 'completed',
    get finalOutput(): string {
      throw new Error('Unexpected synthesis failure.');
    },
  }];
  try {
    await assert.rejects(
      () => runWorkflow(
        { plan: PLAN, slug: 'failed-run' },
        context(workspace),
        { dispatch: async () => '{}', runner },
      ),
      /Unexpected synthesis failure/,
    );
    const run = readRun(workspace, 'failed-run');

    assert.equal(run?.status, 'failed');
    assert.deepEqual(run?.phases?.map((phase) => phase.status), ['failed', 'failed']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
