/**
 * Resolve and compose reviewed orchestration-stage skills without depending on
 * a CLI surface. Workspace/package precedence and subtractive tool policy stay
 * identical for primary and delegated stages.
 */
import { extractToolText } from '../../mcp/mcpUtils.js';
import {
  parseWorkspaceSkillToolPolicy,
  resolveBundledWorkspaceSkill,
  resolveWorkspaceManagedSkill,
  type WorkspaceManagedSkillResult,
} from '../../workspace/skillToolAdapter.js';

const MAX_STACKED_INSTRUCTION_CHARS = 128_000;

export interface StageSkillActivation {
  id: string;
  instructions: string;
  allowedTools?: string[];
  disallowedTools: string[];
}

export interface StageSkillResolverInput {
  workspaceRoot: string;
  mcpClient: {
    callTool(
      name: string,
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{ isError?: boolean; content?: unknown }>;
  };
  signal?: AbortSignal;
}

export interface StackedStageSkills {
  ids: string[];
  instructions: string;
  allowedTools?: string[];
  disallowedTools: string[];
}

export async function resolveStageSkillActivation(
  input: StageSkillResolverInput,
  skillId: string,
): Promise<StageSkillActivation> {
  const managed = resolveWorkspaceManagedSkill(input.workspaceRoot, skillId, 'full');
  if (managed) return activationFromResolvedSkill(skillId, managed);

  let serviceFailure = 'skill service returned no valid workflow';
  try {
    const result = await input.mcpClient.callTool(
      'get_skill',
      { name: skillId, section: 'full' },
      { signal: input.signal },
    );
    const instructions = extractToolText(result as any);
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

  const bundled = resolveBundledWorkspaceSkill(input.workspaceRoot, skillId, 'full');
  if (!bundled) throw new Error(serviceFailure);
  return activationFromResolvedSkill(skillId, bundled);
}

export function stackStageSkillActivations(
  activations: readonly StageSkillActivation[],
): StackedStageSkills {
  const ids: string[] = [];
  const disallowed = new Set<string>();
  let allowedTools: string[] | undefined;
  const sections: string[] = [
    '## Required orchestration-stage skills',
    'Run these reviewed workflows in order. Their tool policies only narrow the child role and parent authority ceilings.',
  ];
  for (const [index, activation] of activations.entries()) {
    if (!ids.includes(activation.id)) ids.push(activation.id);
    for (const tool of activation.disallowedTools) disallowed.add(tool);
    if (activation.allowedTools !== undefined) {
      allowedTools = allowedTools === undefined
        ? [...activation.allowedTools]
        : allowedTools.filter((tool) => activation.allowedTools?.includes(tool));
    }
    sections.push(
      '',
      `### Stage skill ${index + 1}: ${activation.id}`,
      activation.instructions.trim(),
    );
  }
  const instructions = sections.join('\n');
  if (instructions.length > MAX_STACKED_INSTRUCTION_CHARS) {
    throw new Error(
      `Stage skill instructions exceed the ${MAX_STACKED_INSTRUCTION_CHARS}-character activation limit.`,
    );
  }
  return {
    ids,
    instructions,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    disallowedTools: [...disallowed],
  };
}

function activationFromResolvedSkill(
  skillId: string,
  resolved: WorkspaceManagedSkillResult,
): StageSkillActivation {
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
