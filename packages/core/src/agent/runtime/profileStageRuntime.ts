/**
 * Agent adapter for the turn-owned primary-stage controller.
 *
 * Core orchestration owns lifecycle state; this adapter resolves reviewed
 * workspace/package skills, applies their subtractive tool policy to Agent
 * state, and formats the small model-facing stage guidance used by runTurn.
 */
import type { Agent } from '../agent.js';
import {
  ProfileStageController,
  type RequiredDelegatedStageAction,
  type RequiredPrimaryStageAction,
  type ProfileStageStateEvent,
} from '../../orchestration/runtime/profileStageController.js';
import { resolveStageSkillActivation } from '../../orchestration/runtime/stageSkillActivation.js';
import type { ResolvedWorkspaceOrchestrationPlan } from '../../orchestration/profiles/orchestrationProfileResolver.js';
import type { ActiveTurnOrchestrationResolution } from '../../workspace/activeTurnOrchestration.js';

export function createProfileStageControllerForTurn(input: {
  agent: Agent;
  resolution: ActiveTurnOrchestrationResolution;
  turnSessionKey: string;
  turnExecutionId: string;
  onStateChange?: (event: ProfileStageStateEvent) => void;
}): ProfileStageController | undefined {
  const { agent, resolution } = input;
  if (
    agent.agentDepth !== 0
    || agent.activeSkill
    || resolution.plan.workspaceProfileId === null
    || resolution.plan.planProfileId === null
    || resolution.plan.strategyId === null
    || resolution.plan.stages.length === 0
  ) {
    return undefined;
  }
  return new ProfileStageController(
    { turnId: input.turnExecutionId, sessionKey: input.turnSessionKey },
    resolution.plan,
    {
      loadSkill: async (skillId) => await resolveStageSkillActivation({
        workspaceRoot: agent.workspaceRoot,
        mcpClient: agent.mcpClient,
        signal: agent.turnAbort?.signal,
      }, skillId),
      setActiveSkill: (skill) => {
        agent.activeSkill = skill?.id;
        agent.activeSkillAllowedTools = skill?.allowedTools
          ? [...skill.allowedTools]
          : undefined;
        agent.activeSkillDisallowedTools = skill
          ? [...skill.disallowedTools]
          : [];
      },
      ...(input.onStateChange ? { onStateChange: input.onStateChange } : {}),
    },
  );
}

export function describeProfileStageTool(
  baseDescription: string,
  plan: ResolvedWorkspaceOrchestrationPlan,
): string {
  // `fanOut` is rendered because buildRequiredDelegatedStageCorrection tells the
  // model to use multiple children "only when the stage description permits
  // fan-out" — a permission it could not act on while the description omitted the
  // per-stage min/max. A stage that allows >1 child says so here, in children.
  const stageSummary = plan.stages.map((stage) => {
    const fanOut = stage.fanOut && stage.fanOut.max > 1
      ? `; fan-out: ${stage.fanOut.min}-${stage.fanOut.max} children on DISTINCT angles`
      : '; fan-out: 1 child';
    return (
      `${stage.id} (${stage.executor.kind}${stage.executor.kind === 'role' ? `:${stage.executor.roleId}` : ''}; ` +
      `after: ${stage.after.join(', ') || 'none'}; skills: ${stage.skillIds.join(', ') || 'none'}` +
      `${stage.executor.kind === 'role' ? fanOut : ''}; ` +
      `${stage.optional ? 'optional' : 'required'}) — ${stage.objective}`
    );
  }).join('\n');
  return `${baseDescription}\n\nActive strategy: ${plan.strategyId}\nOrdered compiled stages:\n${stageSummary}`;
}

export function buildRequiredProfileStageCorrection(action: RequiredPrimaryStageAction): string {
  const optionalInstruction = action.optional
    ? ` If this optional stage is not needed, call profile_stage with action "skip" and stageId "${action.stageId}".`
    : '';
  return [
    'Runtime profile-stage guardrail tripped.',
    `The active workspace strategy requires you to ${action.action} skill "${action.skillId}" for primary stage "${action.stageId}" before ending this turn.`,
    `Call profile_stage with action "${action.action}", stageId "${action.stageId}", and skillId "${action.skillId}".${optionalInstruction}`,
    action.action === 'begin'
      ? 'Follow the returned skill instructions and narrowed tool surface before attempting to finish.'
      : 'Complete the stage transition only after you have carried out the active skill instructions.',
  ].join('\n\n');
}

export function buildRequiredDelegatedStageCorrection(
  action: RequiredDelegatedStageAction,
): string {
  return [
    'Runtime profile-stage guardrail tripped.',
    `The active workspace strategy requires delegated stage "${action.stageId}" with role "${action.roleId}" before ending this turn.`,
    `Call task_agent with stageId "${action.stageId}" and a bounded assignment in prompt. The runtime will supply the reviewed role, objective, stage skills, output contract, and authority ceilings.`,
    'Use multiple task_agent calls in the same assistant message only when the stage description permits fan-out. Do not replace the stage with a generic child prompt.',
  ].join('\n\n');
}
