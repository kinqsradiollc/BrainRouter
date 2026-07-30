/**
 * Secret-token helpers (ADR-014 Phase B2) — the invitation/verification pattern:
 * generate a high-entropy token, return the RAW value to email/URL, but persist
 * only its SHA-256 HASH. Validation re-hashes the presented token and looks it up,
 * so a DB leak never exposes a usable token. Pure + dependency-free.
 */
import { randomBytes, createHash } from "node:crypto";

/** SHA-256 hex of a raw token. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A new token: `raw` goes in the email/link, `hash` is stored. */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** An ISO timestamp `ms` from `fromIso` (defaults to now at call time via the caller). */
export function expiryFrom(fromIso: string, ms: number): string {
  return new Date(new Date(fromIso).getTime() + ms).toISOString();
}

/** True when `expiresAtIso` is still in the future relative to `nowIso`. */
export function notExpired(expiresAtIso: string, nowIso: string): boolean {
  return new Date(expiresAtIso).getTime() > new Date(nowIso).getTime();
}
