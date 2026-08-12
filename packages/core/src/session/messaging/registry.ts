/**
 * ADR-034 filesystem registry for live same-machine session listeners.
 *
 * One private file belongs to one listener instance. Instance-specific files
 * let a crashed predecessor be reaped without an old close handler deleting a
 * replacement that happens to carry the same session key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_SESSION_PROTOCOL,
  type LocalSessionActivityState,
  type LocalSessionClientKind,
} from './contracts.js';
import { getLocalSessionRegistryDirectory, readPrivateJsonFile } from './identity.js';
import {
  optionalBoundedText,
  optionalBoundedTitle,
  requireDeviceId,
  requireSessionKey,
} from './validation.js';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';

const REGISTRY_FILE_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{24})\.json$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CLIENT_KINDS = new Set<LocalSessionClientKind>(['cli', 'desktop']);
const ACTIVITY_STATES = new Set<LocalSessionActivityState>(['idle', 'working', 'waiting']);

export interface LocalSessionRegistryEntry {
  version: 1;
  protocol: typeof LOCAL_SESSION_PROTOCOL;
  sessionKey: string;
  instanceId: string;
  deviceId: string;
  clientKind: LocalSessionClientKind;
  state: LocalSessionActivityState;
  pid: number;
  port: number;
  token: string;
  registeredAt: number;
  updatedAt: number;
  workspaceRoot?: string;
  title?: string;
}

export function newLocalSessionRegistryEntry(input: Omit<
  LocalSessionRegistryEntry,
  'version' | 'protocol' | 'instanceId' | 'token'
>): LocalSessionRegistryEntry {
  return validateRegistryEntry({
    ...input,
    version: 1,
    protocol: LOCAL_SESSION_PROTOCOL,
    instanceId: crypto.randomBytes(12).toString('hex'),
    token: crypto.randomBytes(32).toString('hex'),
  });
}

export function writeLocalSessionRegistryEntry(entry: LocalSessionRegistryEntry): void {
  const validated = validateRegistryEntry(entry);
  const filePath = registryFilePath(validated.sessionKey, validated.instanceId);
  writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}

export function listLocalSessionRegistryEntries(): LocalSessionRegistryEntry[] {
  const directory = getLocalSessionRegistryDirectory();
  const entries: LocalSessionRegistryEntry[] = [];
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = REGISTRY_FILE_PATTERN.exec(dirent.name);
    if (!match || !dirent.isFile()) continue;
    const filePath = path.join(directory, dirent.name);
    try {
      entries.push(readValidatedRegistryFile(filePath, match[1]!, match[2]!));
    } catch {
      // A dead process cannot repair a truncated or hand-edited registration.
      // Quarantine before deletion and validate the moved inode again. A
      // concurrent atomic writer may have replaced the malformed inode after
      // our failed read; in that case its valid inode is restored rather than
      // deleted by a stale path-based cleanup.
      const raced = reapMalformedRegistryFile(filePath, match[1]!, match[2]!);
      if (raced) entries.push(raced);
    }
  }
  return entries;
}

export function removeLocalSessionRegistryEntry(entry: LocalSessionRegistryEntry): boolean {
  const expected = validateRegistryEntry(entry);
  const filePath = registryFilePath(expected.sessionKey, expected.instanceId);
  let current: LocalSessionRegistryEntry;
  try {
    const value = readPrivateJsonFile(filePath);
    if (value === undefined) return false;
    current = validateRegistryEntry(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (current.token !== expected.token || current.instanceId !== expected.instanceId) return false;
  try {
    fs.rmSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function registryFilePath(sessionKey: string, instanceId: string): string {
  const key = requireSessionKey(sessionKey);
  if (!/^[a-f0-9]{24}$/.test(instanceId)) {
    throw new Error('Invalid local messaging listener instance id.');
  }
  return path.join(getLocalSessionRegistryDirectory(), `${sessionKeyHash(key)}.${instanceId}.json`);
}

function sessionKeyHash(sessionKey: string): string {
  return crypto.createHash('sha256').update(sessionKey).digest('hex');
}

function validateRegistryEntry(value: unknown): LocalSessionRegistryEntry {
  const entry = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<LocalSessionRegistryEntry>
    : {};
  const sessionKey = requireSessionKey(entry.sessionKey);
  if (entry.version !== 1 || entry.protocol !== LOCAL_SESSION_PROTOCOL ||
      typeof entry.instanceId !== 'string' || !/^[a-f0-9]{24}$/.test(entry.instanceId) ||
      typeof entry.token !== 'string' || !TOKEN_PATTERN.test(entry.token) ||
      !CLIENT_KINDS.has(entry.clientKind as LocalSessionClientKind) ||
      !ACTIVITY_STATES.has(entry.state as LocalSessionActivityState) ||
      !Number.isInteger(entry.pid) || (entry.pid as number) < 1 ||
      !Number.isInteger(entry.port) || (entry.port as number) < 1 || (entry.port as number) > 65_535 ||
      !Number.isFinite(entry.registeredAt) || (entry.registeredAt as number) < 0 ||
      !Number.isFinite(entry.updatedAt) || (entry.updatedAt as number) < (entry.registeredAt as number)) {
    throw new Error('Invalid local messaging registry entry.');
  }
  return {
    version: 1,
    protocol: LOCAL_SESSION_PROTOCOL,
    sessionKey,
    instanceId: entry.instanceId,
    token: entry.token,
    deviceId: requireDeviceId(entry.deviceId),
    clientKind: entry.clientKind as LocalSessionClientKind,
    state: entry.state as LocalSessionActivityState,
    pid: entry.pid as number,
    port: entry.port as number,
    registeredAt: entry.registeredAt as number,
    updatedAt: entry.updatedAt as number,
    ...(optionalBoundedText(entry.workspaceRoot, 4096) === undefined
      ? {} : { workspaceRoot: entry.workspaceRoot }),
    ...(optionalBoundedTitle(entry.title) === undefined ? {} : { title: entry.title }),
  };
}

function readValidatedRegistryFile(
  filePath: string,
  expectedSessionHash: string,
  expectedInstanceId: string,
): LocalSessionRegistryEntry {
  const entry = validateRegistryEntry(readPrivateJsonFile(filePath));
  if (sessionKeyHash(entry.sessionKey) !== expectedSessionHash || entry.instanceId !== expectedInstanceId) {
    throw new Error('Registry filename does not match its identity.');
  }
  return entry;
}

function reapMalformedRegistryFile(
  filePath: string,
  expectedSessionHash: string,
  expectedInstanceId: string,
): LocalSessionRegistryEntry | undefined {
  // A second read is the common atomic-replacement race guard and avoids even
  // a transient rename for a writer that committed between the first read and
  // this cleanup path.
  try {
    return readValidatedRegistryFile(filePath, expectedSessionHash, expectedInstanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  }

  const quarantine = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.reap`,
  );
  try {
    fs.renameSync(filePath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }

  let racedValidReplacement: LocalSessionRegistryEntry | undefined;
  try {
    racedValidReplacement = readValidatedRegistryFile(
      quarantine,
      expectedSessionHash,
      expectedInstanceId,
    );
  } catch {
    // The quarantined inode is still malformed and may be deleted below.
  }

  if (racedValidReplacement) {
    try {
      // linkSync has create-if-absent semantics: it restores this exact valid
      // inode without overwriting an even newer writer at the registry path.
      fs.linkSync(quarantine, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Keep the valid quarantine for forensic/manual recovery if this
        // filesystem cannot restore it safely.
        return undefined;
      }
    }
  }
  try { fs.rmSync(quarantine); } catch { /* another cleanup already completed */ }
  if (!racedValidReplacement) return undefined;
  try {
    return readValidatedRegistryFile(filePath, expectedSessionHash, expectedInstanceId);
  } catch {
    return undefined;
  }
}
