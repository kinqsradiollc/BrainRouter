/**
 * CC-P1.4 — transcript search (0.4.15 thread A). Pure search over a loaded
 * session transcript: find entries whose text contains the query (case-
 * insensitive by default), returning enough context (entry index, role, a
 * snippet with the match highlighted by offsets) for `/find` to print a
 * jump-list. No IO → unit-tested; the command layer renders the matches.
 */
import type { TranscriptEntry } from './sessionStore.js';

export interface TranscriptMatch {
  /** Index into the transcript entries array. */
  index: number;
  role: string;
  /** A short snippet around the first match in this entry. */
  snippet: string;
  /** Number of matches found in this entry. */
  count: number;
  timestamp?: string;
}

function entryText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    n++;
    from = i + needle.length;
  }
  return n;
}

/**
 * Search transcript entries for `query`. Pure. Returns matches in transcript
 * order. `caseSensitive` defaults to false. `snippetRadius` controls context
 * chars on each side of the first match.
 */
export function searchTranscript(
  entries: TranscriptEntry[],
  query: string,
  opts?: { caseSensitive?: boolean; snippetRadius?: number; limit?: number },
): TranscriptMatch[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const radius = opts?.snippetRadius ?? 60;
  const limit = opts?.limit ?? 50;
  const cs = opts?.caseSensitive ?? false;
  const needle = cs ? q : q.toLowerCase();

  const matches: TranscriptMatch[] = [];
  for (let index = 0; index < entries.length && matches.length < limit; index++) {
    const e = entries[index];
    const raw = entryText(e.content);
    const hay = cs ? raw : raw.toLowerCase();
    const first = hay.indexOf(needle);
    if (first < 0) continue;

    const start = Math.max(0, first - radius);
    const end = Math.min(raw.length, first + needle.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < raw.length ? '…' : '';
    const snippet = (prefix + raw.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();

    matches.push({
      index,
      role: e.role,
      snippet,
      count: countOccurrences(hay, needle),
      timestamp: e.timestamp,
    });
  }
  return matches;
}

/** Render the match list as plain lines for the REPL. Pure. */
export function formatMatches(matches: TranscriptMatch[], query: string): string[] {
  if (matches.length === 0) return [`No matches for "${query}".`];
  return matches.map((m) => {
    const when = m.timestamp ? m.timestamp.replace('T', ' ').slice(11, 19) : '';
    const countTag = m.count > 1 ? ` (${m.count}×)` : '';
    return `  #${m.index} ${m.role}${when ? ` ${when}` : ''}${countTag}: ${m.snippet}`;
  });
}
