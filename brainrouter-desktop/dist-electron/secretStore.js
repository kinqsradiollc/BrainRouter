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
let safeStorageImpl;
function safeStorage() {
    if (safeStorageImpl !== undefined)
        return safeStorageImpl;
    try {
        // Lazy: this module is imported by host tests that run outside Electron.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        safeStorageImpl = require('electron').safeStorage ?? null;
    }
    catch {
        safeStorageImpl = null;
    }
    return safeStorageImpl;
}
/** Test hook — inject a fake safeStorage (or null to simulate no backend). */
export function _setSafeStorageForTests(impl) {
    safeStorageImpl = impl;
}
function secretsFile(userDataDir) {
    return path.join(userDataDir, 'secrets.json');
}
function readAll(userDataDir) {
    try {
        return JSON.parse(fs.readFileSync(secretsFile(userDataDir), 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeAll(userDataDir, all) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(secretsFile(userDataDir), JSON.stringify(all, null, 2), { mode: 0o600 });
}
export function secretStorageMode() {
    const ss = safeStorage();
    return ss?.isEncryptionAvailable() ? 'keychain' : 'plain';
}
export function setSecret(userDataDir, key, value) {
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
export function getSecret(userDataDir, key) {
    const rec = readAll(userDataDir)[key];
    if (!rec)
        return undefined;
    if (rec.plain)
        return Buffer.from(rec.value, 'base64').toString('utf-8');
    const ss = safeStorage();
    if (!ss)
        return undefined;
    try {
        return ss.decryptString(Buffer.from(rec.value, 'base64'));
    }
    catch {
        // Different OS user / keychain reset — the ciphertext is unrecoverable.
        return undefined;
    }
}
export function deleteSecret(userDataDir, key) {
    const all = readAll(userDataDir);
    if (key in all) {
        delete all[key];
        writeAll(userDataDir, all);
    }
}
export function hasSecret(userDataDir, key) {
    return !!readAll(userDataDir)[key];
}
