/**
 * W4b executable agent-definition file contract.
 *
 * JSON definitions can originate in a project, user home, or enabled pack and
 * become model-visible delegate tools plus child execution policy. This module
 * is therefore the single bounded, no-follow parser for that trust boundary;
 * callers receive a complete validated definition or an error, never a partial
 * object cast from untrusted JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareAsarRead, verifyAsarRead } from '../../fs/boundedFileIdentity.js';

export type Tier = 'chat' | 'reasoning' | 'worker';
export type AccessMode = 'read' | 'write' | 'shell';
export const AGENT_DEFINITION_SCHEMA_VERSION = 1 as const;
export const AGENT_DEFINITION_KIND = 'orchestration-role' as const;

export interface AgentDefinition {
  schemaVersion: typeof AGENT_DEFINITION_SCHEMA_VERSION;
  kind: typeof AGENT_DEFINITION_KIND;
  id: string;
  displayName: string;
  whenToUse: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  defaultAccess: AccessMode;
  toolScope: { local: string[]; mcp: string[] };
  disallowedTools: string[];
  /** Default ownership glob applied when the spawner omits one. */
  ownership?: string | null;
  maxIterations: number;
  timeoutMs: number;
  maxResultChars: number;
  subagents: string[];
  delegateName: string;
  tier: Tier;
  outputContract: unknown;
}

export const AGENT_DEFINITION_MAX_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 32 * 1024;
const MAX_SHORT_TEXT_CHARS = 2 * 1024;
const MAX_NAME_CHARS = 128;
const MAX_MODEL_CHARS = 256;
const MAX_TOOL_ENTRIES = 256;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_SUBAGENTS = 64;
const MAX_ITERATIONS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_RESULT_CHARS = 1_000_000;
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DELEGATE_NAME = /^delegate_[a-z0-9_]+$/;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const AGENT_DEFINITION_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'displayName',
  'whenToUse',
  'prompt',
  'model',
  'effort',
  'defaultAccess',
  'toolScope',
  'disallowedTools',
  'ownership',
  'maxIterations',
  'timeoutMs',
  'maxResultChars',
  'subagents',
  'delegateName',
  'tier',
  'outputContract',
]);
const PERSONA_ONLY_FIELDS = new Set(['description', 'instructions', 'priorities']);

/** Return regular JSON files from a bounded real directory without following links. */
export function listAgentDefinitionFiles(
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
    const relativeDir = path.relative(resolvedBoundary, resolvedDir);
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return [];
    const containedDir = path.relative(resolvedContainment, resolvedDir);
    if (containedDir.startsWith('..') || path.isAbsolute(containedDir)) return [];
    let current = resolvedBoundary;
    for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return [];
    }
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

/** Read and validate one executable definition without following its final link. */
export function readAgentDefinitionFile(
  filePath: string,
  boundaryRoot = path.dirname(filePath),
  containmentRoot = boundaryRoot,
): AgentDefinition {
  const raw = readBoundedRegularFile(filePath, boundaryRoot, containmentRoot);
  return parseAgentDefinition(raw, path.basename(filePath, '.json'));
}

/** Validate serialized JSON before either a writer or registry may trust it. */
export function parseAgentDefinition(raw: string, expectedId: string): AgentDefinition {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength <= 0 || byteLength > AGENT_DEFINITION_MAX_BYTES) {
    throw new Error(`Agent definition must be 1-${AGENT_DEFINITION_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Agent definition is not valid JSON.');
  }
  if (!isRecord(value)) throw new Error('Agent definition must be a JSON object.');

  const personaFields = Object.keys(value).filter((field) => PERSONA_ONLY_FIELDS.has(field));
  if (personaFields.length > 0) {
    throw new Error(
      `Agent definition contains persona-only fields: ${personaFields.sort().join(', ')}.`,
    );
  }
  const unknownFields = Object.keys(value).filter((field) => !AGENT_DEFINITION_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`Agent definition contains unknown fields: ${unknownFields.sort().join(', ')}.`);
  }

  // Definitions created before the discriminator shipped remain readable
  // during the compatibility window and normalize to the current contract.
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION
  ) {
    throw new Error(
      `Agent definition schemaVersion must be ${AGENT_DEFINITION_SCHEMA_VERSION}.`,
    );
  }
  if (value.kind !== undefined && value.kind !== AGENT_DEFINITION_KIND) {
    throw new Error(`Agent definition kind must be "${AGENT_DEFINITION_KIND}".`);
  }

  const id = requiredString(value.id, 'id', MAX_NAME_CHARS);
  if (!AGENT_ID.test(id) || id !== expectedId) {
    throw new Error('Agent definition id must be kebab-case and match its filename.');
  }

  const displayName = requiredString(value.displayName, 'displayName', MAX_NAME_CHARS);
  const whenToUse = requiredString(value.whenToUse, 'whenToUse', MAX_SHORT_TEXT_CHARS);
  const prompt = requiredString(value.prompt, 'prompt', MAX_PROMPT_CHARS);
  const model = nullableString(value.model, 'model', MAX_MODEL_CHARS);
  const effort = nullableString(value.effort, 'effort', MAX_NAME_CHARS);
  const defaultAccess = oneOf(value.defaultAccess, 'defaultAccess', ['read', 'write', 'shell'] as const);
  const tier = oneOf(value.tier, 'tier', ['chat', 'reasoning', 'worker'] as const);

  if (!isRecord(value.toolScope)) throw new Error('Agent definition toolScope must be an object.');
  const local = stringList(value.toolScope.local, 'toolScope.local', MAX_TOOL_ENTRIES, MAX_TOOL_NAME_CHARS);
  const mcp = stringList(value.toolScope.mcp, 'toolScope.mcp', MAX_TOOL_ENTRIES, MAX_TOOL_NAME_CHARS);
  const disallowedTools = stringList(
    value.disallowedTools,
    'disallowedTools',
    MAX_TOOL_ENTRIES,
    MAX_TOOL_NAME_CHARS,
  );
  const granted = new Set([...local, ...mcp]);
  if (disallowedTools.some((tool) => granted.has(tool))) {
    throw new Error('Agent definition disallowedTools must not overlap toolScope.');
  }

  const ownership = value.ownership === undefined || value.ownership === null
    ? value.ownership as undefined | null
    : requiredString(value.ownership, 'ownership', MAX_SHORT_TEXT_CHARS);
  const maxIterations = boundedInteger(value.maxIterations, 'maxIterations', MAX_ITERATIONS);
  const timeoutMs = boundedInteger(value.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  const maxResultChars = boundedInteger(value.maxResultChars, 'maxResultChars', MAX_RESULT_CHARS);
  const subagents = stringList(value.subagents, 'subagents', MAX_SUBAGENTS, MAX_NAME_CHARS);
  if (subagents.some((agentId) => !AGENT_ID.test(agentId))) {
    throw new Error('Agent definition subagents must contain kebab-case agent ids.');
  }

  // Definitions written by older CLI versions used the raw id here, which
  // produced a model tool that the orchestration dispatcher could not route.
  // Normalize that exact legacy shape while rejecting arbitrary tool names.
  const rawDelegateName = requiredString(value.delegateName, 'delegateName', MAX_NAME_CHARS);
  const delegateName = rawDelegateName === id ? `delegate_${id.replaceAll('-', '_')}` : rawDelegateName;
  if (!DELEGATE_NAME.test(delegateName)) {
    throw new Error('Agent definition delegateName must use the delegate_<name> form.');
  }

  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    kind: AGENT_DEFINITION_KIND,
    id,
    displayName,
    whenToUse,
    prompt,
    model,
    effort,
    defaultAccess,
    toolScope: { local, mcp },
    disallowedTools,
    ...(ownership !== undefined ? { ownership } : {}),
    maxIterations,
    timeoutMs,
    maxResultChars,
    subagents,
    delegateName,
    tier,
    outputContract: value.outputContract ?? null,
  };
}

function readBoundedRegularFile(filePath: string, boundaryRoot: string, containmentRoot: string): string {
  let fd: number | undefined;
  try {
    const asarGuard = prepareAsarRead(filePath, boundaryRoot, containmentRoot);

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > AGENT_DEFINITION_MAX_BYTES) {
      throw new Error(`Agent definition must be 1-${AGENT_DEFINITION_MAX_BYTES} bytes.`);
    }

    if (asarGuard) {
      // ASAR entries are immutable virtual files. Electron does not preserve
      // entry inode identity between open/fstat/stat, so bind the read to the
      // containing archive snapshot instead. Lexical containment was checked
      // above, discovery rejected entry links, and an archive swap fails closed.
      if (!verifyAsarRead(asarGuard, filePath, stat)) {
        throw new Error('Agent definition escaped its declared agents directory.');
      }
    } else {
      // Re-bind the opened descriptor to its current real path. The earlier
      // directory walk rejects links during discovery; this inode comparison
      // also closes an ancestor-swap race between discovery and open.
      const realBoundary = fs.realpathSync.native(boundaryRoot);
      const realContainment = fs.realpathSync.native(containmentRoot);
      const realFile = fs.realpathSync.native(filePath);
      const relativeBoundary = path.relative(realBoundary, realFile);
      const relativeContainment = path.relative(realContainment, realFile);
      const pathStat = fs.statSync(realFile);
      if (
        relativeBoundary.startsWith('..') ||
        path.isAbsolute(relativeBoundary) ||
        relativeContainment.startsWith('..') ||
        path.isAbsolute(relativeContainment) ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino
      ) {
        throw new Error('Agent definition escaped its declared agents directory.');
      }
    }

    // Do not trust the pre-read stat size: a concurrently modified file must
    // still be unable to make this trust boundary allocate or read unboundedly.
    const buffer = Buffer.allocUnsafe(AGENT_DEFINITION_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > AGENT_DEFINITION_MAX_BYTES) {
      throw new Error(`Agent definition must be 1-${AGENT_DEFINITION_MAX_BYTES} bytes.`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Agent definition')) throw err;
    throw new Error('Agent definition is not a readable regular UTF-8 file.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw new Error(`Agent definition ${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars || UNSAFE_CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`Agent definition ${field} is empty, oversized, or contains control characters.`);
  }
  return normalized;
}

function nullableString(value: unknown, field: string, maxChars: number): string | null {
  if (value === null) return null;
  return requiredString(value, field, maxChars);
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`Agent definition ${field} must be an integer between 1 and ${max}.`);
  }
  return value as number;
}

function stringList(value: unknown, field: string, maxEntries: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new Error(`Agent definition ${field} must be an array with at most ${maxEntries} entries.`);
  }
  const result: string[] = [];
  for (const entry of value) {
    const normalized = requiredString(entry, field, maxChars);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function oneOf<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Agent definition ${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
