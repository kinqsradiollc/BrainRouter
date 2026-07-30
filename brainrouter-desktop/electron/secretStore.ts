/**
 * Host-only secret storage (connector Phase 2/3). Values are encrypted with
 * Electron `safeStorage` (macOS Keychain / Windows Credential Manager / Linux
 * libsecret) and persisted as base64 blobs in `<userData>/secrets.json` —
 * the OS keychain holds the encryption key, the file holds only ciphertext.
 *
 * When the platform has no encryption backend (some Linux setups, headless),
 * we still store the value but mark it `plain` and surface that through
 * `secretStorageMode()` so the UI can warn — refusing to store at all would
 * just push users back to plaintext config.json, which is strictly worse.
 *
 * Renderer never touches this module: everything goes through host endpoints,
 * and no endpoint ever RETURNS a secret value — only presence/metadata.
 */
import fs from 'node:fs';
import path from 'node:path';

interface SecretRecord {
  /** base64 ciphertext (or plaintext utf8-base64 when `plain`). */
  value: string;
  plain?: boolean;
  updatedAt: string;
}

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

let safeStorageImpl: SafeStorageLike | null | undefined;
function safeStorage(): SafeStorageLike | null {
  if (safeStorageImpl !== undefined) return safeStorageImpl;
  try {
    // Lazy: this module is imported by host tests that run outside Electron.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    safeStorageImpl = (require('electron') as { safeStorage?: SafeStorageLike }).safeStorage ?? null;
  } catch {
    safeStorageImpl = null;
  }
  return safeStorageImpl;
}

/** Test hook — inject a fake safeStorage (or null to simulate no backend). */
export function _setSafeStorageForTests(impl: SafeStorageLike | null): void {
  safeStorageImpl = impl;
}

function secretsFile(userDataDir: string): string {
  return path.join(userDataDir, 'secrets.json');
}

function readAll(userDataDir: string): Record<string, SecretRecord> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(userDataDir), 'utf-8')) as Record<string, SecretRecord>;
  } catch {
    return {};
  }
}

function writeAll(userDataDir: string, all: Record<string, SecretRecord>): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(secretsFile(userDataDir), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function secretStorageMode(): 'keychain' | 'plain' {
  const ss = safeStorage();
  return ss?.isEncryptionAvailable() ? 'keychain' : 'plain';
}

export function setSecret(userDataDir: string, key: string, value: string): { mode: 'keychain' | 'plain' } {
  const ss = safeStorage();
  const all = readAll(userDataDir);
  if (ss?.isEncryptionAvailable()) {
    all[key] = { value: ss.encryptString(value).toString('base64'), updatedAt: new Date().toISOString() };
    writeAll(userDataDir, all);
    return { mode: 'keychain' };
  }
  all[key] = { value: Buffer.from(value, 'utf-8').toString('base64'), plain: true, updatedAt: new Date().toISOString() };
  writeAll(userDataDir, all);
  return { mode: 'plain' };
}

export function getSecret(userDataDir: string, key: string): string | undefined {
  const rec = readAll(userDataDir)[key];
  if (!rec) return undefined;
  if (rec.plain) return Buffer.from(rec.value, 'base64').toString('utf-8');
  const ss = safeStorage();
  if (!ss) return undefined;
  try {
    return ss.decryptString(Buffer.from(rec.value, 'base64'));
  } catch {
    // Different OS user / keychain reset — the ciphertext is unrecoverable.
    return undefined;
  }
}

export function deleteSecret(userDataDir: string, key: string): void {
  const all = readAll(userDataDir);
  if (key in all) {
    delete all[key];
    writeAll(userDataDir, all);
  }
}

export function hasSecret(userDataDir: string, key: string): boolean {
  return !!readAll(userDataDir)[key];
}
