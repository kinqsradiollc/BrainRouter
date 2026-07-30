import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSecret, getSecret, deleteSecret, hasSecret, secretStorageMode, _setSafeStorageForTests } from './secretStore.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'br-secrets-'));

/** XOR "encryption" — enough to prove ciphertext round-trips through the store. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf-8')].map((b) => b ^ 0x5a)),
  decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf-8'),
};

test('keychain mode: set/get round-trips, value on disk is ciphertext', () => {
  _setSafeStorageForTests(fakeSafeStorage);
  const dir = tmp();
  try {
    assert.equal(secretStorageMode(), 'keychain');
    assert.deepEqual(setSecret(dir, 'connector:c1:github-oauth', 'gho_secret'), { mode: 'keychain' });
    assert.equal(getSecret(dir, 'connector:c1:github-oauth'), 'gho_secret');
    assert.equal(hasSecret(dir, 'connector:c1:github-oauth'), true);
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf-8');
    assert.ok(!raw.includes('gho_secret'), 'plaintext must not hit disk');
    deleteSecret(dir, 'connector:c1:github-oauth');
    assert.equal(getSecret(dir, 'connector:c1:github-oauth'), undefined);
  } finally {
    _setSafeStorageForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no encryption backend: falls back to plain (marked) rather than refusing', () => {
  _setSafeStorageForTests(null);
  const dir = tmp();
  try {
    assert.equal(secretStorageMode(), 'plain');
    assert.deepEqual(setSecret(dir, 'k', 'v'), { mode: 'plain' });
    assert.equal(getSecret(dir, 'k'), 'v');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf-8')) as Record<string, { plain?: boolean }>;
    assert.equal(rec.k.plain, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unrecoverable ciphertext (keychain reset) reads as undefined, not garbage', () => {
  _setSafeStorageForTests(fakeSafeStorage);
  const dir = tmp();
  try {
    setSecret(dir, 'k', 'v');
    _setSafeStorageForTests({
      ...fakeSafeStorage,
      decryptString: () => { throw new Error('MAC mismatch'); },
    });
    assert.equal(getSecret(dir, 'k'), undefined);
  } finally {
    _setSafeStorageForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
