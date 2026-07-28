import type { WorkspaceManifest } from './manifest.js';
import { resolvePlanningSchemaActivation } from './planningSchemas/activation.js';

export type RequiredRuntimeSkillId = string;

export interface RequiredRuntimeSkill {
  id: RequiredRuntimeSkillId;
  reason: string;
  availability: 'available' | 'disabled';
}

export interface RequiredSkillActivation {
  planningSchema: {
    id: string;
    label: string;
    source: 'profile-default' | 'workspace-selection' | 'safe-fallback';
  };
  required: RequiredRuntimeSkill[];
}

export function resolveRequiredSkillActivation(input: {
  prompt: string;
  activeGoal: boolean;
  manifest?: Pick<WorkspaceManifest, 'profile' | 'planning' | 'skills'> | null;
}): RequiredSkillActivation {
  const required: RequiredRuntimeSkill[] = [];
  const disabled = new Set(input.manifest?.skills.disabled ?? []);
  const schemaActivation = resolvePlanningSchemaActivation({
    profileId: input.manifest?.profile ?? 'custom',
    prompt: input.prompt,
    activeGoal: input.activeGoal,
    selectedSchemaId: input.manifest?.planning?.schemaId,
  });
  const add = (id: RequiredRuntimeSkillId, reason: string): void => {
    if (required.some((skill) => skill.id === id)) return;
    required.push({
      id,
      reason,
      availability: disabled.has(id) ? 'disabled' : 'available',
    });
  };

  for (const skill of schemaActivation.requiredSkills) add(skill.id, skill.reason);
  if (requiresExplicitArchitectureDecision(input.prompt) &&
      !required.some((skill) => skill.id === 'adr-skill')) {
    add('adr-skill', 'the request explicitly requires a durable architecture or cross-surface decision');
  }

  return {
    planningSchema: {
      id: schemaActivation.selection.schema.id,
      label: schemaActivation.selection.schema.label,
      source: schemaActivation.selection.source,
    },
    required,
  };
}

export function requiredSkillActivationPrompt(activation: RequiredSkillActivation): string {
  if (activation.required.length === 0) return '';
  const lines = activation.required.map((skill) =>
    `- \`${skill.id}\` (${skill.availability}): ${skill.reason}`);
  return [
    '## Required workflow skills',
    `Planning schema: ${activation.planningSchema.label} (\`${activation.planningSchema.id}\`, ${activation.planningSchema.source})`,
    '',
    ...lines,
    '',
    'Before the first mutating tool call, load each available required skill with `get_skill` and follow it unless the host already embedded that skill for this turn.',
    'A disabled required skill is a visible fail-safe: explain the limitation and ask the user to enable it; do not silently continue with a weaker workflow.',
    'Loading a skill never expands tool, profile, permission, or approval authority.',
  ].join('\n');
}

export function requiredSkillsBlockingMutation(
  activation: RequiredSkillActivation,
  loadedSkillIds: ReadonlySet<string>,
): RequiredRuntimeSkill[] {
  return activation.required.filter(
    (skill) => skill.availability === 'disabled' || !loadedSkillIds.has(skill.id),
  );
}

function requiresExplicitArchitectureDecision(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (/\badr(?:-\d+)?\b|architecture decision record/.test(normalized)) return true;
  const durableSurface =
    /\b(public api|data model|database schema|authorization|permission model|dependency choice|cross[- ]surface|lifecycle contract|orchestration contract|context contract)\b/.test(normalized);
  const decisionIntent =
    /\b(decide|decision|choose|choice|trade[- ]?off|architecture|architectural|design)\b/.test(normalized);
  return durableSurface && decisionIntent;
}
