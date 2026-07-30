/**
 * P23-1 bounded JSON contract for profile-specific orchestration plans.
 *
 * Plan files choose eligible strategies, stage topology, reusable roles, and
 * skills, but they are never an authority source. This module is the single
 * strict, no-follow parser for that data boundary: every nested object rejects
 * unknown fields, every collection and string is bounded, every reference is
 * checked against an injected authoritative catalog, and every stage graph is
 * acyclic before a caller can use it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareAsarRead, verifyAsarRead } from '../../fs/boundedFileIdentity.js';
import { containsWorkspaceSecretMaterial } from '../../workspace/workspaceContentSafety.js';

export const ORCHESTRATION_PROFILE_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATION_PROFILE_KIND = 'orchestration-profile' as const;
export const ORCHESTRATION_PROFILE_MAX_BYTES = 64 * 1024;

const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_OBJECTIVE_CHARS = 2 * 1024;
const MAX_STRATEGIES = 16;
const MAX_SIGNALS = 16;
const MAX_STAGES = 32;
const MAX_REFERENCES = 32;
const MAX_REQUIRED_SECTIONS = 16;
const LIMIT_MAX_PARALLEL = 16;
const LIMIT_MAX_CHILDREN_PER_STAGE = 16;
const LIMIT_MAX_TOTAL_CHILDREN = 64;
const LIMIT_MAX_DEPTH = 4;
const LIMIT_MAX_RETRIES = 4;
const DEFINITION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'displayName',
  'defaultMode',
  'fallbackStrategyId',
  'rolePolicy',
  'limits',
  'strategies',
]);
const ROLE_POLICY_FIELDS = new Set(['availableRoles', 'disabledRoles']);
const LIMIT_FIELDS = new Set([
  'maxParallel',
  'maxStages',
  'maxChildrenPerStage',
  'maxTotalChildren',
  'maxDepth',
  'maxRetries',
]);
const STRATEGY_FIELDS = new Set(['id', 'description', 'activation', 'stages']);
const ACTIVATION_FIELDS = new Set(['signals', 'explicitOnly']);
const STAGE_FIELDS = new Set([
  'id',
  'executor',
  'after',
  'objective',
  'skillIds',
  'fanOut',
  'optional',
  'expectedOutput',
]);
const EXECUTOR_FIELDS = new Set(['kind', 'roleId']);
const FAN_OUT_FIELDS = new Set(['min', 'max']);
const EXPECTED_OUTPUT_FIELDS = new Set(['contractId', 'requiredSections']);

export type OrchestrationProfileMode = 'off' | 'explicit' | 'adaptive';

export interface OrchestrationProfileRoleReference {
  defaultAccess: 'read' | 'write' | 'shell';
  outputContract: {
    id: string;
    sectionAliases: ReadonlySet<string>;
  } | null;
}

export interface OrchestrationProfileReferenceCatalog {
  roles: ReadonlyMap<string, OrchestrationProfileRoleReference>;
  skillIds: ReadonlySet<string>;
  signalIds: ReadonlySet<string>;
}

export interface OrchestrationProfileRolePolicy {
  availableRoles: string[];
  disabledRoles: string[];
}

export interface OrchestrationProfileLimits {
  maxParallel: number;
  maxStages: number;
  maxChildrenPerStage: number;
  maxTotalChildren: number;
  maxDepth: number;
  maxRetries: number;
}

export type OrchestrationStageExecutor =
  | { kind: 'primary' }
  | { kind: 'role'; roleId: string };

export interface OrchestrationStageFanOut {
  min: number;
  max: number;
}

export interface OrchestrationStageExpectedOutput {
  contractId: string;
  requiredSections: string[];
}

export interface OrchestrationProfileStage {
  id: string;
  executor: OrchestrationStageExecutor;
  after: string[];
  objective: string;
  skillIds: string[];
  fanOut?: OrchestrationStageFanOut;
  optional: boolean;
  expectedOutput?: OrchestrationStageExpectedOutput;
}

export interface OrchestrationProfileStrategy {
  id: string;
  description: string;
  activation: {
    signals: string[];
    explicitOnly: boolean;
  };
  stages: OrchestrationProfileStage[];
}

export interface OrchestrationProfileDefinition {
  schemaVersion: typeof ORCHESTRATION_PROFILE_SCHEMA_VERSION;
  kind: typeof ORCHESTRATION_PROFILE_KIND;
  id: string;
  displayName: string;
  defaultMode: OrchestrationProfileMode;
  fallbackStrategyId: string;
  rolePolicy: OrchestrationProfileRolePolicy;
  limits: OrchestrationProfileLimits;
  strategies: OrchestrationProfileStrategy[];
}

/** Return regular JSON files from a bounded real directory without following links. */
export function listOrchestrationProfileDefinitionFiles(
  dir: string,
  boundaryRoot = dir,
  containmentRoot = boundaryRoot,
): string[] {
  let entries: fs.Dirent[];
  let resolvedDir: string;
  try {
    const resolvedBoundary = path.resolve(boundaryRoot);
    const resolvedContainment = path.resolve(containmentRoot);
    resolvedDir = path.resolve(dir);
    if (
      !isContainedPath(resolvedDir, resolvedBoundary) ||
      !isContainedPath(resolvedDir, resolvedContainment)
    ) {
      return [];
    }
    rejectSymlinkSegments(resolvedBoundary, resolvedDir);
    const stat = fs.lstatSync(resolvedDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .map((entry) => path.join(resolvedDir, entry.name))
    .sort();
}

/** Read and validate one orchestration profile without following its final link. */
export function readOrchestrationProfileDefinitionFile(
  filePath: string,
  references: OrchestrationProfileReferenceCatalog,
  boundaryRoot = path.dirname(filePath),
  containmentRoot = boundaryRoot,
): OrchestrationProfileDefinition {
  const raw = readBoundedRegularFile(filePath, boundaryRoot, containmentRoot);
  return parseOrchestrationProfileDefinition(raw, path.basename(filePath, '.json'), references);
}

/** Validate serialized JSON before a plan registry may trust or expose it. */
export function parseOrchestrationProfileDefinition(
  raw: string,
  expectedId: string,
  references: OrchestrationProfileReferenceCatalog,
): OrchestrationProfileDefinition {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength <= 0 || byteLength > ORCHESTRATION_PROFILE_MAX_BYTES) {
    throw new Error(
      `Orchestration profile definition must be 1-${ORCHESTRATION_PROFILE_MAX_BYTES} bytes.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Orchestration profile definition is not valid JSON.');
  }
  if (!isRecord(value)) {
    throw new Error('Orchestration profile definition must be a JSON object.');
  }
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, 'definition');

  if (value.schemaVersion !== ORCHESTRATION_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `Orchestration profile definition schemaVersion must be ${ORCHESTRATION_PROFILE_SCHEMA_VERSION}.`,
    );
  }
  if (value.kind !== ORCHESTRATION_PROFILE_KIND) {
    throw new Error(`Orchestration profile definition kind must be "${ORCHESTRATION_PROFILE_KIND}".`);
  }

  const id = identifier(value.id, 'id');
  if (id !== expectedId) {
    throw new Error('Orchestration profile definition id must match its filename.');
  }

  const rolePolicy = parseRolePolicy(value.rolePolicy, references);
  const limits = parseLimits(value.limits);
  const strategies = parseStrategies(value.strategies, rolePolicy, limits, references);
  const fallbackStrategyId = identifier(value.fallbackStrategyId, 'fallbackStrategyId');
  validateFallbackStrategy(fallbackStrategyId, strategies);

  return {
    schemaVersion: ORCHESTRATION_PROFILE_SCHEMA_VERSION,
    kind: ORCHESTRATION_PROFILE_KIND,
    id,
    displayName: requiredString(value.displayName, 'displayName', MAX_NAME_CHARS),
    defaultMode: oneOf(
      value.defaultMode,
      'defaultMode',
      ['off', 'explicit', 'adaptive'] as const,
    ),
    fallbackStrategyId,
    rolePolicy,
    limits,
    strategies,
  };
}

function parseRolePolicy(
  value: unknown,
  references: OrchestrationProfileReferenceCatalog,
): OrchestrationProfileRolePolicy {
  const record = requiredRecord(value, 'rolePolicy');
  rejectUnknownFields(record, ROLE_POLICY_FIELDS, 'rolePolicy');
  const availableRoles = identifierList(
    record.availableRoles,
    'rolePolicy.availableRoles',
    MAX_REFERENCES,
  );
  const disabledRoles = identifierList(
    record.disabledRoles,
    'rolePolicy.disabledRoles',
    MAX_REFERENCES,
  );
  const overlap = availableRoles.filter((roleId) => disabledRoles.includes(roleId));
  if (overlap.length > 0) {
    throw new Error(
      `Orchestration profile definition rolePolicy has roles both available and disabled: ${overlap.join(', ')}.`,
    );
  }
  const roleIds = new Set(references.roles.keys());
  assertKnownReferences(availableRoles, roleIds, 'rolePolicy.availableRoles');
  assertKnownReferences(disabledRoles, roleIds, 'rolePolicy.disabledRoles');
  return { availableRoles, disabledRoles };
}

function parseLimits(value: unknown): OrchestrationProfileLimits {
  const record = requiredRecord(value, 'limits');
  rejectUnknownFields(record, LIMIT_FIELDS, 'limits');
  return {
    maxParallel: boundedInteger(record.maxParallel, 'limits.maxParallel', 1, LIMIT_MAX_PARALLEL),
    maxStages: boundedInteger(record.maxStages, 'limits.maxStages', 1, MAX_STAGES),
    maxChildrenPerStage: boundedInteger(
      record.maxChildrenPerStage,
      'limits.maxChildrenPerStage',
      1,
      LIMIT_MAX_CHILDREN_PER_STAGE,
    ),
    maxTotalChildren: boundedInteger(
      record.maxTotalChildren,
      'limits.maxTotalChildren',
      1,
      LIMIT_MAX_TOTAL_CHILDREN,
    ),
    maxDepth: boundedInteger(record.maxDepth, 'limits.maxDepth', 1, LIMIT_MAX_DEPTH),
    maxRetries: boundedInteger(record.maxRetries, 'limits.maxRetries', 0, LIMIT_MAX_RETRIES),
  };
}

function parseStrategies(
  value: unknown,
  rolePolicy: OrchestrationProfileRolePolicy,
  limits: OrchestrationProfileLimits,
  references: OrchestrationProfileReferenceCatalog,
): OrchestrationProfileStrategy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STRATEGIES) {
    throw new Error(
      `Orchestration profile definition strategies must contain 1-${MAX_STRATEGIES} entries.`,
    );
  }

  const strategies = value.map((entry, index) => {
    const record = requiredRecord(entry, `strategies[${index}]`);
    rejectUnknownFields(record, STRATEGY_FIELDS, `strategies[${index}]`);
    const strategyId = identifier(record.id, `strategies[${index}].id`);
    const activation = requiredRecord(record.activation, `strategy ${strategyId} activation`);
    rejectUnknownFields(activation, ACTIVATION_FIELDS, `strategy ${strategyId} activation`);
    const signals = identifierList(
      activation.signals,
      `strategy ${strategyId} activation.signals`,
      MAX_SIGNALS,
    );
    assertKnownReferences(
      signals,
      references.signalIds,
      `strategy ${strategyId} activation.signals`,
    );
    if (typeof activation.explicitOnly !== 'boolean') {
      throw new Error(
        `Orchestration profile definition strategy ${strategyId} activation.explicitOnly must be a boolean.`,
      );
    }

    return {
      id: strategyId,
      description: requiredString(
        record.description,
        `strategy ${strategyId} description`,
        MAX_DESCRIPTION_CHARS,
      ),
      activation: { signals, explicitOnly: activation.explicitOnly },
      stages: parseStages(record.stages, strategyId, rolePolicy, limits, references),
    };
  });

  assertUnique(strategies.map((strategy) => strategy.id), 'strategy ids');
  return strategies;
}

function parseStages(
  value: unknown,
  strategyId: string,
  rolePolicy: OrchestrationProfileRolePolicy,
  limits: OrchestrationProfileLimits,
  references: OrchestrationProfileReferenceCatalog,
): OrchestrationProfileStage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxStages) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stages must contain 1-${limits.maxStages} entries.`,
    );
  }

  const stages = value.map((entry, index) => {
    const record = requiredRecord(entry, `strategy ${strategyId} stages[${index}]`);
    rejectUnknownFields(record, STAGE_FIELDS, `strategy ${strategyId} stages[${index}]`);
    const stageId = identifier(record.id, `strategy ${strategyId} stages[${index}].id`);
    if (typeof record.optional !== 'boolean') {
      throw new Error(
        `Orchestration profile definition strategy ${strategyId} stage ${stageId} optional must be a boolean.`,
      );
    }

    const executor = parseExecutor(record.executor, strategyId, stageId, rolePolicy);
    const stage: OrchestrationProfileStage = {
      id: stageId,
      executor,
      after: identifierList(
        record.after,
        `strategy ${strategyId} stage ${stageId} after`,
        MAX_REFERENCES,
      ),
      objective: requiredString(
        record.objective,
        `strategy ${strategyId} stage ${stageId} objective`,
        MAX_OBJECTIVE_CHARS,
      ),
      skillIds: identifierList(
        record.skillIds,
        `strategy ${strategyId} stage ${stageId} skillIds`,
        MAX_REFERENCES,
      ),
      optional: record.optional,
    };
    assertKnownReferences(
      stage.skillIds,
      references.skillIds,
      `strategy ${strategyId} stage ${stageId} skillIds`,
    );

    if (record.fanOut !== undefined) {
      stage.fanOut = parseFanOut(
        record.fanOut,
        strategyId,
        stageId,
        executor,
        limits,
        references,
      );
    }
    if (executor.kind === 'primary') {
      if (record.expectedOutput !== undefined) {
        throw new Error(
          `Orchestration profile definition strategy ${strategyId} stage ${stageId} primary executor cannot declare expectedOutput.`,
        );
      }
    } else {
      const role = references.roles.get(executor.roleId);
      if (!role?.outputContract) {
        throw new Error(
          `Orchestration profile definition strategy ${strategyId} stage ${stageId} role ${executor.roleId} has no registered output contract.`,
        );
      }
      if (record.expectedOutput === undefined) {
        throw new Error(
          `Orchestration profile definition strategy ${strategyId} stage ${stageId} role executor must declare expectedOutput.`,
        );
      }
      stage.expectedOutput = parseExpectedOutput(
        record.expectedOutput,
        strategyId,
        stageId,
        executor.roleId,
        role.outputContract,
      );
    }
    return stage;
  });

  assertUnique(stages.map((stage) => stage.id), `strategy ${strategyId} stage ids`);
  validateStageGraph(stages, strategyId);
  const maximumChildren = stages.reduce((sum, stage) => {
    if (stage.executor.kind === 'primary') return sum;
    return sum + (stage.fanOut?.max ?? 1);
  }, 0);
  if (maximumChildren > limits.maxTotalChildren) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} can create ${maximumChildren} children, exceeding limits.maxTotalChildren ${limits.maxTotalChildren}.`,
    );
  }
  return stages;
}

function parseExecutor(
  value: unknown,
  strategyId: string,
  stageId: string,
  rolePolicy: OrchestrationProfileRolePolicy,
): OrchestrationStageExecutor {
  const record = requiredRecord(value, `strategy ${strategyId} stage ${stageId} executor`);
  rejectUnknownFields(record, EXECUTOR_FIELDS, `strategy ${strategyId} stage ${stageId} executor`);
  if (record.kind === 'primary') {
    if (record.roleId !== undefined) {
      throw new Error(
        `Orchestration profile definition strategy ${strategyId} stage ${stageId} primary executor must not name roleId.`,
      );
    }
    return { kind: 'primary' };
  }
  if (record.kind !== 'role') {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} executor kind must be primary or role.`,
    );
  }
  const roleId = identifier(record.roleId, `strategy ${strategyId} stage ${stageId} executor.roleId`);
  if (
    !rolePolicy.availableRoles.includes(roleId) ||
    rolePolicy.disabledRoles.includes(roleId)
  ) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} role ${roleId} is not available under rolePolicy.`,
    );
  }
  return { kind: 'role', roleId };
}

function parseFanOut(
  value: unknown,
  strategyId: string,
  stageId: string,
  executor: OrchestrationStageExecutor,
  limits: OrchestrationProfileLimits,
  references: OrchestrationProfileReferenceCatalog,
): OrchestrationStageFanOut {
  const record = requiredRecord(value, `strategy ${strategyId} stage ${stageId} fanOut`);
  rejectUnknownFields(record, FAN_OUT_FIELDS, `strategy ${strategyId} stage ${stageId} fanOut`);
  if (executor.kind === 'primary') {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} primary executor cannot fan out.`,
    );
  }
  const min = boundedInteger(
    record.min,
    `strategy ${strategyId} stage ${stageId} fanOut.min`,
    1,
    limits.maxChildrenPerStage,
  );
  const max = boundedInteger(
    record.max,
    `strategy ${strategyId} stage ${stageId} fanOut.max`,
    1,
    limits.maxChildrenPerStage,
  );
  if (min > max) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} fanOut.min must not exceed fanOut.max.`,
    );
  }
  if (
    executor.kind === 'role' &&
    references.roles.get(executor.roleId)?.defaultAccess !== 'read' &&
    max > 1
  ) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} write-capable role fanOut.max must be 1 without enforced execution isolation.`,
    );
  }
  return { min, max };
}

function parseExpectedOutput(
  value: unknown,
  strategyId: string,
  stageId: string,
  roleId: string,
  roleContract: NonNullable<OrchestrationProfileRoleReference['outputContract']>,
): OrchestrationStageExpectedOutput {
  const record = requiredRecord(
    value,
    `strategy ${strategyId} stage ${stageId} expectedOutput`,
  );
  rejectUnknownFields(
    record,
    EXPECTED_OUTPUT_FIELDS,
    `strategy ${strategyId} stage ${stageId} expectedOutput`,
  );
  const contractId = identifier(
    record.contractId,
    `strategy ${strategyId} stage ${stageId} expectedOutput.contractId`,
  );
  if (contractId !== roleContract.id) {
    throw new Error(
      `Orchestration profile definition strategy ${strategyId} stage ${stageId} expectedOutput.contractId must use role ${roleId} contract ${roleContract.id}.`,
    );
  }
  const requiredSections = identifierList(
    record.requiredSections,
    `strategy ${strategyId} stage ${stageId} expectedOutput.requiredSections`,
    MAX_REQUIRED_SECTIONS,
  );
  assertKnownReferences(
    requiredSections,
    roleContract.sectionAliases,
    `strategy ${strategyId} stage ${stageId} expectedOutput.requiredSections`,
  );
  return {
    contractId,
    requiredSections,
  };
}

function validateFallbackStrategy(
  fallbackStrategyId: string,
  strategies: readonly OrchestrationProfileStrategy[],
): void {
  const fallback = strategies.find((strategy) => strategy.id === fallbackStrategyId);
  if (!fallback) {
    throw new Error(
      `Orchestration profile definition fallbackStrategyId references unknown strategy ${fallbackStrategyId}.`,
    );
  }
  for (const stage of fallback.stages) {
    if (stage.executor.kind !== 'primary') {
      throw new Error(
        `Orchestration profile definition fallback strategy ${fallbackStrategyId} must contain only primary executors.`,
      );
    }
    if (stage.fanOut !== undefined) {
      throw new Error(
        `Orchestration profile definition fallback strategy ${fallbackStrategyId} must not fan out.`,
      );
    }
    if (stage.skillIds.length > 0) {
      throw new Error(
        `Orchestration profile definition fallback strategy ${fallbackStrategyId} must not require skills.`,
      );
    }
  }
}

function validateStageGraph(stages: readonly OrchestrationProfileStage[], strategyId: string): void {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    for (const dependencyId of stage.after) {
      if (!byId.has(dependencyId)) {
        throw new Error(
          `Orchestration profile definition strategy ${strategyId} stage ${stage.id} references unknown dependency ${dependencyId}.`,
        );
      }
      if (dependencyId === stage.id) {
        throw new Error(
          `Orchestration profile definition strategy ${strategyId} stage ${stage.id} cannot depend on itself.`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stageId: string): void => {
    if (visiting.has(stageId)) {
      throw new Error(
        `Orchestration profile definition strategy ${strategyId} stage graph must be acyclic.`,
      );
    }
    if (visited.has(stageId)) return;
    visiting.add(stageId);
    for (const dependencyId of byId.get(stageId)?.after ?? []) visit(dependencyId);
    visiting.delete(stageId);
    visited.add(stageId);
  };
  for (const stage of stages) visit(stage.id);
}

function readBoundedRegularFile(
  filePath: string,
  boundaryRoot: string,
  containmentRoot: string,
): string {
  let fd: number | undefined;
  try {
    const resolvedBoundary = path.resolve(boundaryRoot);
    const resolvedContainment = path.resolve(containmentRoot);
    const resolvedFile = path.resolve(filePath);
    if (
      !isContainedPath(resolvedFile, resolvedBoundary) ||
      !isContainedPath(resolvedFile, resolvedContainment)
    ) {
      throw new Error(
        'Orchestration profile definition escaped its declared orchestration-profiles directory.',
      );
    }
    rejectSymlinkSegments(resolvedBoundary, resolvedFile);
    const asarGuard = prepareAsarRead(resolvedFile, resolvedBoundary, resolvedContainment);

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(resolvedFile, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd);
    if (
      !openedStat.isFile() ||
      openedStat.size <= 0 ||
      openedStat.size > ORCHESTRATION_PROFILE_MAX_BYTES
    ) {
      throw new Error(
        `Orchestration profile definition must be 1-${ORCHESTRATION_PROFILE_MAX_BYTES} bytes.`,
      );
    }

    if (asarGuard) {
      if (!verifyAsarRead(asarGuard, resolvedFile, openedStat)) {
        throw new Error('Orchestration profile definition changed while it was being opened.');
      }
    } else {
      const realBoundary = fs.realpathSync.native(resolvedBoundary);
      const realContainment = fs.realpathSync.native(resolvedContainment);
      const realFile = fs.realpathSync.native(resolvedFile);
      if (
        !isContainedPath(realFile, realBoundary) ||
        !isContainedPath(realFile, realContainment)
      ) {
        throw new Error(
          'Orchestration profile definition escaped its declared orchestration-profiles directory.',
        );
      }
      const pathStat = fs.statSync(realFile);
      if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        throw new Error('Orchestration profile definition changed while it was being opened.');
      }
    }

    const buffer = Buffer.allocUnsafe(ORCHESTRATION_PROFILE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > ORCHESTRATION_PROFILE_MAX_BYTES) {
      throw new Error(
        `Orchestration profile definition must be 1-${ORCHESTRATION_PROFILE_MAX_BYTES} bytes.`,
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Orchestration profile definition')
    ) {
      throw error;
    }
    throw new Error(
      'Orchestration profile definition is not a readable regular UTF-8 file.',
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Orchestration profile definition ${field} must be an object.`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Orchestration profile definition ${field} contains unknown fields: ${unknown.join(', ')}.`,
    );
  }
}

function requiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Orchestration profile definition ${field} must be a string.`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    UNSAFE_CONTROL_CHARACTERS.test(normalized) ||
    containsWorkspaceSecretMaterial(normalized)
  ) {
    throw new Error(
      `Orchestration profile definition ${field} is empty, oversized, unsafe, or contains secret material.`,
    );
  }
  return normalized;
}

function identifier(value: unknown, field: string): string {
  const normalized = requiredString(value, field, MAX_NAME_CHARS);
  if (!DEFINITION_ID.test(normalized)) {
    throw new Error(`Orchestration profile definition ${field} must be kebab-case.`);
  }
  return normalized;
}

function identifierList(value: unknown, field: string, maxEntries: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new Error(
      `Orchestration profile definition ${field} must be an array with at most ${maxEntries} entries.`,
    );
  }
  const result = value.map((entry) => identifier(entry, field));
  assertUnique(result, field);
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `Orchestration profile definition ${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(
      `Orchestration profile definition ${field} must be one of: ${allowed.join(', ')}.`,
    );
  }
  return value as T[number];
}

function assertKnownReferences(
  values: readonly string[],
  known: ReadonlySet<string>,
  field: string,
): void {
  const unknown = values.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `Orchestration profile definition ${field} contains unknown references: ${unknown.join(', ')}.`,
    );
  }
}

function assertUnique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Orchestration profile definition ${field} contains duplicate ids: ${[...duplicates].sort().join(', ')}.`,
    );
  }
}

function isContainedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rejectSymlinkSegments(boundaryRoot: string, target: string): void {
  const relative = path.relative(boundaryRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'Orchestration profile definition escaped its declared orchestration-profiles directory.',
    );
  }
  let current = boundaryRoot;
  if (fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Orchestration profile definition path must not contain symbolic links.');
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Orchestration profile definition path must not contain symbolic links.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
