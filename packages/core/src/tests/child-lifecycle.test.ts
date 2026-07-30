/**
 * Child cancellation lifecycle tests.
 *
 * Parent interruption must stay scoped to owned children, and an interrupted
 * child must persist and publish one truthful terminal receipt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../agent/agent.js';
import { requestInterrupt } from '../agent/runtime/session.impl.js';
import {
  __resetCompletionInbox,
  peekCompletions,
} from '../session/completion/completionInbox.js';
import {
  createSession,
  getSession,
  updateSession,
} from '../orchestration/session/orchestrator.js';
import {
  registerInterruptibleAgent,
  unregisterInterruptibleAgent,
} from '../orchestration/tools/registry.js';
import {
  CHILD_INTERRUPTED_SUMMARY,
  finalizeInterruptedChild,
} from '../orchestration/tools/childLifecycle.js';
import type { OrchestrationContext } from '../orchestration/tools/context.js';

test('parent interruption cascades only to children owned by that session', () => {
  let ownedInterrupts = 0;
  let siblingInterrupts = 0;
  const owned = {
    requestInterrupt: () => { ownedInterrupts += 1; },
  } as unknown as Agent;
  const sibling = {
    requestInterrupt: () => { siblingInterrupts += 1; },
  } as unknown as Agent;
  registerInterruptibleAgent('owned-child', owned, 'parent-session');
  registerInterruptibleAgent('sibling-child', sibling, 'other-session');

  try {
    const turnAbort = new AbortController();
    const parent = {
      sessionKey: 'parent-session',
      interruptRequested: false,
      turnAbort,
    } as unknown as Agent;

    requestInterrupt.call(parent);

    assert.equal(turnAbort.signal.aborted, true);
    assert.equal(ownedInterrupts, 1);
    assert.equal(siblingInterrupts, 0);
  } finally {
    unregisterInterruptibleAgent('owned-child');
    unregisterInterruptibleAgent('sibling-child');
  }
});

test('interrupted child persists and publishes exactly one terminal receipt', () => {
  __resetCompletionInbox();
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'brainrouter-child-lifecycle-'),
  );
  const record = createSession(workspaceRoot, {
    role: 'worker',
    prompt: 'Inspect the requested boundary.',
    parentSessionKey: 'parent-session',
  });
  updateSession(workspaceRoot, record.id, { status: 'running' });
  const receipts: unknown[] = [];
  let rejections = 0;
  const ctx = {
    workspaceRoot,
    parentSessionKey: 'parent-session',
    onChildComplete: (receipt: unknown) => receipts.push(receipt),
  } as unknown as OrchestrationContext;
  const completedAt = '2026-07-30T00:00:00.000Z';

  try {
    const first = finalizeInterruptedChild({
      ctx,
      record,
      role: 'worker',
      reportCompletionToParent: true,
      rejectPreparedDelegation: () => { rejections += 1; },
      completedAt,
    });
    const second = finalizeInterruptedChild({
      ctx,
      record,
      role: 'worker',
      reportCompletionToParent: true,
      rejectPreparedDelegation: () => { rejections += 1; },
      completedAt,
    });

    assert.equal(first.status, 'interrupted');
    assert.equal(second.status, 'interrupted');
    assert.equal(getSession(workspaceRoot, record.id)?.status, 'interrupted');
    assert.deepEqual(receipts, [{
      childId: record.id,
      role: 'worker',
      status: 'interrupted',
      completedAt,
      summary: CHILD_INTERRUPTED_SUMMARY,
    }]);
    assert.deepEqual(peekCompletions('parent-session'), [{
      kind: 'agent',
      id: record.id,
      status: 'interrupted',
      label: 'worker',
      summary: CHILD_INTERRUPTED_SUMMARY,
      completedAt,
    }]);
    assert.equal(rejections, 1);
  } finally {
    __resetCompletionInbox();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
