/**
 * Final turn phase shared by every Agent execution path.
 *
 * Normalizes the answer, records completion telemetry and hooks, and schedules
 * optional learning/title work. Opportunistic title naming is contained so a
 * filesystem or model failure cannot reject an already completed turn.
 */

import type { Agent, RunTurnCallbacks } from '../agent.js';
import type { ActiveTurnOrchestrationResolution } from '../../workspace/activeTurnOrchestration.js';
import { collectStopAdditionalContext } from '../../hooks/hooksStore.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { readGoal } from '../../goal/store/goalStore.js';
import { shrinkOversizedToolResults } from '../guards/turnEndShrink.js';
import { normalizeTurnCompletionAnswer } from './completionPhase.js';
import { phaseHookHandlers, type PhaseHookContext } from '../../extension/registry.js';
import { buildTurnUsageView } from '../../util/tokens/turnUsageView.js';
import { scheduleLearningCheckpoint } from './learningPhase.js';
import { getCliKnobs } from '../../config/config.js';
import { readAtlasGraphCached } from '../../atlas/store/atlasStore.js';
import { buildAtlasChangeContext } from '../../atlas/changeContext.js';
import path from 'node:path';

interface TurnSpan {
  end(extra?: Record<string, unknown>): void;
}

export interface FinalizeTurnInput {
  prompt: string;
  answer: string;
  exitedCleanly: boolean;
  maxLoops: number;
  loopCount: number;
  callbacks: RunTurnCallbacks;
  activeTurnOrchestration: ActiveTurnOrchestrationResolution;
  turnSpan: TurnSpan;
  /** Exact reviewed turns keep their consumed lease through finalization. */
  reviewedExecution?: boolean;
  /** Throws when the root launch lease or inherited execution lease was revoked. */
  assertReviewedExecutionCurrent?(): void;
}

export type TurnTerminationReason =
  | 'session-changed'
  | 'turn-interrupted'
  | 'turn-ended';

export async function finalizeTurnPhase(
  agent: Agent,
  input: FinalizeTurnInput,
): Promise<string> {
  const assertAuthorityCurrent = (): void => {
    if (input.assertReviewedExecutionCurrent) {
      input.assertReviewedExecutionCurrent();
      return;
    }
    agent.assertInheritedExecutionAuthorityCurrent();
  };

  assertAuthorityCurrent();
  const normalizedCompletion = normalizeTurnCompletionAnswer({
    answer: input.answer,
    exitedCleanly: input.exitedCleanly,
    maxLoops: input.maxLoops,
    goalTransition: agent.lastGoalTransition,
    toolCallCount: agent.lastTurnToolCalls,
    workspaceRoot: agent.workspaceRoot,
    sessionKey: agent.sessionKey,
  });
  const finalAnswer = normalizedCompletion.answer;
  agent.lastTurnHitLoopLimit = normalizedCompletion.hitLoopLimit;
  agent.lastAnswer = finalAnswer;

  assertAuthorityCurrent();
  if (!input.reviewedExecution) {
    await agent.captureTurn(input.prompt, finalAnswer, input.callbacks);
    assertAuthorityCurrent();
    // Naming is opportunistic and bounded. It must not delay the completed turn;
    // compare-and-set prevents a concurrent human/hook rename from being lost.
    scheduleFirstTurnSessionTitleProposal(
      agent,
      input.prompt,
      finalAnswer.slice(0, 2_000),
      input.callbacks,
    );
    // ADR-032 D5 — the turn-end checkpoint. Dispatched, never awaited: §1's worst
    // gap is that an agent learns only when it remembers to ask, and the fix for
    // that must not become a thing a person waits on. It sits after captureTurn
    // so the trajectory it reads is the finished one.
    scheduleLearningCheckpoint(agent, 'turn-end');
  }
  if (agent.hookAdvisoryActive()) {
    assertAuthorityCurrent();
    agent.runExecutionHooks('post-turn', {
      payload: {
        prompt: input.prompt,
        answerPreview: finalAnswer.slice(0, 1000),
        tokens: agent.lastTurnUsage,
      },
    });
    assertAuthorityCurrent();
  }

  if (agent.hookNotifyActive()) {
    assertAuthorityCurrent();
    try {
      const stopEvent = agent.silent ? 'subagent-stop' : 'stop';
      const stopResults = agent.runExecutionHooks(stopEvent, {
        payload: {
          prompt: input.prompt,
          answerPreview: finalAnswer.slice(0, 1000),
          tokens: agent.lastTurnUsage,
        },
      });
      const extra = collectStopAdditionalContext(stopResults);
      if (extra) {
        agent.pendingStopContext = agent.pendingStopContext
          ? `${agent.pendingStopContext}\n${extra}`
          : extra;
      }
    } catch {
      // Stop hooks are advisory and cannot invalidate a completed turn.
    }
    assertAuthorityCurrent();

    assertAuthorityCurrent();
    try {
      agent.runExecutionHooks('notification-agent-completed', {
        payload: {
          sessionKey: agent.sessionKey,
          silent: agent.silent,
          answerPreview: finalAnswer.slice(0, 200),
        },
      });
    } catch {
      // Completion notifications are advisory.
    }
    assertAuthorityCurrent();
  }

  assertAuthorityCurrent();
  input.turnSpan.end({
    outcome: input.exitedCleanly ? 'ok' : 'loop_limit',
    loops_used: input.loopCount,
    tokens_in: agent.lastTurnUsage.promptTokens,
    tokens_out: agent.lastTurnUsage.completionTokens,
    ...orchestrationTurnSpanAttributes(input.activeTurnOrchestration),
  });

  agent.sessionUsage.promptTokens += agent.lastTurnUsage.promptTokens;
  agent.sessionUsage.completionTokens += agent.lastTurnUsage.completionTokens;
  agent.sessionUsage.calls += agent.lastTurnUsage.calls;
  agent.sessionUsage.turns += 1;
  agent.sessionUsage.cachedTokens += agent.lastTurnUsage.cachedTokens;
  agent.sessionUsage.missedTokens += agent.lastTurnUsage.missedTokens;

  const skillKey = agent.activeSkill ?? 'chat';
  const skillUsage = agent.usageBySkill.get(skillKey) ?? {
    promptTokens: 0,
    completionTokens: 0,
    turns: 0,
    calls: 0,
  };
  skillUsage.promptTokens += agent.lastTurnUsage.promptTokens;
  skillUsage.completionTokens += agent.lastTurnUsage.completionTokens;
  skillUsage.calls += agent.lastTurnUsage.calls;
  skillUsage.turns += 1;
  agent.usageBySkill.set(skillKey, skillUsage);

  if (agent.activeLearnedSkillItemId) {
    agent.activeLearnedSkillItemId = undefined;
    agent.activeSkill = undefined;
    agent.activeSkills = [];
    agent.activeSkillAllowedTools = undefined;
    agent.activeSkillDisallowedTools = [];
  }

  if (!agent.silent && isTelemetryEnabled()) {
    try {
      recordDailyUsage(
        {
          promptTokens: agent.lastTurnUsage.promptTokens,
          completionTokens: agent.lastTurnUsage.completionTokens,
          calls: agent.lastTurnUsage.calls,
          cachedTokens: agent.lastTurnUsage.cachedTokens,
          missedTokens: agent.lastTurnUsage.missedTokens,
        },
        Date.now(),
        // ADR-052 D2 — attribute the turn so a runaway automation is identifiable:
        // a turn driven by an active goal loop vs. an ordinary interactive turn.
        readGoal(agent.workspaceRoot, agent.sessionKey)?.status === 'active' ? 'goal' : 'interactive',
      );
    } catch {
      // Usage history is observability only.
    }
  }

  const shrinkResult = shrinkOversizedToolResults(agent.chatHistory, {
    resultCache: agent.resultCache,
  });
  if (shrinkResult.shrunkCount > 0) {
    agent.memoryMetrics.compactedToolCharsAvoided += shrinkResult.charsSaved;
    traceEvent('turn_end.shrink', {
      shrunkCount: shrinkResult.shrunkCount,
      charsSaved: shrinkResult.charsSaved,
      tokensSaved: shrinkResult.tokensSaved,
    });
  }

  // ADR-041 D4b — fire turn-end phase hooks (afterPhase('turn-end')). Serial
  // notification, not a waterfall: advisory, so a throwing hook never fails the
  // turn. The logged invariant holds — a hook adds model-visible context only via
  // agent.recordTranscript, never by mutating an in-flight message array.
  // ADR-048 S5 — the blast radius of this turn's edits. Files the write tools
  // touched are mapped onto the Atlas graph and their dependents-by-layer
  // summary rides the stop-context channel into the NEXT turn (never the
  // in-flight array — ADR-041 D4). Deterministic and bounded (D2): no graph, no
  // edits, or taps knobbed off ⇒ nothing; the set clears regardless so a skipped
  // turn never leaks stale paths into the next.
  {
    const written = [...agent.turnWrittenFiles];
    agent.turnWrittenFiles.clear();
    if (written.length > 0 && !agent.silent && !agent.reviewSourceSafety) {
      try {
        const atlasKnobs = getCliKnobs().atlas;
        const graph = (atlasKnobs.orient || atlasKnobs.retrieval)
          ? readAtlasGraphCached(agent.workspaceRoot)
          : null;
        if (graph) {
          const relative = written.map((p) =>
            path.isAbsolute(p) ? path.relative(agent.workspaceRoot, p) : p,
          );
          const block = buildAtlasChangeContext(graph, relative);
          if (block) {
            const bounded = block.slice(0, 1_000).trim();
            agent.pendingStopContext = agent.pendingStopContext
              ? `${agent.pendingStopContext}\n${bounded}`
              : bounded;
          }
        }
      } catch { /* the map enriches a turn; it must never break one */ }
    }
  }

  const turnEndHooks = phaseHookHandlers('turn-end');
  if (turnEndHooks.length > 0) {
    // ADR-041 A41-13 — enrich the turn-end context with a read-only usage view and
    // a bounded next-turn write channel. Built ONCE, and only when a hook is
    // registered, so a run with no turn-end observer is byte-for-byte unchanged.
    const ctx: PhaseHookContext = {
      phase: 'turn-end',
      workspaceRoot: agent.workspaceRoot,
      sessionKey: agent.sessionKey,
      usage: buildTurnUsageView(agent),
      injectNextTurnContext: (text: string) => {
        const bounded = String(text ?? '').slice(0, 2_000).trim();
        if (!bounded) return;
        // Same channel stop-hooks use — drained into the next prompt, never the
        // in-flight message array (the D4 logged-context invariant).
        agent.pendingStopContext = agent.pendingStopContext
          ? `${agent.pendingStopContext}\n${bounded}`
          : bounded;
      },
    };
    for (const phaseHook of turnEndHooks) {
      try {
        await phaseHook.after?.(ctx, () => {});
      } catch {
        /* turn-end phase hooks are advisory */
      }
    }
  }

  return finalAnswer;
}

/** A40-1: project terminal span identity without collapsing workspace and plan profiles. */
export function orchestrationTurnSpanAttributes(
  resolution: ActiveTurnOrchestrationResolution,
): Record<string, unknown> {
  return {
    orchestration_workspace_profile_id: resolution.plan.workspaceProfileId,
    orchestration_plan_profile_id: resolution.plan.planProfileId,
    // A40-1 compatibility telemetry for one release; this remains plan identity.
    orchestration_profile_id: resolution.plan.planProfileId,
    orchestration_strategy_id: resolution.plan.strategyId,
    orchestration_selection_source: resolution.plan.selectionSource,
    // ADR-040 A40-8 — the corpus gate state and adaptive-eligibility, surfaced.
    orchestration_defaults_gated: resolution.adaptive.defaultsGated,
    orchestration_adaptive_source: resolution.adaptive.source,
    orchestration_stage_count: resolution.plan.stages.length,
    orchestration_signal_ids: resolution.taskSignalIds.join(','),
    orchestration_source: resolution.source,
  };
}

type FirstTurnTitleProposalPort = Pick<
  Agent,
  'sessionUsage' | 'proposeFirstTurnSessionTitle'
>;

/** Fire-and-forget naming must never surface a rejected persistence/model task. */
export function scheduleFirstTurnSessionTitleProposal(
  agent: FirstTurnTitleProposalPort,
  prompt: string,
  answerPreview: string,
  callbacks: RunTurnCallbacks,
): void {
  if (agent.sessionUsage.turns !== 0) return;
  void agent.proposeFirstTurnSessionTitle(prompt, answerPreview, callbacks).catch(() => {
    // The completed turn is authoritative; naming remains opportunistic.
  });
}

export function resolveTurnTerminationReason(
  agent: Agent,
  turnSessionKey: string,
): TurnTerminationReason {
  if (agent.sessionKey !== turnSessionKey) return 'session-changed';
  if (agent.turnAbort?.signal.aborted || agent.interruptRequested) {
    return 'turn-interrupted';
  }
  return 'turn-ended';
}
