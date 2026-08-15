/**
 * Turn-finalization observability contract tests.
 *
 * Dual profile identity must remain visible at the terminal span while the
 * compatibility field continues to mean reusable plan identity.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationTurnSpanAttributes } from '../agent/runtime/turnFinalizationPhase.js';
import type { ActiveTurnOrchestrationResolution } from '../workspace/activeTurnOrchestration.js';

test('A40-1 turn telemetry separates workspace and plan profile identity', () => {
  const resolution = {
    plan: {
      workspaceProfileId: 'legal',
      planProfileId: 'research',
      orchestrationProfileId: 'research',
      strategyId: 'citation-review',
      selectionSource: 'deterministic',
      stages: [{ id: 'audit' }, { id: 'synthesize' }],
    },
    taskSignalIds: ['citation-review', 'evidence-collection'],
    source: 'bundled',
  } as unknown as ActiveTurnOrchestrationResolution;

  assert.deepEqual(orchestrationTurnSpanAttributes(resolution), {
    orchestration_workspace_profile_id: 'legal',
    orchestration_plan_profile_id: 'research',
    orchestration_profile_id: 'research',
    orchestration_strategy_id: 'citation-review',
    orchestration_selection_source: 'deterministic',
    orchestration_stage_count: 2,
    orchestration_signal_ids: 'citation-review,evidence-collection',
    orchestration_source: 'bundled',
  });
});
