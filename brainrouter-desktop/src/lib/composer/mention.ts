/**
 * COMPOSER @-MENTION (§5.7) — pure helpers for file mentions in the chat input.
 *
 * Typing `@` followed by a partial path opens a workspace-file picker; choosing
 * one inserts its path. This module is the dependency-free core — detect the
 * active `@token` at the caret, rank file matches, and splice the chosen path
 * back in — so the Composer integration stays thin and this logic is unit-tested.
 */

export interface MentionToken {
  /** Index of the `@` in the text. */
  start: number;
  /** The partial query after `@` (may be ''). */
  query: string;
}

const WORD = /[A-Za-z0-9._/\-]/;

/**
 * The active mention token ending at `caret`, or null. The `@` must sit at the
 * start of the text or right after whitespace (so an email's `@` isn't a
 * mention), and the run after it is path-like (`[A-Za-z0-9._/-]`). A whitespace
 * between `@` and the caret ends the mention.
 */
export function findMentionToken(text: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && WORD.test(text[i])) i--;
  if (i < 0 || text[i] !== '@') return null;
  if (i > 0 && !/\s/.test(text[i - 1])) return null; // mid-word @ (e.g. an email) is not a mention
  return { start: i, query: text.slice(i + 1, caret) };
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * Rank workspace files for a mention query: basename-prefix beats
 * basename-substring beats path-substring; ties break on shorter/lexical path.
 * An empty query returns the head of the list (recent/whatever order in).
 */
export function rankFileMatches(query: string, files: string[], max = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, max);
  const scored: Array<{ f: string; score: number }> = [];
  for (const f of files) {
    const b = basename(f).toLowerCase();
    const lc = f.toLowerCase();
    let score = -1;
    if (b.startsWith(q)) score = 0;
    else if (b.includes(q)) score = 1;
    else if (lc.includes(q)) score = 2;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length || a.f.localeCompare(b.f));
  return scored.slice(0, max).map((x) => x.f);
}

/**
 * Replace the mention token (`@query` up to `caret`) with the chosen path plus a
 * trailing space, returning the new text and caret position.
 */
export function applyMention(text: string, token: MentionToken, caret: number, path: string): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(caret);
  // add a trailing space unless the caret already sits before whitespace.
  const insert = /^\s/.test(after) ? path : `${path} `;
  return { text: before + insert + after, caret: before.length + insert.length };
}
