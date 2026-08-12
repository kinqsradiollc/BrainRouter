/**
 * ADR-034 stable same-machine identity and private storage roots.
 *
 * Every local host process shares one persisted device id under the
 * BrainRouter home. Invalid persisted identity fails closed: silently minting
 * a replacement would make one physical machine look like a different peer.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../../storage/store.js';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';
import { requireDeviceId, requireSessionKey } from './validation.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IDENTITY_FILE_NAME = 'device.json';

interface LocalMessagingIdentityFile {
  version: 1;
  deviceId: string;
}

export function getLocalMessagingRoot(): string {
  return ensurePrivateDirectory(path.join(getBrainrouterHome(), 'session-messaging'));
}

export function getLocalSessionRegistryDirectory(): string {
  return ensurePrivateDirectory(path.join(getLocalMessagingRoot(), 'registry'));
}

export function getLocalMessagingDeviceId(): string {
  const identityPath = path.join(getLocalMessagingRoot(), IDENTITY_FILE_NAME);
  const existing = readPrivateJsonFile(identityPath);
  if (existing !== undefined) return parseDeviceId(existing);

  const deviceId = crypto.randomUUID();
  const identity: LocalMessagingIdentityFile = { version: 1, deviceId };
  try {
    writeFileAtomic(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
      exclusive: true,
    });
    return deviceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = readPrivateJsonFile(identityPath);
    if (raced === undefined) throw error;
    return parseDeviceId(raced);
  }
}

/**
 * Compatibility-only display identity for remote rows written before an
 * installation id was recorded. It is deterministic and UUID-shaped so old
 * rows pass the shared envelope validator, but it is never account authority.
 */
export function deriveLegacyRemoteDeviceId(sessionKey: string): string {
  const key = requireSessionKey(sessionKey);
  const bytes = Buffer.from(crypto.createHash('sha256')
    .update('brainrouter:legacy-remote-device:')
    .update(key)
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return requireDeviceId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function readPrivateJsonFile(filePath: string, maxBytes = 64 * 1024): unknown | undefined {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > maxBytes) {
    throw new Error(`Unsafe local messaging file: ${filePath}`);
  }
  enforcePrivateFileMode(filePath);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new Error(`Local messaging file changed while opening: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid local messaging JSON file: ${filePath}`);
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe local messaging directory: ${directory}`);
  }
  enforceMode(directory, PRIVATE_DIRECTORY_MODE);
  return fs.realpathSync(directory);
}

function enforcePrivateFileMode(filePath: string): void {
  enforceMode(filePath, PRIVATE_FILE_MODE);
}

function enforceMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  if (process.platform !== 'win32' && (fs.statSync(target).mode & 0o777) !== mode) {
    throw new Error(`Local messaging path is not private: ${target}`);
  }
}

function parseDeviceId(value: unknown): string {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<LocalMessagingIdentityFile>
    : {};
  if (record.version !== 1) {
    throw new Error('Persisted local messaging device identity is invalid.');
  }
  try {
    return requireDeviceId(record.deviceId);
  } catch {
    throw new Error('Persisted local messaging device identity is invalid.');
  }
}
