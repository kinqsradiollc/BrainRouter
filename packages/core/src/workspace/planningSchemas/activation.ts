import type {
  PlanningSchemaDefinition,
  ResolvedPlanningSchema,
} from '@kinqs/brainrouter-types/planning-schema';
import type { WorkspaceProfileId } from '../profiles.js';
import { resolvePlanningSchema } from './catalog.js';

export interface PlanningSchemaSkillRequirement {
  id: string;
  reason: string;
}

export interface PlanningSchemaActivation {
  selection: ResolvedPlanningSchema;
  planningRequired: boolean;
  decisionTriggerIds: string[];
  requiredSkills: PlanningSchemaSkillRequirement[];
}

export function resolvePlanningSchemaActivation(input: {
  profileId: WorkspaceProfileId;
  prompt: string;
  activeGoal: boolean;
  selectedSchemaId?: string | null;
  catalog?: readonly PlanningSchemaDefinition[];
}): PlanningSchemaActivation {
  const selection = resolvePlanningSchema({
    profileId: input.profileId,
    selectedSchemaId: input.selectedSchemaId,
    catalog: input.catalog,
  });
  const planningRequired = input.activeGoal || requiresPlanning(input.prompt);
  const decisionTriggerIds = decisionTriggers(input.prompt, selection.schema);
  const requiredSkills = planningRequired
    ? selection.schema.planningSkillIds.map((id) => ({
      id,
      reason: `the ${selection.schema.label} schema is required for this work`,
    }))
    : [];
  if (decisionTriggerIds.length > 0 && selection.schema.decisionPolicy) {
    requiredSkills.push({
      id: selection.schema.decisionPolicy.skillId,
      reason: `architecture decision triggers matched: ${decisionTriggerIds.join(', ')}`,
    });
  }
  return {
    selection,
    planningRequired,
    decisionTriggerIds,
    requiredSkills: uniqueRequirements(requiredSkills),
  };
}

function requiresPlanning(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(plan|planning|taskboard|multi[- ](?:stage|step|agent)|end[- ]to[- ]end|parallel agents?|sub[- ]?agents?|delegate|delegation|deep research|multiple deliverables|several deliverables)\b/.test(normalized);
}

function decisionTriggers(
  prompt: string,
  schema: PlanningSchemaDefinition,
): string[] {
  const policy = schema.decisionPolicy;
  if (!policy) return [];
  const normalized = prompt.toLowerCase();
  const explicit = /\badr(?:-\d+)?\b|architecture decision record/.test(normalized);
  const matched = policy.triggerIds.filter((id) => triggerMatches(id, normalized));
  if (explicit && matched.length === 0) return ['explicit-architecture-decision'];
  return matched;
}

function triggerMatches(id: string, prompt: string): boolean {
  switch (id) {
    case 'public-contract':
      return /\b(public api|public contract|wire contract|protocol|sdk|exported interface)\b/.test(prompt);
    case 'security-boundary':
      return /\b(authentication|authorization|permission|security boundary|credential|sandbox|tenant)\b/.test(prompt);
    case 'persistence-model':
      return /\b(database schema|data model|persistence|migration|durable store|storage format)\b/.test(prompt);
    case 'provider-runtime-boundary':
      return /\b(provider|runtime boundary|host protocol|model router|execution host)\b/.test(prompt);
    case 'cross-surface':
      return /\b(cross[- ]surface|desktop and cli|cli and desktop|backend and desktop|all clients)\b/.test(prompt);
    case 'expensive-to-reverse':
      return /\b(expensive to reverse|irreversible|foundational architecture|dependency choice)\b/.test(prompt);
    default:
      return false;
  }
}

function uniqueRequirements(
  requirements: PlanningSchemaSkillRequirement[],
): PlanningSchemaSkillRequirement[] {
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    if (seen.has(requirement.id)) return false;
    seen.add(requirement.id);
    return true;
  });
}
