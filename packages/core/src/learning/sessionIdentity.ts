import crypto from 'node:crypto';
import type { LearnedTenant } from './types.js';

/**
 * Canonical identity for one runtime-owned logical learning session.
 *
 * Local ledgers and hosted Postgres observations must use the same digest or a
 * resumed session can be counted once by each side. The raw key is never
 * persisted in the observation ledger or accepted from model output.
 */
export function learningSessionIdentity(tenant: LearnedTenant, sessionKey: string): string {
  const userId = tenant.userId.trim();
  const orgId = tenant.orgId?.trim() || null;
  const session = sessionKey.trim();
  if (!userId || !session) {
    throw new Error('learning session identity requires a user and session key');
  }
  return crypto.createHash('sha256').update(JSON.stringify([
    userId,
    orgId,
    session,
  ])).digest('hex');
}
