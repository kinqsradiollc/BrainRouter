/**
 * Prefix-pinned memory briefing (0.3.9 item 9).
 *
 * BrainRouter's unique contribution to the Reasonix cache-first loop:
 * memory cards live inside the immutable prefix instead of being
 * rewritten as a tagged system message every turn.
 *
 * The agent calls `decideAnchorAction()` on each briefing result:
 *
 *   - `PIN`         — feature is on AND no anchor has been pinned yet;
 *                     the result becomes the session's prefix anchor.
 *   - `STABLE`      — feature is on AND the new briefing content hashes
 *                     to the same value as the pinned one; no rewrite,
 *                     no append, no cache miss.
 *   - `APPEND`      — feature is on AND the new content differs; emit
 *                     the result as an append-only assistant message
 *                     ("mid-session memory refresh") instead of
 *                     rewriting the prefix.
 *   - `LEGACY`      — feature is off; fall back to the pre-0.3.9
 *                     behavior (replace the tagged system message
 *                     every turn).
 *
 * `/refresh-memory` clears the pinned state so the next briefing
 * re-pins as a fresh PIN action.
 *
 * Env switch: `BRAINROUTER_PREFIX_MEMORY_ANCHORS`. Default is `on`;
 * `off` disables pinning entirely.
 */

import { createHash } from 'node:crypto';

/**
 * The synthetic message shape stored in the agent's chat history
 * when an anchor is pinned. The marker comment lets the agent's
 * existing tagged-system-message machinery still see it (item 8's
 * fingerprint helper picks up `meta.pinned`).
 */
export const ANCHOR_TAG = 'memory-anchor';
export const ANCHOR_MARKER = `<!--brainrouter:${ANCHOR_TAG}-->\n`;

/** Heading prepended to mid-session refreshes that route to the append log. */
export const MID_SESSION_REFRESH_HEADING = '[Mid-session memory refresh — appended, prefix cache preserved]';

export type AnchorAction = 'PIN' | 'STABLE' | 'APPEND' | 'LEGACY';

export interface AnchorDecisionInput {
  /** SHA-256 (16 hex) of the briefing block that was just produced. */
  newContentHash: string;
  /** SHA-256 (16 hex) of the currently pinned anchor's content; `null` if no pin yet. */
  pinnedHash: string | null;
  /** Snapshot of the `cli.prefixMemoryAnchors` knob from config.json (`'on'` / `'off'`). */
  envSetting: string | undefined;
}

export interface AnchorDecision {
  action: AnchorAction;
  /** Updated `pinnedHash` to write back to the agent — only changes on PIN. */
  nextPinnedHash: string | null;
}

/**
 * Pure decision function — easy to unit-test, no side effects.
 */
export function decideAnchorAction(input: AnchorDecisionInput): AnchorDecision {
  const enabled = isPinningEnabled(input.envSetting);
  if (!enabled) {
    return { action: 'LEGACY', nextPinnedHash: input.pinnedHash };
  }
  if (input.pinnedHash === null) {
    return { action: 'PIN', nextPinnedHash: input.newContentHash };
  }
  if (input.pinnedHash === input.newContentHash) {
    return { action: 'STABLE', nextPinnedHash: input.pinnedHash };
  }
  return { action: 'APPEND', nextPinnedHash: input.pinnedHash };
}

/**
 * Returns true unless `BRAINROUTER_PREFIX_MEMORY_ANCHORS=off|0|false`
 * (case-insensitive). Unset → enabled.
 */
export function isPinningEnabled(envSetting: string | undefined): boolean {
  if (envSetting === undefined) return true;
  const v = envSetting.trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/**
 * Stable 16-char SHA-256 prefix of a briefing block. The agent stores
 * this alongside the pinned anchor so `decideAnchorAction()` can
 * cheaply tell PIN/STABLE/APPEND apart on the next briefing.
 */
export function hashBriefingContent(block: string): string {
  return createHash('sha256').update(block).digest('hex').slice(0, 16);
}

/**
 * Wrap the briefing block into the on-the-wire system message used as
 * the pinned anchor. The marker prefix lets the legacy
 * `replaceTaggedSystemMessage` machinery still find and replace it
 * when `/refresh-memory` fires.
 *
 * Reasonix's ImmutablePrefix uses a synthetic assistant message for
 * its anchors; we use a system message so the change is invisible to
 * the rest of the agent (the chatHistory already treats tagged system
 * messages as cache-stable). The wire shape isn't load-bearing here —
 * the byte-stability across turns is what matters for the prefix
 * cache.
 */
export function wrapAnchorContent(block: string): string {
  return `${ANCHOR_MARKER}${block}`;
}

/**
 * Wrap a fresh briefing block as the mid-session refresh message that
 * gets appended (rather than replacing the prefix). The heading makes
 * the addition unambiguous to the model.
 */
export function wrapMidSessionRefresh(block: string): string {
  return `${MID_SESSION_REFRESH_HEADING}\n${block}`;
}
