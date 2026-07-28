import fs from 'node:fs';
import path from 'node:path';
import {
  PLANNING_SCHEMA_KIND,
  PLANNING_SCHEMA_VERSION,
  type PlanningSchemaDecisionPolicy,
  type PlanningSchemaDefinition,
  type PlanningSchemaGate,
  type PlanningSchemaSection,
} from '@kinqs/brainrouter-types/planning-schema';

export const PLANNING_SCHEMA_MAX_BYTES = 64 * 1024;

const MAX_ITEMS = 24;
const MAX_ID_CHARS = 96;
const MAX_LABEL_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 1_024;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'label',
  'description',
  'profileIds',
  'planningSkillIds',
  'sections',
  'gates',
  'decisionPolicy',
]);
const SECTION_FIELDS = new Set(['id', 'label', 'description', 'required']);
const GATE_FIELDS = new Set(['id', 'label', 'description']);
const DECISION_POLICY_FIELDS = new Set(['skillId', 'triggerIds']);

export function listPlanningSchemaFiles(directory: string): string[] {
  const root = path.resolve(directory);
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export function readPlanningSchemaFile(
  filePath: string,
  directory = path.dirname(filePath),
): PlanningSchemaDefinition {
  const root = path.resolve(directory);
  const resolved = path.resolve(filePath);
  if (!isContainedPath(resolved, root)) {
    throw new Error('Planning schema file must remain inside its catalog directory.');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Planning schema file must be a regular file.');
  }
  if (stat.size <= 0 || stat.size > PLANNING_SCHEMA_MAX_BYTES) {
    throw new Error(`Planning schema file must be 1-${PLANNING_SCHEMA_MAX_BYTES} bytes.`);
  }
  return parsePlanningSchema(
    fs.readFileSync(resolved, 'utf8'),
    path.basename(resolved, '.json'),
  );
}

export function parsePlanningSchema(
  raw: string,
  expectedProfileId: string,
): PlanningSchemaDefinition {
  const size = Buffer.byteLength(raw);
  if (size <= 0 || size > PLANNING_SCHEMA_MAX_BYTES) {
    throw new Error(`Planning schema must be 1-${PLANNING_SCHEMA_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Planning schema is not valid JSON.');
  }
  const record = object(value, 'planning schema');
  rejectUnknownFields(record, TOP_LEVEL_FIELDS, 'planning schema');
  if (record.schemaVersion !== PLANNING_SCHEMA_VERSION) {
    throw new Error(`Planning schema version must be ${PLANNING_SCHEMA_VERSION}.`);
  }
  if (record.kind !== PLANNING_SCHEMA_KIND) {
    throw new Error(`Planning schema kind must be "${PLANNING_SCHEMA_KIND}".`);
  }

  const profileIds = identifiers(record.profileIds, 'profileIds');
  if (!profileIds.includes(expectedProfileId)) {
    throw new Error('Planning schema profileIds must include its filename.');
  }
  const sections = parseSections(record.sections);
  const gates = parseGates(record.gates);
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    kind: PLANNING_SCHEMA_KIND,
    id: identifier(record.id, 'id'),
    label: text(record.label, 'label', MAX_LABEL_CHARS),
    description: text(record.description, 'description', MAX_DESCRIPTION_CHARS),
    profileIds,
    planningSkillIds: identifiers(record.planningSkillIds, 'planningSkillIds'),
    sections,
    gates,
    ...(record.decisionPolicy === undefined
      ? {}
      : { decisionPolicy: parseDecisionPolicy(record.decisionPolicy) }),
  };
}

function parseSections(value: unknown): PlanningSchemaSection[] {
  const sections = array(value, 'sections').map((item, index) => {
    const record = object(item, `sections[${index}]`);
    rejectUnknownFields(record, SECTION_FIELDS, `sections[${index}]`);
    return {
      id: identifier(record.id, `sections[${index}].id`),
      label: text(record.label, `sections[${index}].label`, MAX_LABEL_CHARS),
      description: text(
        record.description,
        `sections[${index}].description`,
        MAX_DESCRIPTION_CHARS,
      ),
      required: boolean(record.required, `sections[${index}].required`),
    };
  });
  assertUniqueIds(sections, 'sections');
  return sections;
}

function parseGates(value: unknown): PlanningSchemaGate[] {
  const gates = array(value, 'gates').map((item, index) => {
    const record = object(item, `gates[${index}]`);
    rejectUnknownFields(record, GATE_FIELDS, `gates[${index}]`);
    return {
      id: identifier(record.id, `gates[${index}].id`),
      label: text(record.label, `gates[${index}].label`, MAX_LABEL_CHARS),
      description: text(
        record.description,
        `gates[${index}].description`,
        MAX_DESCRIPTION_CHARS,
      ),
    };
  });
  assertUniqueIds(gates, 'gates');
  return gates;
}

function parseDecisionPolicy(value: unknown): PlanningSchemaDecisionPolicy {
  const record = object(value, 'decisionPolicy');
  rejectUnknownFields(record, DECISION_POLICY_FIELDS, 'decisionPolicy');
  return {
    skillId: identifier(record.skillId, 'decisionPolicy.skillId'),
    triggerIds: identifiers(record.triggerIds, 'decisionPolicy.triggerIds'),
  };
}

function identifiers(value: unknown, field: string): string[] {
  const values = array(value, field).map((item, index) =>
    identifier(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must not contain duplicates.`);
  }
  return values;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, MAX_ID_CHARS);
  if (!ID.test(result)) throw new Error(`${field} must be a kebab-case identifier.`);
  return result;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`${field} contains unsafe control characters.`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean.`);
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    throw new Error(`${field} must contain 1-${MAX_ITEMS} entries.`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${field} contains unknown field "${unknown}".`);
}

function assertUniqueIds(values: ReadonlyArray<{ id: string }>, field: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new Error(`${field} must not contain duplicate ids.`);
  }
}

function isContainedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
