import type { TranscriptEntry } from '../state/sessionStore.js';

/**
 * 0.4.x-3 — `/rewind` timeline model (pure, unit-tested).
 *
 * A "turn" begins at each `user` transcript entry and runs up to (but not
 * including) the next `user` entry — so it covers the user message plus the
 * assistant + tool entries that answered it. `/rewind <n>` forks a new
 * session whose history is truncated to keep turns 1..n and drop everything
 * after, letting the user branch the conversation from an earlier point.
 */

export interface RewindTurn {
  /** 1-based number shown in the picker (1 = oldest shown, highest = most recent). */
  turnNumber: number;
  /** Index of the user entry that opens this turn. */
  userEntryIndex: number;
  /** Slice end (exclusive): keep `entries.slice(0, endIndex)` to retain this turn's full exchange. */
  endIndex: number;
  timestamp: string;
  preview: string;
}

/** Extract a one-line preview from a transcript entry's `content` (string or content-part array). */
export function previewText(content: unknown, max = 72): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const part = content.find((p: any) => typeof p?.text === 'string') as { text?: string } | undefined;
    text = part?.text ?? '';
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(empty)';
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * Build the rewind picker over the last `max` user turns. Each entry carries
 * the slice `endIndex` that keeps that turn's full exchange and drops later
 * turns. Numbered 1..N over the shown window (oldest shown = 1).
 */
export function buildRewindTimeline(entries: TranscriptEntry[], max = 20): RewindTurn[] {
  const userIdx: number[] = [];
  entries.forEach((e, i) => { if (e.role === 'user') userIdx.push(i); });

  const turns: RewindTurn[] = userIdx.map((ui, k) => ({
    turnNumber: 0, // assigned after windowing
    userEntryIndex: ui,
    endIndex: userIdx[k + 1] ?? entries.length, // up to the next user turn (exclusive)
    timestamp: entries[ui].timestamp,
    preview: previewText(entries[ui].content),
  }));

  return turns.slice(-max).map((t, i) => ({ ...t, turnNumber: i + 1 }));
}

/** Keep `entries[0, endIndex)`, clamped to valid bounds. */
export function truncateAtTurn(entries: TranscriptEntry[], endIndex: number): TranscriptEntry[] {
  return entries.slice(0, Math.max(0, Math.min(endIndex, entries.length)));
}
