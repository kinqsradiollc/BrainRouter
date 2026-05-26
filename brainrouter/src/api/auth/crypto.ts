import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, salt, storedHash.length) as Buffer;
  if (derived.length !== storedHash.length) return false;
  return timingSafeEqual(derived, storedHash);
}

export function signJwt(payload: Record<string, unknown>, secret: string, expiresInSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSecs };
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = base64UrlEncode(JSON.stringify(body));
  const signature = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}

export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts;
  // Compare in base64url string space so single-character changes to padding
  // bits (e.g. "A" → "B" at the last position of a 32-byte HMAC) are caught.
  // Raw-byte comparison misses these because base64url decoding ignores the
  // bottom 2 bits of the final character.
  const expected = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  const expBuf = Buffer.from(expected);
  const actBuf = Buffer.from(signature);
  if (expBuf.length !== actBuf.length || !timingSafeEqual(expBuf, actBuf)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(claims).toString("utf8")) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? payload.exp : 0;
    if (exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
