/**
 * Tests for approval-prompt UX (0.3.9 follow-up after the goal review):
 *
 *   1. Dangerous-command run_command prompt must embed the command itself
 *      into the question handed to `askYesNo` so the Ink overlay shows
 *      it. The legacy split (separate console.log + generic
 *      "Allow execution? (y/N)") left users staring at a context-free
 *      modal.
 *
 *   2. `ask_user_choice` must bypass under /yolo (executionMode=fast
 *      AND reviewPolicy=proceed) with a NoTTY-shaped error so the model
 *      decides itself instead of stalling the turn on a UI gate the
 *      user already declined.
 *
 * Both behaviours are pure CPU and exercised through the existing
 * test runtime — no fake TTY needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyYoloOn, applyYoloOff, writePreferences } from '../state/preferencesStore.js';
import { setGoal, clearGoal } from '../state/goalStore.js';

// Helper — spin up a fresh workspace dir per test so the per-workspace
// preferences file doesn't leak across cases.
async function withTempWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-test-'));
  try {
    return await fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

// --- /yolo policy round-trip --------------------------------------------

test('applyYoloOn / applyYoloOff round-trip the two-axis state', async () => {
  await withTempWorkspace(async (workspace) => {
    const on = applyYoloOn(workspace);
    assert.equal(on.executionMode, 'fast');
    assert.equal(on.reviewPolicy, 'proceed');
    assert.equal(on.autoApproveShell, true);

    const off = applyYoloOff(workspace);
    assert.equal(off.executionMode, 'planning');
    assert.equal(off.reviewPolicy, 'request');
    assert.equal(off.autoApproveShell, false);
  });
});

// --- ask_user_choice YOLO bypass ----------------------------------------

test('ask_user_choice throws NoTTYError under /yolo (fast + proceed)', async () => {
  await withTempWorkspace(async (workspace) => {
    applyYoloOn(workspace);
    const { Agent } = await import('../agent/agent.js');
    const { NoTTYError } = await import('../cli/cliPrompt.js');
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
    const agent = new Agent(
      stubMcp,
      { provider: 'openai', apiKey: 'k', model: 'test' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 's:test' },
    );
    // executeLocalTool is private but reachable via the runtime — we
    // exercise it directly to keep the test focused on the bypass
    // policy without spinning up the full LLM loop.
    await assert.rejects(
      () => (agent as any).executeLocalTool('ask_user_choice', {
        question: 'Pick one',
        header: 'Choice',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof NoTTYError, 'expected NoTTYError, got ' + (err as Error)?.name);
        const msg = (err as Error).message;
        assert.match(msg, /suppressed by \/yolo/);
        assert.match(msg, /pick the option you would pick/i);
        return true;
      },
    );
  });
});

test('ask_user_choice does NOT bypass under fast-mode-only (no /yolo)', async () => {
  await withTempWorkspace(async (workspace) => {
    // Fast mode alone is `/mode fast` — keeps reviewPolicy=request, so /yolo
    // is OFF and the bypass must NOT fire. The picker will then fail
    // separately because there's no active readline in test mode; we just
    // assert the failure reason isn't the YOLO bypass.
    writePreferences(workspace, { executionMode: 'fast', reviewPolicy: 'request' });
    const { Agent } = await import('../agent/agent.js');
    const { NoTTYError } = await import('../cli/cliPrompt.js');
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
    const agent = new Agent(
      stubMcp,
      { provider: 'openai', apiKey: 'k', model: 'test' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 's:test' },
    );
    await assert.rejects(
      () => (agent as any).executeLocalTool('ask_user_choice', {
        question: 'Pick one',
        header: 'Choice',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      }),
      (err: unknown) => {
        // It still fails (no TTY in tests) but the message must be the
        // TTY-missing message, not the YOLO bypass message.
        assert.ok(err instanceof NoTTYError, 'expected NoTTYError');
        const msg = (err as Error).message;
        assert.doesNotMatch(msg, /suppressed by \/yolo/);
        return true;
      },
    );
  });
});

test('ask_user_choice bypasses under an active /goal even with /yolo off', async () => {
  await withTempWorkspace(async (workspace) => {
    // Conservative defaults — /yolo is off — but a goal is active.
    // The picker MUST still bypass because the auto-continuation loop
    // would otherwise stall on the modal.
    applyYoloOff(workspace);
    const { Agent } = await import('../agent/agent.js');
    const { NoTTYError } = await import('../cli/cliPrompt.js');
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
    const agent = new Agent(
      stubMcp,
      { provider: 'openai', apiKey: 'k', model: 'test' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 's:goal-test' },
    );
    setGoal(workspace, 'Land 0.3.9 and walk away — verified by 584 green tests.', 's:goal-test');
    try {
      await assert.rejects(
        () => (agent as any).executeLocalTool('ask_user_choice', {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
        }),
        (err: unknown) => {
          assert.ok(err instanceof NoTTYError, 'expected NoTTYError');
          const msg = (err as Error).message;
          assert.match(msg, /suppressed by the active \/goal/i);
          assert.match(msg, /Land 0\.3\.9 and walk away/);
          return true;
        },
      );
    } finally {
      clearGoal(workspace, 's:goal-test');
    }
  });
});

test('ask_user_choice combines bypass reasons when both /yolo and /goal are active', async () => {
  await withTempWorkspace(async (workspace) => {
    applyYoloOn(workspace);
    setGoal(workspace, 'Both axes engaged.', 's:both');
    const { Agent } = await import('../agent/agent.js');
    const { NoTTYError } = await import('../cli/cliPrompt.js');
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
    const agent = new Agent(
      stubMcp,
      { provider: 'openai', apiKey: 'k', model: 'test' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 's:both' },
    );
    try {
      await assert.rejects(
        () => (agent as any).executeLocalTool('ask_user_choice', {
          question: 'Pick',
          header: 'Choice',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
        }),
        (err: unknown) => {
          assert.ok(err instanceof NoTTYError);
          // /yolo wins the message because the user opted in explicitly;
          // the trace event records both axes via reason='yolo+goal'.
          const msg = (err as Error).message;
          assert.match(msg, /suppressed by \/yolo/);
          return true;
        },
      );
    } finally {
      clearGoal(workspace, 's:both');
    }
  });
});

test('ask_user_choice does NOT bypass under proceed-only (no /yolo)', async () => {
  await withTempWorkspace(async (workspace) => {
    // Mirror of the previous test on the other axis.
    writePreferences(workspace, { executionMode: 'planning', reviewPolicy: 'proceed' });
    const { Agent } = await import('../agent/agent.js');
    const { NoTTYError } = await import('../cli/cliPrompt.js');
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} };
    const agent = new Agent(
      stubMcp,
      { provider: 'openai', apiKey: 'k', model: 'test' },
      { workspaceRoot: workspace, launchCwd: workspace, sessionKey: 's:test' },
    );
    await assert.rejects(
      () => (agent as any).executeLocalTool('ask_user_choice', {
        question: 'Pick one',
        header: 'Choice',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof NoTTYError, 'expected NoTTYError');
        const msg = (err as Error).message;
        assert.doesNotMatch(msg, /suppressed by \/yolo/);
        return true;
      },
    );
  });
});

// --- buildRunCommandPrompt: the helper that feeds askYesNo --------------

import { buildRunCommandPrompt } from '../runtime/dangerousCommand.js';

test('buildRunCommandPrompt embeds the command for the dangerous branch', () => {
  const prompt = buildRunCommandPrompt('rm -rf /tmp/foo');
  assert.match(prompt, /rm -rf \/tmp\/foo/);
  assert.match(prompt, /potentially-destructive/i);
  assert.match(prompt, /\(y\/N\)\s*$/);
});

test('buildRunCommandPrompt keeps the non-destructive variant clean', () => {
  const prompt = buildRunCommandPrompt('ls -la');
  assert.match(prompt, /ls -la/);
  assert.doesNotMatch(prompt, /potentially-destructive/i);
  assert.match(prompt, /Allow this command\?/);
});

test('resolveRunCommandApproval: active /goal auto-approves safe commands even in planning mode', async () => {
  const { resolveRunCommandApproval } = await import('../runtime/dangerousCommand.js');
  // Planning + goal active + safe → auto-approve (don't stall the goal loop).
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: false, goalActive: true }),
    'auto-approve',
  );
  // Planning + goal active + dangerous → still ask (safety floor).
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'rm -rf /tmp/x', { silent: false, goalActive: true }),
    'ask',
  );
  // Planning + NO goal + safe → ask (current behavior, unchanged).
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: false, goalActive: false }),
    'ask',
  );
  // Planning + NO goal + safe + no opts.goalActive → ask (back-compat).
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: false }),
    'ask',
  );
});

test('resolveRunCommandApproval: silent child + active /goal + safe → auto-approve', async () => {
  const { resolveRunCommandApproval } = await import('../runtime/dangerousCommand.js');
  // Silent children inherit the parent's "I trust automation" signal from
  // either /mode fast OR an active /goal.
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'ls -la', { silent: true, goalActive: true }),
    'auto-approve',
  );
  // Dangerous still denied — silent children can't confirm blast radius.
  assert.equal(
    resolveRunCommandApproval({ executionMode: 'planning' }, 'rm -rf /', { silent: true, goalActive: true }),
    'deny-silent',
  );
});

test('buildRunCommandPrompt always ends with the y/N pad so the Ink overlay can render it as the modal title', () => {
  const a = buildRunCommandPrompt('ls');
  const b = buildRunCommandPrompt('rm -rf /tmp/x');
  for (const prompt of [a, b]) {
    assert.match(prompt, /\(y\/N\)\s*$/);
    assert.ok(prompt.includes('\n'), 'multi-line so the modal can break across rows');
  }
});
