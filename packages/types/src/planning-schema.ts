export const PLANNING_SCHEMA_VERSION = 1 as const;
export const PLANNING_SCHEMA_KIND = "planning-schema" as const;

export interface PlanningSchemaSection {
  id: string;
  label: string;
  description: string;
  required: boolean;
}

export interface PlanningSchemaGate {
  id: string;
  label: string;
  description: string;
}

export interface PlanningSchemaDecisionPolicy {
  skillId: string;
  triggerIds: string[];
}

/**
 * Dependency-free catalog record shared by onboarding, CLI, Desktop, and core.
 * Loading, validation, trigger matching, and runtime activation remain owned by
 * core rather than this leaf package.
 */
export interface PlanningSchemaDefinition {
  schemaVersion: typeof PLANNING_SCHEMA_VERSION;
  kind: typeof PLANNING_SCHEMA_KIND;
  id: string;
  label: string;
  description: string;
  profileIds: string[];
  planningSkillIds: string[];
  sections: PlanningSchemaSection[];
  gates: PlanningSchemaGate[];
  decisionPolicy?: PlanningSchemaDecisionPolicy;
}

export type PlanningSchemaSelectionSource =
  | "profile-default"
  | "workspace-selection"
  | "safe-fallback";

export interface ResolvedPlanningSchema {
  schema: PlanningSchemaDefinition;
  source: PlanningSchemaSelectionSource;
  requestedSchemaId: string | null;
  diagnostic?: string;
}

/** Optional reviewed workspace override; absence means the profile default. */
export interface WorkspacePlanningSelection {
  schemaId: string;
}
