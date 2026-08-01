/**
 * Host-owned preflight for hard-required workflow skills.
 *
 * Required workflows must be in the model context before it chooses a
 * mutating tool. This module reuses the orchestration-stage resolver so
 * workspace precedence, bundled fallback, instruction bounds, and subtractive
 * tool policy do not diverge between planning prerequisites and profile stages.
 */
import type { RunTurnCallbacks } from '../agent.js';
import {
  resolveStageSkillActivation,
  stackStageSkillActivations,
  type StageSkillResolverInput,
  type StackedStageSkills,
} from '../../orchestration/runtime/stageSkillActivation.js';
import type {
  RequiredRuntimeSkill,
  RequiredSkillActivation,
} from '../../workspace/requiredSkillActivation.js';

export interface RequiredSkillPreflightFailure {
  id: string;
  reason: string;
  availability: RequiredRuntimeSkill['availability'];
}

export interface RequiredSkillPreflightResult {
  attemptedSkillIds: Set<string>;
  loadedSkillIds: Set<string>;
  skills: StackedStageSkills;
  failures: RequiredSkillPreflightFailure[];
}

const EMPTY_STACK: StackedStageSkills = {
  ids: [],
  instructions: '',
  disallowedTools: [],
};

export async function preflightRequiredSkills(
  input: StageSkillResolverInput & {
    activation: RequiredSkillActivation;
    alreadyLoadedSkillIds: ReadonlySet<string>;
    callbacks: Pick<RunTurnCallbacks, 'onStatusUpdate'>;
  },
): Promise<RequiredSkillPreflightResult> {
  const attemptedSkillIds = new Set<string>();
  const loadedSkillIds = new Set(input.alreadyLoadedSkillIds);
  const resolved = [];
  const failures: RequiredSkillPreflightFailure[] = [];

  for (const required of input.activation.required) {
    if (loadedSkillIds.has(required.id)) continue;
    attemptedSkillIds.add(required.id);
    if (required.availability === 'disabled') {
      failures.push({
        id: required.id,
        availability: required.availability,
        reason: 'disabled for this workspace',
      });
      continue;
    }

    input.callbacks.onStatusUpdate(
      `Loading required workflow skill: ${required.id}...`,
    );
    try {
      const skill = await resolveStageSkillActivation(input, required.id);
      resolved.push(skill);
      loadedSkillIds.add(required.id);
      input.callbacks.onStatusUpdate(
        `Required workflow skill ready: ${required.id}.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({
        id: required.id,
        availability: required.availability,
        reason: reason.slice(0, 500),
      });
      input.callbacks.onStatusUpdate(
        `Required workflow skill unavailable: ${required.id}.`,
      );
    }
  }

  return {
    attemptedSkillIds,
    loadedSkillIds,
    skills: resolved.length > 0
      ? stackStageSkillActivations(resolved)
      : EMPTY_STACK,
    failures,
  };
}

export function requiredSkillPreflightPrompt(
  result: RequiredSkillPreflightResult,
): string {
  const sections: string[] = [];
  if (result.skills.instructions.trim()) {
    sections.push(
      result.skills.instructions,
      '',
      'These workflows were loaded by the host for this turn. Follow them; do not call `get_skill` merely to acknowledge that they are loaded.',
    );
  }
  if (result.failures.length > 0) {
    sections.push(
      ...(sections.length > 0 ? [''] : []),
      '## Blocked required workflow skills',
      ...result.failures.map((failure) =>
        `- \`${failure.id}\`: ${failure.reason}`),
      '',
      'Read-only diagnosis may continue, but do not claim or attempt mutations that require a blocked workflow.',
    );
  }
  return sections.join('\n');
}
