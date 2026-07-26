/**
 * Compile one already-resolved child stage into the bounded delegated-task
 * packet contract. Resolution has already intersected role and skill
 * availability; this compiler carries that narrowed result without adding
 * tools, access, history, or arbitrary plan data.
 */
import {
  buildDelegatedTaskPacket,
  type BuildDelegatedTaskPacketInputs,
  type DelegatedTaskPacket,
} from './taskPacket.js';
import type { ResolvedOrchestrationStage } from '../profiles/orchestrationProfileResolver.js';
import { getOutputContract } from '../roles/outputContracts.js';

const MAX_ASSIGNMENT_CHARS = 4_000;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface BuildOrchestrationStageTaskPacketInputs extends Omit<
  BuildDelegatedTaskPacketInputs,
  'task' | 'roleId' | 'expectedOutput'
> {
  orchestrationProfileId: string;
  strategyId: string;
  stage: ResolvedOrchestrationStage;
  /** Bounded fan-out slice, dataset partition, or evidence sub-question. */
  assignment?: string;
}

export function buildOrchestrationStageTaskPacket(
  input: BuildOrchestrationStageTaskPacketInputs,
): DelegatedTaskPacket {
  const {
    stage,
    orchestrationProfileId,
    strategyId: rawStrategyId,
    assignment: rawAssignment,
    ...packetInput
  } = input;
  if (stage.executor.kind !== 'role') {
    throw new Error(`Orchestration stage "${stage.id}" is primary-only and cannot create a child packet.`);
  }
  if (!stage.expectedOutput) {
    throw new Error(`Orchestration stage "${stage.id}" is missing its validated output contract.`);
  }

  const roleId = requiredIdentifier(stage.executor.roleId, 'orchestration role id');
  const stageId = requiredIdentifier(stage.id, 'orchestration stage id');
  const profileId = requiredIdentifier(
    orchestrationProfileId,
    'orchestration profile id',
  );
  const strategyId = requiredIdentifier(rawStrategyId, 'orchestration strategy id');
  const assignment = boundedAssignment(rawAssignment);
  const contract = getOutputContract(roleId);
  if (!contract || stage.expectedOutput.contractId !== contract.id) {
    throw new Error(
      `Orchestration stage "${stageId}" output contract does not match role "${roleId}".`,
    );
  }
  const stageSkillIds = stage.skillIds.map((skillId) =>
    requiredIdentifier(skillId, 'orchestration stage skill id'));
  const capabilities = {
    ...packetInput.capabilities,
    skills: [...new Set([
      ...packetInput.capabilities.skills,
      ...stageSkillIds,
    ])],
  };

  const packet = buildDelegatedTaskPacket({
    ...packetInput,
    task: stage.objective,
    roleId,
    capabilities,
    expectedOutput: {
      contractId: stage.expectedOutput.contractId,
      description: contract?.description,
      requiredSections: stage.expectedOutput.requiredSections,
    },
  });
  return {
    ...packet,
    orchestration: {
      ...packet.orchestration,
      profileId,
      strategyId,
      stageId,
      skillIds: stageSkillIds,
      ...(assignment ? { assignment } : {}),
    },
  };
}

function boundedAssignment(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > MAX_ASSIGNMENT_CHARS
    || UNSAFE_CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(
      `orchestration stage assignment must be at most ${MAX_ASSIGNMENT_CHARS} safe text characters.`,
    );
  }
  return normalized;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 128
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
  ) {
    throw new Error(`${label} must be a stable kebab-case identifier.`);
  }
  return normalized;
}
