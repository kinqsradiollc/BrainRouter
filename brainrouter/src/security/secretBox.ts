/**
 * secretBox — envelope encryption for secrets at rest (ADR-010 §4).
 *
 * Provider API keys (and other stored credentials) are sealed with AES-256-GCM
 * before they touch the database, so a DB dump never leaks a usable key. The
 * 256-bit master key (KEK) comes from `BRAINROUTER_SECRET_KEY` — a single infra
 * secret (12-factor / KMS-backed), NOT a provider credential.
 *
 * Sealed format (base64):  `v1:` + base64( iv(12) | authTag(16) | ciphertext )
 *
 * The pure core (`sealWith`/`openWith`) takes the key explicitly so it unit-tests
 * without any env; the env-reading wrappers (`seal`/`open`) are what callers use.
 * `open` transparently returns a legacy PLAINTEXT value (no `v1:` prefix) so an
 * env-seeded config that was stored unencrypted still reads during rollout.
 */
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parse the master key from base64 or hex (must decode to exactly 32 bytes). */
export function parseMasterKey(raw: string | undefined | null): Buffer | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  for (const enc of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(v, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      /* try next encoding */
    }
  }
  // A raw 32-char passphrase is accepted as UTF-8 bytes (last resort).
  const utf8 = Buffer.from(v, "utf8");
  return utf8.length === KEY_BYTES ? utf8 : null;
}

/** Seal a plaintext with an explicit 32-byte key. Pure + deterministic given `iv`. */
export function sealWith(key: Buffer, plaintext: string, iv?: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error("secretBox: key must be 32 bytes");
  const nonce = iv ?? crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([nonce, tag, ct]).toString("base64")}`;
}

/** Open a value sealed by {@link sealWith}. A non-`v1:` value is returned verbatim
 *  (legacy plaintext passthrough for rollout). Throws on a corrupt `v1:` blob. */
export function openWith(key: Buffer, sealed: string): string {
  if (!sealed.startsWith(`${VERSION}:`)) return sealed; // legacy plaintext
  if (key.length !== KEY_BYTES) throw new Error("secretBox: key must be 32 bytes");
  const raw = Buffer.from(sealed.slice(VERSION.length + 1), "base64");
  if (raw.length < IV_BYTES + 16 + 1) throw new Error("secretBox: sealed value too short");
  const nonce = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
  const ct = raw.subarray(IV_BYTES + 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when a usable master key is configured (BRAINROUTER_SECRET_KEY). */
export function isSecretBoxConfigured(): boolean {
  return parseMasterKey(process.env.BRAINROUTER_SECRET_KEY) !== null;
}

/** True when a value is a sealed `v1:` blob (vs. legacy plaintext). */
export function isSealed(value: string): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

function requireMasterKey(): Buffer {
  const key = parseMasterKey(process.env.BRAINROUTER_SECRET_KEY);
  if (!key) {
    throw new Error(
      "BRAINROUTER_SECRET_KEY is required to store provider secrets (a base64/hex-encoded 32-byte key).",
    );
  }
  return key;
}

/** Seal a plaintext using the env master key. Throws if the key is unconfigured. */
export function seal(plaintext: string): string {
  return sealWith(requireMasterKey(), plaintext);
}

/** Open a sealed value using the env master key. Legacy plaintext passes through
 *  even when no key is configured (so an env-seeded config still reads). */
export function open(sealed: string): string {
  if (!isSealed(sealed)) return sealed;
  return openWith(requireMasterKey(), sealed);
}
