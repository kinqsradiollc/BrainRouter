/**
 * ADR-041 A41-14 (W2) — per-message feedback.
 *
 * The existing `/feedback` command records one free-text, session-level note in
 * the user-global home. This adds the finer grain the parity wave calls for: a
 * thumbs rating (+ optional note) attached to a SPECIFIC message, editable, and
 * stored WITH the session (so it travels with a fork/export, not a central file).
 *
 * A message has no stable id in the transcript, so feedback is keyed by the
 * message's `timestamp` (unique within a session's turn stream). The store is an
 * append-only `message-feedback.jsonl` in the session bucket; a re-rating simply
 * appends a newer record and the reader keeps the latest per message — so a user
 * can flip 👍→👎 or revise a note without any in-place mutation. All disk ops are
 * best-effort: feedback is metadata and must never break a turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionStateDir } from '../../storage/store.js';

const MESSAGE_FEEDBACK_FILE = 'message-feedback.jsonl';

export type MessageRating = 'up' | 'down';

/** One feedback event on a single message. */
export interface MessageFeedback {
  /** The rated message's transcript timestamp (its address within the session). */
  messageTs: string;
  /** Thumbs up/down. */
  rating: MessageRating;
  /** Optional free-text note. */
  note?: string;
  /** When this rating was recorded (ISO). */
  at: string;
}

function feedbackPath(workspaceRoot: string, sessionKey: string): string {
  return path.join(getSessionStateDir(workspaceRoot, sessionKey), MESSAGE_FEEDBACK_FILE);
}

/**
 * Record (or revise) feedback on a message. Appends a new record; the latest one
 * per `messageTs` wins on read, so this doubles as an edit. Best-effort — returns
 * false if the write failed rather than throwing.
 */
export function recordMessageFeedback(
  workspaceRoot: string,
  sessionKey: string,
  feedback: { messageTs: string; rating: MessageRating; note?: string; at?: string },
): boolean {
  const record: MessageFeedback = {
    messageTs: feedback.messageTs,
    rating: feedback.rating,
    at: feedback.at ?? new Date().toISOString(),
    ...(feedback.note?.trim() ? { note: feedback.note.trim() } : {}),
  };
  try {
    fs.appendFileSync(feedbackPath(workspaceRoot, sessionKey), `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The current feedback per message (latest rating wins), keyed by `messageTs`.
 * Empty when the session has no message feedback.
 */
export function readMessageFeedback(workspaceRoot: string, sessionKey: string): Map<string, MessageFeedback> {
  const latest = new Map<string, MessageFeedback>();
  let raw: string;
  try {
    raw = fs.readFileSync(feedbackPath(workspaceRoot, sessionKey), 'utf8');
  } catch {
    return latest; // no feedback file yet
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Partial<MessageFeedback>;
      if (typeof rec.messageTs === 'string' && (rec.rating === 'up' || rec.rating === 'down') && typeof rec.at === 'string') {
        // Later lines overwrite earlier ones — append-only edit semantics.
        latest.set(rec.messageTs, {
          messageTs: rec.messageTs,
          rating: rec.rating,
          at: rec.at,
          ...(typeof rec.note === 'string' && rec.note ? { note: rec.note } : {}),
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return latest;
}

/** Tally of up/down ratings currently standing for a session. */
export function messageFeedbackTally(workspaceRoot: string, sessionKey: string): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const fb of readMessageFeedback(workspaceRoot, sessionKey).values()) {
    if (fb.rating === 'up') up++;
    else down++;
  }
  return { up, down };
}
