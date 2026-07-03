/**
 * REWIND (WS8) — "rewind the conversation to here". Truncates the transcript (and
 * the agent's chatHistory) back to a chosen entry so the user can re-steer from
 * that point. Kept deliberately simple: if code was already GENERATED after that
 * point (a write_file / edit_file / apply_patch ran), rewinding would orphan that
 * work, so it's blocked — the caller shows an in-app warning instead.
 */
import type { TranscriptEntry } from './sessionStore.js';

/** Tools whose successful run produced files/code on disk. Rewinding past one of
 *  these would leave generated code with no conversation that explains it. */
export const CODE_GEN_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'apply_patch']);

export interface RewindCheck {
  canRewind: boolean;
  /** How many code-generating actions ran after the target (0 when rewindable). */
  codeActionsAfter: number;
  /** Human reason shown in the in-app warning when blocked. */
  reason?: string;
}

/**
 * Pure: can the session rewind to (keeping) the entry at `targetIndex`? Blocked
 * when any successful code-generating tool ran AFTER it.
 */
export function canRewindTo(entries: TranscriptEntry[], targetIndex: number): RewindCheck {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= entries.length) {
    return { canRewind: false, codeActionsAfter: 0, reason: 'Invalid rewind target.' };
  }
  let codeActionsAfter = 0;
  for (let i = targetIndex + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.role === 'tool' && typeof e.name === 'string' && CODE_GEN_TOOLS.has(e.name) && !e.isError) {
      codeActionsAfter++;
    }
  }
  if (codeActionsAfter > 0) {
    return {
      canRewind: false,
      codeActionsAfter,
      reason: `Can't rewind here — ${codeActionsAfter} file change${codeActionsAfter === 1 ? '' : 's'} (write/edit/apply) already happened after this point. Rewinding would orphan generated code.`,
    };
  }
  return { canRewind: true, codeActionsAfter: 0 };
}

/** Pure: the entries kept after a rewind to `targetIndex` (inclusive). */
export function entriesAfterRewind(entries: TranscriptEntry[], targetIndex: number): TranscriptEntry[] {
  return entries.slice(0, Math.max(0, targetIndex + 1));
}
