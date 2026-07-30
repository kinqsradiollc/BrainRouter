/**
 * Bounded JSON contract for workspace domain personas.
 *
 * Persona files influence model instructions but never grant model selection,
 * tools, access, delegation, or execution limits. Keeping this parser separate
 * from executable agent definitions preserves that trust boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareAsarRead, verifyAsarRead } from '../fs/boundedFileIdentity.js';
import { containsWorkspaceSecretMaterial } from './workspaceContentSafety.js';

export const PERSONA_SCHEMA_VERSION = 1 as const;
export const PERSONA_KIND = 'persona' as const;
export const PERSONA_DEFINITION_MAX_BYTES = 32 * 1024;

const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INSTRUCTIONS = 64;
const MAX_INSTRUCTION_CHARS = 2 * 1024;
const MAX_PRIORITIES = 16;
const MAX_PRIORITY_CHARS = 128;
const PERSONA_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PERSONA_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'displayName',
  'description',
  'instructions',
  'priorities',
]);

/** Executable orchestration roles cannot also become domain personas. */
export const RESERVED_ORCHESTRATION_ROLE_IDS: ReadonlySet<string> = new Set([
  'architect',
  'explorer',
  'fleet',
  'intake',
  'primary',
  'reviewer',
  'verifier',
  'worker',
]);

export interface PersonaDefinition {
  schemaVersion: typeof PERSONA_SCHEMA_VERSION;
  kind: typeof PERSONA_KIND;
  id: string;
  displayName: string;
  description: string;
  instructions: string[];
  priorities: string[];
}

/** Return regular JSON files from a bounded real directory without following links. */
export function listPersonaDefinitionFiles(
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
    if (!isContainedPath(resolvedDir, resolvedBoundary) || !isContainedPath(resolvedDir, resolvedContainment)) {
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

/** Read and validate one persona definition without following its final link. */
export function readPersonaDefinitionFile(
  filePath: string,
  boundaryRoot = path.dirname(filePath),
  containmentRoot = boundaryRoot,
): PersonaDefinition {
  const raw = readBoundedRegularFile(filePath, boundaryRoot, containmentRoot);
  return parsePersonaDefinition(raw, path.basename(filePath, '.json'));
}

/** Validate serialized JSON before a persona registry may use it. */
export function parsePersonaDefinition(raw: string, expectedId: string): PersonaDefinition {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength <= 0 || byteLength > PERSONA_DEFINITION_MAX_BYTES) {
    throw new Error(`Persona definition must be 1-${PERSONA_DEFINITION_MAX_BYTES} bytes.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Persona definition is not valid JSON.');
  }
  if (!isRecord(value)) throw new Error('Persona definition must be a JSON object.');

  const unknownFields = Object.keys(value).filter((field) => !PERSONA_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`Persona definition contains unknown fields: ${unknownFields.sort().join(', ')}.`);
  }
  if (value.schemaVersion !== PERSONA_SCHEMA_VERSION) {
    throw new Error(`Persona definition schemaVersion must be ${PERSONA_SCHEMA_VERSION}.`);
  }
  if (value.kind !== PERSONA_KIND) {
    throw new Error(`Persona definition kind must be "${PERSONA_KIND}".`);
  }

  const id = requiredString(value.id, 'id', MAX_NAME_CHARS);
  if (!PERSONA_ID.test(id) || id !== expectedId) {
    throw new Error('Persona definition id must be kebab-case and match its filename.');
  }
  if (RESERVED_ORCHESTRATION_ROLE_IDS.has(id)) {
    throw new Error('Persona definition id is reserved for an orchestration role.');
  }

  return {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    kind: PERSONA_KIND,
    id,
    displayName: requiredString(value.displayName, 'displayName', MAX_NAME_CHARS),
    description: requiredString(value.description, 'description', MAX_DESCRIPTION_CHARS),
    instructions: stringList(
      value.instructions,
      'instructions',
      1,
      MAX_INSTRUCTIONS,
      MAX_INSTRUCTION_CHARS,
    ),
    priorities: value.priorities === undefined
      ? []
      : stringList(value.priorities, 'priorities', 0, MAX_PRIORITIES, MAX_PRIORITY_CHARS),
  };
}

function readBoundedRegularFile(filePath: string, boundaryRoot: string, containmentRoot: string): string {
  let fd: number | undefined;
  try {
    const resolvedBoundary = path.resolve(boundaryRoot);
    const resolvedContainment = path.resolve(containmentRoot);
    const resolvedFile = path.resolve(filePath);
    if (!isContainedPath(resolvedFile, resolvedBoundary) || !isContainedPath(resolvedFile, resolvedContainment)) {
      throw new Error('Persona definition escaped its declared personas directory.');
    }
    rejectSymlinkSegments(resolvedBoundary, resolvedFile);
    const asarGuard = prepareAsarRead(resolvedFile, resolvedBoundary, resolvedContainment);

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(resolvedFile, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd);
    if (
      !openedStat.isFile() ||
      openedStat.size <= 0 ||
      openedStat.size > PERSONA_DEFINITION_MAX_BYTES
    ) {
      throw new Error(`Persona definition must be 1-${PERSONA_DEFINITION_MAX_BYTES} bytes.`);
    }

    if (asarGuard) {
      if (!verifyAsarRead(asarGuard, resolvedFile, openedStat)) {
        throw new Error('Persona definition changed while it was being opened.');
      }
    } else {
      const realBoundary = fs.realpathSync.native(resolvedBoundary);
      const realContainment = fs.realpathSync.native(resolvedContainment);
      const realFile = fs.realpathSync.native(resolvedFile);
      if (!isContainedPath(realFile, realBoundary) || !isContainedPath(realFile, realContainment)) {
        throw new Error('Persona definition escaped its declared personas directory.');
      }
      const pathStat = fs.statSync(realFile);
      if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        throw new Error('Persona definition changed while it was being opened.');
      }
    }

    const buffer = Buffer.allocUnsafe(PERSONA_DEFINITION_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0 || bytesRead > PERSONA_DEFINITION_MAX_BYTES) {
      throw new Error(`Persona definition must be 1-${PERSONA_DEFINITION_MAX_BYTES} bytes.`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Persona definition')) throw error;
    throw new Error('Persona definition is not a readable regular UTF-8 file.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isContainedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rejectSymlinkSegments(boundaryRoot: string, target: string): void {
  const relative = path.relative(boundaryRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Persona definition escaped its declared personas directory.');
  }
  let current = boundaryRoot;
  if (fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Persona definition path must not contain symbolic links.');
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Persona definition path must not contain symbolic links.');
    }
  }
}

function requiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw new Error(`Persona definition ${field} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    UNSAFE_CONTROL_CHARACTERS.test(normalized) ||
    containsWorkspaceSecretMaterial(normalized)
  ) {
    throw new Error(
      `Persona definition ${field} is empty, oversized, unsafe, or contains secret material.`,
    );
  }
  return normalized;
}

function stringList(
  value: unknown,
  field: string,
  minEntries: number,
  maxEntries: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value) || value.length < minEntries || value.length > maxEntries) {
    throw new Error(
      `Persona definition ${field} must contain ${minEntries}-${maxEntries} entries.`,
    );
  }
  const result: string[] = [];
  for (const entry of value) {
    const normalized = requiredString(entry, field, maxChars);
    if (!result.includes(normalized)) result.push(normalized);
  }
  if (result.length < minEntries) {
    throw new Error(`Persona definition ${field} must contain at least ${minEntries} unique entries.`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
