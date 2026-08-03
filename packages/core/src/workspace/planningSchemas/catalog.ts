import { fileURLToPath } from 'node:url';
import type {
  PlanningSchemaDefinition,
  ResolvedPlanningSchema,
} from '@kinqs/brainrouter-types/planning-schema';
import type { WorkspaceProfileId } from '../profiles.js';
import {
  listPlanningSchemaFiles,
  readPlanningSchemaFile,
} from './definitionFile.js';

const BUNDLED_PLANNING_SCHEMAS_DIR = fileURLToPath(
  new URL('../../../planning-schemas', import.meta.url),
);

const DEFAULT_SCHEMA_BY_PROFILE: Readonly<Record<WorkspaceProfileId, string>> = {
  engineering: 'engineering-delivery',
  // Domain profiles added in 0.4.19 reuse the closest existing schema rather
  // than inventing eleven near-duplicate ones. A schema describes the SHAPE of
  // planning (evidence-gathering vs delivery vs editorial), and these domains
  // genuinely share those shapes — sales and marketing both plan editorially,
  // legal and healthcare both plan around evidence. A bespoke schema per domain
  // would be eleven files differing only in wording, which is how a catalog
  // stops being read.
  'product-management': 'engineering-delivery',
  design: 'engineering-delivery',
  operations: 'engineering-delivery',
  consulting: 'research-evidence',
  legal: 'research-evidence',
  healthcare: 'research-evidence',
  finance: 'data-science-experiment',
  education: 'study-learning',
  marketing: 'writing-editorial',
  sales: 'writing-editorial',
  people: 'writing-editorial',
  research: 'research-evidence',
  'data-science': 'data-science-experiment',
  study: 'study-learning',
  writing: 'writing-editorial',
  custom: 'custom-deliverable',
};

export function loadPlanningSchemaCatalog(
  directory = BUNDLED_PLANNING_SCHEMAS_DIR,
): PlanningSchemaDefinition[] {
  const schemas = listPlanningSchemaFiles(directory)
    .map((filePath) => readPlanningSchemaFile(filePath, directory))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const schema of schemas) {
    if (ids.has(schema.id)) throw new Error(`Duplicate planning schema id "${schema.id}".`);
    ids.add(schema.id);
  }
  for (const [profileId, schemaId] of Object.entries(DEFAULT_SCHEMA_BY_PROFILE)) {
    const schema = schemas.find((candidate) => candidate.id === schemaId);
    if (!schema || !schema.profileIds.includes(profileId)) {
      throw new Error(`Planning schema catalog has no valid default for profile "${profileId}".`);
    }
  }
  return schemas;
}

export function resolvePlanningSchema(input: {
  profileId: WorkspaceProfileId;
  selectedSchemaId?: string | null;
  catalog?: readonly PlanningSchemaDefinition[];
}): ResolvedPlanningSchema {
  const catalog = input.catalog ?? loadPlanningSchemaCatalog();
  const requestedSchemaId = input.selectedSchemaId?.trim() || null;
  if (requestedSchemaId) {
    const selected = catalog.find((schema) => schema.id === requestedSchemaId);
    if (selected && (input.profileId === 'custom' || selected.profileIds.includes(input.profileId))) {
      return {
        schema: selected,
        source: 'workspace-selection',
        requestedSchemaId,
      };
    }
  }

  const defaultId = DEFAULT_SCHEMA_BY_PROFILE[input.profileId];
  const fallback = catalog.find((schema) => schema.id === defaultId)
    ?? catalog.find((schema) => schema.id === DEFAULT_SCHEMA_BY_PROFILE.custom);
  if (!fallback) throw new Error('Planning schema catalog has no safe fallback.');
  return {
    schema: fallback,
    source: requestedSchemaId ? 'safe-fallback' : 'profile-default',
    requestedSchemaId,
    ...(requestedSchemaId
      ? {
        diagnostic: `Planning schema "${requestedSchemaId}" is unavailable for profile "${input.profileId}" and was replaced by "${fallback.id}".`,
      }
      : {}),
  };
}

export function defaultPlanningSchemaId(profileId: WorkspaceProfileId): string {
  return DEFAULT_SCHEMA_BY_PROFILE[profileId];
}
