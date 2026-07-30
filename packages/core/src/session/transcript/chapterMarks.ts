/**
 * CC-P12.3 — session chapters (0.4.15 thread J).
 *
 * The model calls `mark_chapter` when the work shifts to a meaningfully
 * different phase (exploration → implementation → verification); the marker
 * is persisted as a tagged transcript entry and `/chapters` renders the
 * table of contents with entry indexes (jump targets for /transcript and
 * the scroll window). Pure helpers here; the tool/commands do the IO.
 */
import type { TranscriptEntry } from './sessionStore.js';

export const CHAPTER_ENTRY_NAME = 'chapter';

export interface ChapterMark {
  /** Index into the transcript entries array. */
  index: number;
  title: string;
  summary?: string;
  timestamp?: string;
}

/** Build the transcript entry payload for a chapter. Pure. */
export function chapterEntryContent(title: string, summary?: string): string {
  return JSON.stringify(summary ? { title, summary } : { title });
}

/** Extract chapter marks from a loaded transcript. Tolerant of bad payloads. Pure. */
export function listChapters(entries: TranscriptEntry[]): ChapterMark[] {
  const out: ChapterMark[] = [];
  entries.forEach((e, index) => {
    if (e.role !== 'system' || e.name !== CHAPTER_ENTRY_NAME) return;
    try {
      const parsed = JSON.parse(typeof e.content === 'string' ? e.content : JSON.stringify(e.content)) as { title?: string; summary?: string };
      if (parsed?.title) out.push({ index, title: parsed.title, summary: parsed.summary, timestamp: e.timestamp });
    } catch { /* malformed marker — skip */ }
  });
  return out;
}

/** Render the /chapters table of contents. Pure. */
export function formatChapters(marks: ChapterMark[]): string[] {
  if (marks.length === 0) return ['No chapters marked in this session yet.'];
  return marks.map((m, i) => {
    const when = m.timestamp ? ` · ${m.timestamp.replace('T', ' ').slice(11, 19)}` : '';
    const summary = m.summary ? ` — ${m.summary}` : '';
    return `  ${i + 1}. [#${m.index}] ${m.title}${when}${summary}`;
  });
}
