/**
 * P23-22 root-turn orchestration resolution tests.
 *
 * These exercise the same saved manifest and bundled catalog path used by live
 * Agent turns; no child launch or model call is involved in this first slice.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry } from '../orchestration/agents/agentRegistry.js';
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';
import { ProfileStageController } from '../orchestration/runtime/profileStageController.js';
import { buildWorkingTreeReviewPrompt } from '../review/workingTreeReview.js';
import {
  inferWorkspaceOrchestrationDefault,
  resetInferredWorkspaceOrchestrationDefaults,
  resolveActiveTurnOrchestration,
} from '../workspace/activeTurnOrchestration.js';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  type WorkspaceManifest,
} from '../workspace/manifest.js';
import type { WorkspaceProfileId } from '../workspace/profiles.js';
import { resolveWorkspaceToolSelection } from '../workspace/toolProfiles.js';
import { makeAgent, withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

/** A repository that has never been through `/init`: code markers, no `.brainrouter/`. */
function stockRepository(workspace: string): string {
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"stock"}\n');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const a = 1;\n');
  resetInferredWorkspaceOrchestrationDefaults();
  return workspace;
}

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

test('an unrecognizable workspace gets no inferred plan, because nothing about it was established', () => {
  withTempWorkspace((workspace) => {
    resetInferredWorkspaceOrchestrationDefaults();
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Research this question.',
    });
    assert.equal(resolved.source, 'none');
    assert.equal(resolved.plan.orchestrationProfileId, null);
    assert.equal(resolved.plan.strategyId, null);
    assert.deepEqual(resolved.plan.diagnostics, [
      { code: 'no-plan' },
      { code: 'fallback-selected' },
    ]);
    assert.equal(
      inferWorkspaceOrchestrationDefault(workspace),
      null,
      'the custom plan is mode-off with no roles, so inferring it is worse than inferring nothing',
    );
  });
});

test('a stock repository routes to the default profile, because onboarding is not a precondition for delegation', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Implement the retry backoff and fix the bug in the uploader.',
    });
    assert.equal(loadWorkspaceManifest(workspace), null, 'precondition: never onboarded');
    assert.equal(resolved.plan.orchestrationProfileId, 'engineering');
    assert.equal(resolved.plan.strategyId, 'delivery');
    assert.equal(resolved.plan.selectionSource, 'deterministic');
    assert.deepEqual(resolved.taskSignalIds, ['bug-fix', 'implementation']);
    assert.deepEqual(
      resolved.plan.stages.map((stage) => stage.id),
      ['inspect', 'implement', 'review', 'verify', 'challenge', 'deliver'],
    );
    assert.deepEqual(resolved.plan.skippedStages, [], 'every stage survives on a stock repo');
    assert.equal(resolved.plan.effectiveParallel, 4);
  });
});

test('an inferred plan is labelled distinctly, so the trace never claims a reviewed workspace choice', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    assert.equal(
      resolveActiveTurnOrchestration({
        workspaceRoot: workspace,
        task: 'Investigate the root cause.',
      }).source,
      'inferred-default',
    );
  });
});

test('a saved manifest wins over what the repository looks like, so a default cannot override a reviewed choice', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const inferred = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Collect evidence and find sources.',
    });
    assert.equal(inferred.plan.orchestrationProfileId, 'engineering');

    // The same directory the suggester reads as engineering, explicitly onboarded
    // as research: the manifest must decide, not the filesystem.
    saveWorkspaceManifest(workspace, adaptive(createWorkspaceManifest({
      name: 'research',
      profile: 'research',
      by: 'wizard',
    })));
    const onboarded = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Collect evidence and find sources.',
    });
    assert.equal(onboarded.plan.orchestrationProfileId, 'research');
    assert.equal(onboarded.plan.strategyId, 'parallel-evidence');
    assert.notEqual(onboarded.source, 'inferred-default');
  });
});

test('an onboarded workspace resolves the identical plan it did before inference existed', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    saveWorkspaceManifest(workspace, adaptive(createWorkspaceManifest({
      name: 'engineering',
      profile: 'engineering',
      by: 'wizard',
    })));
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Implement the retry backoff and fix the bug in the uploader.',
    });
    assert.equal(resolved.source, 'bundled');
    assert.deepEqual(
      {
        profile: resolved.plan.orchestrationProfileId,
        strategy: resolved.plan.strategyId,
        selectionSource: resolved.plan.selectionSource,
        stages: resolved.plan.stages.map((stage) => [stage.id, stage.skillIds.join('|')]),
        parallel: resolved.plan.effectiveParallel,
        diagnostics: resolved.plan.diagnostics,
      },
      {
        profile: 'engineering',
        strategy: 'delivery',
        selectionSource: 'deterministic',
        stages: [
          ['inspect', 'planning-skill'],
          ['implement', 'incremental-skill|testing-skill'],
          ['review', 'code-review-and-quality'],
          ['verify', 'verify-loop'],
          ['challenge', 'code-review-and-quality'],
          ['deliver', 'shipping-skill'],
        ],
        parallel: 4,
        diagnostics: [],
      },
    );
  });
});

test('a manifest that turned orchestration off is never helpfully re-inferred', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const manifest = createWorkspaceManifest({
      name: 'engineering',
      profile: 'engineering',
      by: 'wizard',
    });
    saveWorkspaceManifest(workspace, {
      ...manifest,
      orchestration: { ...manifest.orchestration, mode: 'off' },
    });
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Implement the retry backoff and fix the bug in the uploader.',
    });
    assert.equal(resolved.plan.strategyId, 'direct');
    assert.equal(resolved.plan.selectionSource, 'fallback');
    assert.ok(resolved.plan.diagnostics.some((entry) => entry.code === 'mode-off'));
  });
});

test('inference never outranks the two turn-ownership escapes on a stock repository', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const task = 'Implement the retry backoff and fix the bug in the uploader.';
    const preplanned = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task,
      preplanned: true,
    });
    assert.equal(preplanned.source, 'preplanned');
    assert.equal(preplanned.plan.strategyId, null);

    const nested = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task,
      parentDepth: 1,
    });
    assert.equal(nested.source, 'nested-agent');
    assert.equal(nested.plan.strategyId, null);
  });
});

test('the repository scan behind an inferred default runs once, not once per turn', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const first = inferWorkspaceOrchestrationDefault(workspace);
    assert.ok(first);
    assert.equal(first.profile, 'engineering');
    for (let turn = 0; turn < 5; turn += 1) {
      assert.equal(
        inferWorkspaceOrchestrationDefault(workspace),
        first,
        'a recomputed suggestion would allocate a new object and put a filesystem scan on the hot path',
      );
    }
  });
});

test('an unsignalled turn on an inferred plan cannot be terminated by the profile-stage guard', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    const resolved = resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Hello, how are you?',
    });
    assert.equal(resolved.plan.strategyId, 'direct');
    assert.deepEqual(resolved.taskSignalIds, []);
    const controller = new ProfileStageController(
      { turnId: 'turn-1', sessionKey: 'session-1' },
      resolved.plan,
      {
        loadSkill: async () => { throw new Error('an unsignalled plan must not activate a skill'); },
        setActiveSkill: () => {},
      },
    );
    assert.equal(controller.nextRequiredAction(), undefined);
    assert.equal(controller.nextRequiredDelegation(), undefined);
    assert.equal(controller.failedRequiredStage(), undefined);
  });
});

test('an inferred default stays inside turn routing and grants no workspace management', () => {
  withTempWorkspace((workspace) => {
    stockRepository(workspace);
    resolveActiveTurnOrchestration({
      workspaceRoot: workspace,
      task: 'Implement the retry backoff and fix the bug in the uploader.',
    });
    assert.equal(loadWorkspaceManifest(workspace), null, 'nothing was written to disk');
    assert.equal(
      resolveWorkspaceToolSelection({ manifest: loadWorkspaceManifest(workspace) }).managed,
      false,
      'an inferred profile must not switch on manifest tool allowlisting',
    );
    const roles = loadRegistry(workspace).map((loaded) => loaded.def.id).sort();
    assert.deepEqual(
      roles,
      ['architect', 'explorer', 'fleet', 'intake', 'reviewer', 'verifier', 'worker'],
      'role availability must not narrow to the inferred profile',
    );
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
