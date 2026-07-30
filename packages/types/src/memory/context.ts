/**
 * BrainRouter Memory Types — runtime context (multi-tenant).
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ============================
// Runtime Context (Multi-Tenant)
// ============================

export interface BrainRouterMemoryContext {
  /** User identifier — REQUIRED. Enables multi-tenant isolation. */
  userId: string;
  /** Session identifier (unique per conversation session). */
  sessionKey: string;
  /** Sub-session identifier (optional). */
  sessionId?: string;
  /** Which BrainRouter skill is currently active (if any) */
  activeSkill?: string;
}
