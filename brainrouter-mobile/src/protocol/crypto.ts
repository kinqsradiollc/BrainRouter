import nacl from 'tweetnacl';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const b64 = (value: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < value.length; i += 3) {
    const a = value[i] ?? 0; const b = value[i + 1] ?? 0; const c = value[i + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    out += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63] + (i + 1 < value.length ? alphabet[(bits >> 6) & 63] : '=') + (i + 2 < value.length ? alphabet[bits & 63] : '=');
  }
  return out;
};
export const fromB64 = (value: string): Uint8Array => {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const bits = (alphabet.indexOf(clean[i]!) << 18) | (alphabet.indexOf(clean[i + 1]!) << 12) | ((alphabet.indexOf(clean[i + 2]!) & 63) << 6) | (alphabet.indexOf(clean[i + 3]!) & 63);
    bytes.push((bits >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((bits >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(bits & 255);
  }
  return new Uint8Array(bytes);
};

export function createDeviceKeyPair(): nacl.BoxKeyPair { return nacl.box.keyPair(); }

export function encryptPayload(payload: unknown, recipientPublicKey: Uint8Array, senderSecretKey: Uint8Array) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(encoder.encode(JSON.stringify(payload)), nonce, recipientPublicKey, senderSecretKey);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

export function decryptPayload<T>(envelope: { nonce: string; ciphertext: string }, senderPublicKey: Uint8Array, recipientSecretKey: Uint8Array): T | null {
  const nonce = fromB64(envelope.nonce);
  const ciphertext = fromB64(envelope.ciphertext);
  if (nonce.length !== nacl.box.nonceLength) return null;
  const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey);
  if (!opened) return null;
  try { return JSON.parse(decoder.decode(opened)) as T; } catch { return null; }
}
