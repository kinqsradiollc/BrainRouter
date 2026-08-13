/**
 * Model-visible context preparation for one agent turn.
 *
 * Owns bounded pre-turn compaction, recall, prompt-hook context, planning
 * hints, goal and required-skill anchors, and pending-child completion
 * feedback. It does not construct tools, invoke the main model, or dispatch
 * side effects.
 */
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs } from '../../config/config.js';
import { contextWindowForBudget } from '../../context/contextWindow.js';
import { readGoal, formatGoalBlock } from '../../goal/store/goalStore.js';
import { runHooks, parseHookDecision } from '../../hooks/hooksStore.js';
import {
  buildFanOutHint,
  shouldSuggestFanOut,
} from '../../prompt/planning/breadthHint.js';
import {
  buildNextActionMessages,
  nextActionDirective,
  parseNextActionPlan,
  planWantsFanOut,
  shouldSkipPlanner,
} from '../../prompt/planning/nextAction.js';
import {
  drainCompletions,
  formatCompletionFeedback,
} from '../../session/completion/completionInbox.js';
import { estimateChatHistoryTokens } from '../../util/tokens/tokenEstimate.js';
import { buildPendingChildStatusHint } from '../../util/agentloop/childResume.js';
import {
  requiredSkillActivationPrompt,
  type RequiredSkillActivation,
} from '../../workspace/requiredSkillActivation.js';
import {
  requiredSkillPreflightPrompt,
  type RequiredSkillPreflightResult,
} from './requiredSkillPreflight.js';
import { applyLearnedContext } from './learningPhase.js';
import {
  buildPlannerContext,
  sourceFreshnessFromItems,
  PLANNER_CONTEXT_TAG,
} from '../../planner/agentContext.js';
import { todayView } from '../../planner/plannerService.js';
import { listBlocks } from '../../planner/plannerStore.js';
import { callOpenAI } from '../transport/llmTransport.js';

export interface PrepareTurnContextInput {
  prompt: string;
  callbacks: RunTurnCallbacks;
  mcpTools: unknown[];
  requiredSkillActivation: RequiredSkillActivation;
  requiredSkillPreflight: RequiredSkillPreflightResult;
  carriedPendingChildIds: string[];
  images?: Array<{ mediaType: string; dataBase64: string }>;
}

export interface PreparedTurnContext {
  prompt: string;
  fanOutHinted: boolean;
  blockedAnswer?: string;
}

export async function prepareTurnContextPhase(
  agent: Agent,
  input: PrepareTurnContextInput,
): Promise<PreparedTurnContext> {
  let prompt = input.prompt;

  if (!agent.silent) {
    const windowCap = Math.floor(
      contextWindowForBudget(agent.getModel()) * 0.9,
    );
    const autoCompactThreshold = Math.min(
      getCliKnobs().autoCompactTokens,
      windowCap,
    );
    const promptTokens =
      agent.lastSeenPromptTokens !== undefined &&
        agent.lastSeenPromptTokens > 0
        ? agent.lastSeenPromptTokens
        : estimateChatHistoryTokens(agent.chatHistory as any);
    if (
      promptTokens > autoCompactThreshold &&
      agent.chatHistory.length > 6
    ) {
      input.callbacks.onStatusUpdate(
        `Auto-compacting history (~${promptTokens.toLocaleString()} tokens > ${autoCompactThreshold.toLocaleString()})...`,
      );
      try {
        const beforeLen = agent.chatHistory.length;
        const compacted = await agent.compactHistory();
        if (compacted && input.callbacks.onCompactionEvent) {
          input.callbacks.onCompactionEvent({
            droppedMessages: Math.max(
              0,
              beforeLen - agent.chatHistory.length,
            ),
            keptMessages: agent.chatHistory.length,
            summary: compacted.summary,
          });
        }
        agent.lastSeenPromptTokens = undefined;
      } catch {
        // Compaction is opportunistic; the provider still owns hard limits.
      }
    }
  }

  await agent.injectRecallContext(prompt, input.mcpTools as any[], input.callbacks);

  if (agent.hookAdvisoryActive()) {
    runHooks(agent.workspaceRoot, 'pre-turn', { payload: { prompt } });
    void agent.runExtensionHooks('pre-turn');
  }
  if (agent.hookEnforceActive()) {
    const extensionDenial = await agent.runExtensionHooks(
      'user-prompt-submit',
      { args: { prompt } },
    );
    if (extensionDenial) {
      return {
        prompt,
        fanOutHinted: false,
        blockedAnswer:
          `Prompt blocked by user-prompt-submit hook: ${extensionDenial}`,
      };
    }

    const results = runHooks(agent.workspaceRoot, 'user-prompt-submit', {
      payload: { prompt },
    });
    const injectedContext: string[] = [];
    for (const result of results) {
      const decision = parseHookDecision(result.stdout);
      const denied =
        decision?.decision === 'deny' ||
        (!decision && result.exitCode !== 0);
      if (denied) {
        const reason =
          decision?.reason?.trim() ||
          (result.stderr || result.stdout || '').toString().trim() ||
          `Hook ${result.hook.id} blocked this prompt`;
        return {
          prompt,
          fanOutHinted: false,
          blockedAnswer:
            `Prompt blocked by user-prompt-submit hook: ${reason}`,
        };
      }
      if (
        typeof decision?.additionalContext === 'string' &&
        decision.additionalContext.trim()
      ) {
        injectedContext.push(decision.additionalContext.trim());
      }
    }
    if (injectedContext.length > 0) {
      prompt = `${prompt}\n\n[hook context]\n${injectedContext.join('\n')}`;
    }
  }

  agent.lastUserPrompt = prompt;
  agent.lastTurnHitLoopLimit = false;
  if (!agent.reviewSourceSafety) {
    try {
      agent.autoCaptureRequirement(prompt, input.callbacks);
    } catch {
      // Requirement capture is best-effort and cannot fail the user turn.
    }
  }

  const fanOutHinted = await preparePlanningHint(
    agent,
    prompt,
    input.callbacks,
  );
  applyGoalAnchor(agent);
  // ADR-032 D1 — the learned block, attached like every other anchor and
  // never merged into the base prompt.
  applyLearnedContext(agent);
  // ADR-028 D6 — and the planner block, for the same reason: an agent holding
  // planner TOOLS but no planner CONTEXT has to ask for what it could be told.
  applyPlannerContext(agent);
  applyRequiredSkillAnchor(agent, input.requiredSkillActivation);
  applyRequiredSkillWorkflows(agent, input.requiredSkillPreflight);
  appendUserMessage(agent, prompt, input.images);
  appendPendingChildHint(
    agent,
    input.carriedPendingChildIds,
  );
  appendCompletionFeedback(agent);

  return { prompt, fanOutHinted };
}

/**
 * ADR-028 D6 — put today in front of the model, bounded and summarised.
 *
 * The planner is user-scoped, so no workspace is threaded — the same `undefined`
 * the `planner_*` tool handlers pass, so the block and the tools cannot disagree
 * about whose planner this is.
 *
 * Removed rather than left behind when there is nothing to say: a section that
 * always appears trains the model to skip it, and a yesterday-shaped block after
 * everything was completed would be a surface claiming a state that has ended.
 *
 * Sub-agents (`silent`) are excluded like the learned block: a bounded,
 * single-purpose turn spends its context better on the task it was given than on
 * its operator's day.
 */
function applyPlannerContext(agent: Agent): void {
  if (agent.silent) return;
  let block: string | null = null;
  try {
    const nowMs = Date.now();
    const view = todayView(undefined, {
      date: new Date(nowMs).toISOString().slice(0, 10),
      nowMs,
    });
    block = buildPlannerContext({
      todayItems: view.items,
      // Every open block, not just today's: `buildPlannerContext` picks the next
      // one itself, and the carried-over count is about the whole backlog.
      blocks: listBlocks(undefined),
      freshness: sourceFreshnessFromItems(view.items),
      nowMs,
    });
  } catch {
    // A missing, unreadable or corrupt planner cache must never be what fails a
    // turn. No planner is the common case on a fresh install.
    block = null;
  }
  if (!block) {
    agent.removeTaggedSystemMessage(PLANNER_CONTEXT_TAG);
    return;
  }
  agent.replaceTaggedSystemMessage(PLANNER_CONTEXT_TAG, block);
}

function applyRequiredSkillWorkflows(
  agent: Agent,
  preflight: RequiredSkillPreflightResult,
): void {
  const prompt = requiredSkillPreflightPrompt(preflight);
  if (prompt) {
    agent.replaceTaggedSystemMessage('required-skill-workflows', prompt);
  } else {
    agent.removeTaggedSystemMessage('required-skill-workflows');
  }
}

async function preparePlanningHint(
  agent: Agent,
  prompt: string,
  callbacks: RunTurnCallbacks,
): Promise<boolean> {
  if (agent.silent) return false;

  let fanOutHinted = false;
  let planned = false;
  if (
    getCliKnobs().nextActionPlanner !== 'off' &&
    !shouldSkipPlanner(prompt)
  ) {
    try {
      callbacks.onToolStart('next-action-planner', {});
      const buildLoop = getCliKnobs().buildLoop;
      const response: any = await callOpenAI(
        agent.llmConfig,
        buildNextActionMessages(prompt, undefined, buildLoop),
        [],
        { effort: 'low', signal: agent.turnAbort?.signal },
      );
      const plan = parseNextActionPlan(response?.content, { buildLoop });
      if (plan) {
        planned = true;
        const directive = nextActionDirective(plan);
        if (directive) {
          agent.replaceTaggedSystemMessage('next-action-plan', directive);
        }
        fanOutHinted = planWantsFanOut(plan);
        callbacks.onToolEnd('next-action-planner', {
          success: true,
          summary:
            `strategy=${plan.strategy}${
              plan.subtasks.length
                ? ` (${plan.subtasks.length} subtasks)`
                : ''
            }`,
        });
        callbacks.onStatusUpdate(
          `Next-action plan: ${plan.strategy}${
            fanOutHinted ? ' — fanning out' : ''
          }`,
        );
      } else {
        callbacks.onToolEnd('next-action-planner', {
          success: true,
          summary: 'no usable plan — fail-open to heuristic',
        });
      }
    } catch {
      callbacks.onToolEnd('next-action-planner', {
        success: false,
        summary: 'planner unavailable — fail-open to heuristic',
      });
    }
  }

  if (!planned) {
    const { suggest, intent } = shouldSuggestFanOut(prompt);
    if (suggest) {
      fanOutHinted = true;
      agent.replaceTaggedSystemMessage(
        'fanout-hint',
        buildFanOutHint(prompt, intent),
      );
      callbacks.onStatusUpdate(
        `Fan-out hint injected (signals: ${intent.signals.join(', ')})`,
      );
      callbacks.onToolStart('breadth-detector', {
        signals: intent.signals,
        score: intent.score,
      });
      callbacks.onToolEnd('breadth-detector', {
        success: true,
        summary: `fan-out hint injected (${intent.signals.length} signals)`,
      });
    }
  }

  return fanOutHinted;
}

function applyGoalAnchor(agent: Agent): void {
  if (agent.silent) return;
  const activeGoal = readGoal(agent.workspaceRoot, agent.sessionKey);
  if (activeGoal?.text && activeGoal.status === 'active') {
    agent.replaceTaggedSystemMessage('goal-anchor', formatGoalBlock(activeGoal));
  } else {
    agent.removeTaggedSystemMessage('goal-anchor');
  }
}

function applyRequiredSkillAnchor(
  agent: Agent,
  activation: RequiredSkillActivation,
): void {
  const requiredSkillsPrompt = requiredSkillActivationPrompt(activation);
  if (requiredSkillsPrompt) {
    agent.replaceTaggedSystemMessage('required-skills', requiredSkillsPrompt);
  } else {
    agent.removeTaggedSystemMessage('required-skills');
  }
}

function appendUserMessage(
  agent: Agent,
  prompt: string,
  images?: Array<{ mediaType: string; dataBase64: string }>,
): void {
  const userMessage: {
    role: string;
    content: string;
    images?: Array<{ mediaType: string; dataBase64: string }>;
  } = { role: 'user', content: prompt };
  if (images?.length) userMessage.images = images;
  agent.chatHistory.push(userMessage);
}

function appendPendingChildHint(
  agent: Agent,
  carriedPendingChildIds: string[],
): void {
  const hint = buildPendingChildStatusHint(carriedPendingChildIds);
  if (!hint) return;
  const message = { role: 'system', content: hint };
  agent.chatHistory.push(message);
  agent.recordTranscript(message);
}

function appendCompletionFeedback(agent: Agent): void {
  const completions = drainCompletions(agent.sessionKey);
  if (completions.length === 0) return;
  const feedback = formatCompletionFeedback(completions);
  if (!feedback) return;
  const message = { role: 'system', content: feedback };
  agent.chatHistory.push(message);
  agent.recordTranscript(message);
}
