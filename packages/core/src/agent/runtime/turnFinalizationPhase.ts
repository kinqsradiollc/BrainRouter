import type { Agent, RunTurnCallbacks } from '../agent.js';
import type { ActiveTurnOrchestrationResolution } from '../../workspace/activeTurnOrchestration.js';
import { collectStopAdditionalContext, runHooks } from '../../hooks/hooksStore.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { shrinkOversizedToolResults } from '../guards/turnEndShrink.js';
import { normalizeTurnCompletionAnswer } from './completionPhase.js';
import { scheduleLearningCheckpoint } from './learningPhase.js';

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
}

export type TurnTerminationReason =
  | 'session-changed'
  | 'turn-interrupted'
  | 'turn-ended';

export async function finalizeTurnPhase(
  agent: Agent,
  input: FinalizeTurnInput,
): Promise<string> {
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

  await agent.captureTurn(input.prompt, finalAnswer, input.callbacks);
  // ADR-032 D5 — the turn-end checkpoint. Dispatched, never awaited: §1's worst
  // gap is that an agent learns only when it remembers to ask, and the fix for
  // that must not become a thing a person waits on. It sits after captureTurn
  // so the trajectory it reads is the finished one.
  scheduleLearningCheckpoint(agent, 'turn-end');
  if (agent.hookAdvisoryActive()) {
    runHooks(agent.workspaceRoot, 'post-turn', {
      payload: {
        prompt: input.prompt,
        answerPreview: finalAnswer.slice(0, 1000),
        tokens: agent.lastTurnUsage,
      },
    });
  }

  if (agent.hookNotifyActive()) {
    try {
      const stopEvent = agent.silent ? 'subagent-stop' : 'stop';
      const stopResults = runHooks(agent.workspaceRoot, stopEvent, {
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

    try {
      runHooks(agent.workspaceRoot, 'notification-agent-completed', {
        payload: {
          sessionKey: agent.sessionKey,
          silent: agent.silent,
          answerPreview: finalAnswer.slice(0, 200),
        },
      });
    } catch {
      // Completion notifications are advisory.
    }
  }

  input.turnSpan.end({
    outcome: input.exitedCleanly ? 'ok' : 'loop_limit',
    loops_used: input.loopCount,
    tokens_in: agent.lastTurnUsage.promptTokens,
    tokens_out: agent.lastTurnUsage.completionTokens,
    orchestration_profile_id:
      input.activeTurnOrchestration.plan.orchestrationProfileId,
    orchestration_strategy_id:
      input.activeTurnOrchestration.plan.strategyId,
    orchestration_selection_source:
      input.activeTurnOrchestration.plan.selectionSource,
    orchestration_stage_count:
      input.activeTurnOrchestration.plan.stages.length,
    orchestration_signal_ids:
      input.activeTurnOrchestration.taskSignalIds.join(','),
    orchestration_source: input.activeTurnOrchestration.source,
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

  return finalAnswer;
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
