import type { WorkspaceManifest } from './manifest.js';

export type RequiredRuntimeSkillId = 'planning-skill' | 'adr-skill';

export interface RequiredRuntimeSkill {
  id: RequiredRuntimeSkillId;
  reason: string;
  availability: 'available' | 'disabled';
}

export interface RequiredSkillActivation {
  required: RequiredRuntimeSkill[];
}

export function resolveRequiredSkillActivation(input: {
  prompt: string;
  activeGoal: boolean;
  manifest?: Pick<WorkspaceManifest, 'profile' | 'skills'> | null;
}): RequiredSkillActivation {
  const required: RequiredRuntimeSkill[] = [];
  const disabled = new Set(input.manifest?.skills.disabled ?? []);
  const add = (id: RequiredRuntimeSkillId, reason: string): void => {
    if (required.some((skill) => skill.id === id)) return;
    required.push({
      id,
      reason,
      availability: disabled.has(id) ? 'disabled' : 'available',
    });
  };

  if (input.activeGoal) {
    add('planning-skill', 'an active goal requires a durable, current plan');
  } else if (requiresPlanning(input.prompt)) {
    add('planning-skill', 'the request is multi-stage, delegated, research-heavy, or explicitly asks for planning');
  }

  if (requiresArchitectureDecision(input.prompt)) {
    add('adr-skill', 'the request explicitly requires a durable architecture or cross-surface decision');
  }

  return { required };
}

export function requiredSkillActivationPrompt(activation: RequiredSkillActivation): string {
  if (activation.required.length === 0) return '';
  const lines = activation.required.map((skill) =>
    `- \`${skill.id}\` (${skill.availability}): ${skill.reason}`);
  return [
    '## Required workflow skills',
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

function requiresPlanning(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(plan|planning|taskboard|multi[- ](?:stage|step|agent)|end[- ]to[- ]end|parallel agents?|sub[- ]?agents?|delegate|delegation|deep research|multiple deliverables|several deliverables)\b/.test(normalized);
}

function requiresArchitectureDecision(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (/\badr(?:-\d+)?\b|architecture decision record/.test(normalized)) return true;
  const durableSurface =
    /\b(public api|data model|database schema|authorization|permission model|dependency choice|cross[- ]surface|lifecycle contract|orchestration contract|context contract)\b/.test(normalized);
  const decisionIntent =
    /\b(decide|decision|choose|choice|trade[- ]?off|architecture|architectural|design)\b/.test(normalized);
  return durableSurface && decisionIntent;
}
