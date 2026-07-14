import crypto from 'node:crypto';
import nacl from 'tweetnacl';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');
export const fromB64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

export function createRelayKeyPair(): nacl.BoxKeyPair { return nacl.box.keyPair(); }

export function randomToken(bytes = 32): string { return crypto.randomBytes(bytes).toString('base64url'); }

export function hashDeviceToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDeviceToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function encryptRelayPayload(
  payload: unknown,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
  nonce = nacl.randomBytes(nacl.box.nonceLength),
): { nonce: string; ciphertext: string } {
  const message = encoder.encode(JSON.stringify(payload));
  const ciphertext = nacl.box(message, nonce, recipientPublicKey, senderSecretKey);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

export function decryptRelayPayload<T>(
  envelope: { nonce: string; ciphertext: string },
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): T | null {
  const nonce = fromB64(envelope.nonce);
  const ciphertext = fromB64(envelope.ciphertext);
  if (nonce.length !== nacl.box.nonceLength || ciphertext.length < nacl.box.overheadLength) return null;
  const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
  if (!opened) return null;
  try { return JSON.parse(decoder.decode(opened)) as T; } catch { return null; }
}
