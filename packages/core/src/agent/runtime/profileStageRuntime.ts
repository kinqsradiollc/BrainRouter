/**
 * Agent adapter for the turn-owned primary-stage controller.
 *
 * Core orchestration owns lifecycle state; this adapter resolves reviewed
 * workspace/package skills, applies their subtractive tool policy to Agent
 * state, and formats the small model-facing stage guidance used by runTurn.
 */
import { randomUUID } from 'node:crypto';
import type { Agent } from '../agent.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import {
  PrimaryStageController,
  type RequiredPrimaryStageAction,
} from '../../orchestration/runtime/primaryStageController.js';
import type { ResolvedWorkspaceOrchestrationPlan } from '../../orchestration/profiles/orchestrationProfileResolver.js';
import type { ActiveTurnOrchestrationResolution } from '../../workspace/activeTurnOrchestration.js';
import {
  parseWorkspaceSkillToolPolicy,
  resolveBundledWorkspaceSkill,
  resolveWorkspaceManagedSkill,
  type WorkspaceManagedSkillResult,
} from '../../workspace/skillToolAdapter.js';

export function createPrimaryStageControllerForTurn(input: {
  agent: Agent;
  resolution: ActiveTurnOrchestrationResolution;
  turnSessionKey: string;
}): PrimaryStageController | undefined {
  const { agent, resolution } = input;
  if (
    agent.agentDepth !== 0
    || agent.activeSkill
    || resolution.plan.orchestrationProfileId === null
    || resolution.plan.strategyId === null
    || !resolution.plan.stages.some((stage) => stage.executor.kind === 'primary')
  ) {
    return undefined;
  }
  return new PrimaryStageController(
    { turnId: randomUUID(), sessionKey: input.turnSessionKey },
    resolution.plan,
    {
      loadSkill: async (skillId) => {
        const managed = resolveWorkspaceManagedSkill(agent.workspaceRoot, skillId, 'full');
        if (managed) return activationFromResolvedSkill(skillId, managed);

        let serviceFailure = 'skill service returned no valid workflow';
        try {
          const result = await agent.mcpClient.callTool(
            'get_skill',
            { name: skillId, section: 'full' },
            { signal: agent.turnAbort?.signal },
          );
          const instructions = extractToolText(result);
          if (!result.isError && /^##\s+Workflow\b/im.test(instructions)) {
            const policy = parseWorkspaceSkillToolPolicy(instructions);
            return {
              id: skillId,
              instructions,
              ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
              disallowedTools: [...policy.disallowedTools],
            };
          }
          serviceFailure = instructions || serviceFailure;
        } catch (error) {
          serviceFailure = error instanceof Error ? error.message : String(error);
        }

        const bundled = resolveBundledWorkspaceSkill(agent.workspaceRoot, skillId, 'full');
        if (!bundled) throw new Error(serviceFailure);
        return activationFromResolvedSkill(skillId, bundled);
      },
      setActiveSkill: (skill) => {
        agent.activeSkill = skill?.id;
        agent.activeSkillAllowedTools = skill?.allowedTools
          ? [...skill.allowedTools]
          : undefined;
        agent.activeSkillDisallowedTools = skill
          ? [...skill.disallowedTools]
          : [];
      },
    },
  );
}

export function describeProfileStageTool(
  baseDescription: string,
  plan: ResolvedWorkspaceOrchestrationPlan,
): string {
  const stageSummary = plan.stages.map((stage) => (
    `${stage.id} (${stage.executor.kind}${stage.executor.kind === 'role' ? `:${stage.executor.roleId}` : ''}; ` +
    `after: ${stage.after.join(', ') || 'none'}; skills: ${stage.skillIds.join(', ') || 'none'}; ` +
    `${stage.optional ? 'optional' : 'required'}) — ${stage.objective}`
  )).join('\n');
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

function activationFromResolvedSkill(
  skillId: string,
  resolved: WorkspaceManagedSkillResult,
) {
  const instructions = resolved.content[0]?.text ?? '';
  return {
    id: skillId,
    instructions,
    ...(resolved.metadata.allowedTools
      ? { allowedTools: [...resolved.metadata.allowedTools] }
      : {}),
    disallowedTools: [...resolved.metadata.disallowedTools],
  };
}
