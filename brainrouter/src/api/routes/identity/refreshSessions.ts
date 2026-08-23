/**
 * Refresh-session lifecycle: issue, verify-and-rotate, revoke.
 *
 * A refresh token is the most powerful credential this product hands a browser.
 * It outlives the access token by design, so the questions that matter are the
 * ones a stateless JWT cannot answer: can it be revoked, and can we tell when
 * one has been stolen? Both need a row.
 *
 * The rules encoded here:
 *
 * - **The token is stored hashed**, never raw, so a database read does not yield
 *   live sessions. Same treatment `tenancy/tokens.ts` already gives invite and
 *   reset tokens.
 * - **Rotation is enforced, not merely offered.** Using a refresh token consumes
 *   it and mints a successor. The old row is marked `replaced_by` rather than
 *   deleted, because the record of a rotation is what makes the next rule work.
 * - **Reuse revokes the chain.** Presenting an already-replaced token means the
 *   token existed in two places: a theft, a clone, or a restored backup. All
 *   three warrant ending every session for that user, because we cannot tell
 *   which holder is the legitimate one — and the alternative, letting both
 *   continue, is exactly the state an attacker wants.
 * - **A password change ends sessions.** Otherwise the reset does not do the one
 *   thing the user changed their password to achieve.
 */
import { createHash, randomUUID } from "node:crypto";

/** One-way, matching `tenancy/tokens.ts` — a leaked row must not be a session. */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export interface RefreshSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  replacedBy: string | null;
}

/** The store this module needs. Kept narrow so it is testable without a database. */
export interface RefreshSessionStore {
  insert(row: Omit<RefreshSessionRow, "revokedAt" | "revokedReason" | "replacedBy">): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshSessionRow | null>;
  markReplaced(id: string, replacedBy: string): Promise<void>;
  revokeById(id: string, reason: string): Promise<void>;
  revokeAllForUser(userId: string, reason: string): Promise<number>;
}

export type RotateOutcome =
  | { status: "ok"; sessionId: string }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "revoked" }
  /** Already rotated once — treated as theft; the whole chain is revoked. */
  | { status: "reused"; revoked: number };

export interface IssueInput {
  store: RefreshSessionStore;
  userId: string;
  rawToken: string;
  expiresAt: Date;
  now?: Date;
  /** Pre-chosen session id — lets a caller rotate an old token onto a known successor id. */
  id?: string;
}

export async function issueRefreshSession(input: IssueInput): Promise<string> {
  const id = input.id ?? `rs_${randomUUID().replace(/-/g, "")}`;
  await input.store.insert({
    id,
    userId: input.userId,
    tokenHash: hashRefreshToken(input.rawToken),
    issuedAt: input.now ?? new Date(),
    expiresAt: input.expiresAt,
  });
  return id;
}

/**
 * Consume a presented refresh token.
 *
 * Every non-ok outcome is a refusal — a caller must never fall back to "well,
 * the signature was valid". The signature says the token was minted here; only
 * the row says it is still a session.
 */
export async function rotateRefreshSession(input: {
  store: RefreshSessionStore;
  presentedToken: string;
  successorId: string;
  now?: Date;
}): Promise<RotateOutcome> {
  const now = input.now ?? new Date();
  const row = await input.store.findByHash(hashRefreshToken(input.presentedToken));
  if (!row) return { status: "unknown" };

  if (row.replacedBy) {
    // Reuse. The legitimate holder rotated already, so whoever presented this
    // copy is not the only holder. We cannot tell which is which, so neither
    // continues.
    const revoked = await input.store.revokeAllForUser(
      row.userId,
      "refresh token reuse detected — every session revoked",
    );
    return { status: "reused", revoked };
  }
  if (row.revokedAt) return { status: "revoked" };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: "expired" };

  await input.store.markReplaced(row.id, input.successorId);
  return { status: "ok", sessionId: row.id };
}

/** End every session for a user. Used by signout-all and by password change. */
export async function revokeAllSessions(
  store: RefreshSessionStore,
  userId: string,
  reason: string,
): Promise<number> {
  return store.revokeAllForUser(userId, reason);
}
