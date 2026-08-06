/**
 * P23-22 root-turn orchestration resolution tests.
 *
 * These exercise the same saved manifest and bundled catalog path used by live
 * Agent turns; no child launch or model call is involved in this first slice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';
import { buildWorkingTreeReviewPrompt } from '../review/workingTreeReview.js';
import { resolveActiveTurnOrchestration } from '../workspace/activeTurnOrchestration.js';
import {
  createWorkspaceManifest,
  saveWorkspaceManifest,
  type WorkspaceManifest,
} from '../workspace/manifest.js';
import type { WorkspaceProfileId } from '../workspace/profiles.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('registered task signals are bounded and ambiguous chat remains primary-only', () => {
  assert.deepEqual(
    [...detectOrchestrationTaskSignals('Investigate the root cause and fix this bug.')],
    ['bug-fix', 'investigation'],
  );
  assert.deepEqual([...detectOrchestrationTaskSignals('Hello, how are you?')], []);
});

test('P23-21 workspace initialization is not misclassified as evidence collection', () => {
  assert.deepEqual(
    [...detectOrchestrationTaskSignals(
      "We're in an empty folder right now, building our day-to-day Economics Research. Help me setting this up.",
    )],
    [],
  );
  assert.deepEqual(
    [...detectOrchestrationTaskSignals('Research the inflation outlook and find authoritative sources.')],
    ['evidence-collection'],
  );
});

test('missing workspace manifests preserve the legacy direct-primary path', () => {
  withTempWorkspace((workspace) => {
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Research this question.',
    });
    assert.equal(resolved.plan.orchestrationProfileId, null);
    assert.equal(resolved.plan.strategyId, null);
    assert.deepEqual(resolved.plan.diagnostics, [
      { code: 'no-plan' },
      { code: 'fallback-selected' },
    ]);
  });
});

test('nested agents cannot create a second workspace orchestration owner', () => {
  withTempWorkspace((workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'research',
      profile: 'research',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, adaptive(manifest));
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Collect evidence and find sources.',
      parentDepth: 1,
    });
    assert.equal(resolved.source, 'nested-agent');
    assert.equal(resolved.plan.orchestrationProfileId, null);
    assert.equal(resolved.plan.strategyId, null);
  });
});

test('saved profile manifests resolve distinct live strategies without launching children', () => {
  const cases: Array<{
    profile: WorkspaceProfileId;
    task: string;
    strategy: string;
  }> = [
    { profile: 'engineering', task: 'Investigate the root cause.', strategy: 'investigate' },
    { profile: 'research', task: 'Collect evidence and find sources.', strategy: 'parallel-evidence' },
    { profile: 'data-science', task: 'Run a dataset audit for data quality.', strategy: 'dataset-audit' },
    { profile: 'study', task: 'Explain this source and teach me the concept.', strategy: 'source-explanation' },
    { profile: 'writing', task: 'Critique and review this draft.', strategy: 'critique-revision' },
  ];
  for (const fixture of cases) {
    withTempWorkspace((workspace) => {
      const manifest = createWorkspaceManifest({
        name: fixture.profile,
        profile: fixture.profile,
        by: 'wizard',
      });
      saveWorkspaceManifest(workspace, adaptive(manifest));
      const resolved = resolveActiveTurnOrchestration({
        workspaceRoot: workspace,
        task: fixture.task,
      });
      assert.equal(
        resolved.plan.strategyId,
        fixture.strategy,
        `${fixture.profile} should resolve its own strategy`,
      );
      assert.equal(resolved.plan.selectionSource, 'deterministic');
      assert.equal(resolved.plan.activation, 'preview', 'this slice cannot execute stages');
    });
  }
});

test('Custom remains primary-only when no orchestration strategy is configured', () => {
  withTempWorkspace((workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'custom',
      profile: 'custom',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, adaptive(manifest));
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Investigate and implement this feature.',
    });
    assert.equal(resolved.plan.orchestrationProfileId, 'custom');
    assert.equal(resolved.plan.strategyId, 'direct');
    assert.equal(resolved.plan.selectionSource, 'fallback');
    assert.deepEqual(resolved.plan.stages.map((stage) => stage.executor.kind), ['primary']);
  });
});

test('Agent.runTurn publishes the saved profile resolution on the live turn state', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'research',
      profile: 'research',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, adaptive(manifest));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const agent = makeAgent(workspace);
      await agent.runTurn('Collect evidence and find sources.', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(agent.activeTurnOrchestration?.plan.orchestrationProfileId, 'research');
      assert.equal(agent.activeTurnOrchestration?.plan.strategyId, 'parallel-evidence');
      assert.equal(agent.activeTurnOrchestration?.plan.activation, 'preview');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a review workflow the caller already assembled is not re-planned as a delivery run', () => {
  withTempWorkspace((workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'engineering',
      profile: 'engineering',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, adaptive(manifest));
    const task = buildWorkingTreeReviewPrompt({
      diff: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ -3,6 +3,7 @@\n+  if (!token) return null;\n',
    });
    assert.equal(
      resolveActiveTurnOrchestration({ workspaceRoot: workspace, task }).plan.strategyId,
      'delivery',
      'precondition: routed by its own text, a review prompt becomes an implement-and-verify plan',
    );

    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task,
      preplanned: true,
    });
    assert.equal(resolved.source, 'preplanned');
    assert.equal(resolved.plan.strategyId, null);
    assert.deepEqual(resolved.taskSignalIds, []);
  });
});

test('Agent.runTurn keeps a pre-planned review turn unplanned, so the reviewer is never told to implement', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'engineering',
      profile: 'engineering',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, adaptive(manifest));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '[]' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const callbacks = {
      onStatusUpdate: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    };
    try {
      // The desktop Review panel: an isolated reviewer handed the assembled
      // working-tree prompt.
      const desktop = makeAgent(workspace);
      await desktop.runTurn(
        buildWorkingTreeReviewPrompt({ diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\n' }),
        callbacks,
        { preplanned: true },
      );
      assert.equal(desktop.activeTurnOrchestration?.source, 'preplanned');
      assert.equal(desktop.activeTurnOrchestration?.plan.strategyId, null);

      // The CLI `/review`: the slash command latches its skill before the turn,
      // which is the same statement — the workflow is already chosen.
      const cli = makeAgent(workspace);
      cli.activeSkill = 'code-review-and-quality';
      await cli.runTurn('Review the changes and fix the broken auth guard.', callbacks);
      assert.equal(cli.activeTurnOrchestration?.source, 'preplanned');
      assert.equal(cli.activeTurnOrchestration?.plan.strategyId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function adaptive(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    ...manifest,
    orchestration: {
      ...manifest.orchestration,
      mode: 'adaptive',
    },
  };
}
