/**
 * MAS-P5-T7 / T8 (§6.5 agent transcript debugger) — pure rendering for
 * `/agents transcript <id> [--tools] [--errors]` and `/agents replay <id>`.
 * The handler resolves the child's transcript (getSession → childSessionKey →
 * readTranscriptEntries) and passes the raw entries here. Kept free of
 * chalk/I/O so filtering + formatting are unit-testable.
 */

export interface TranscriptEntryLike {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  isError?: boolean;
  timestamp?: string;
}

export type EntryKind = 'tool-call' | 'tool-result' | 'error' | 'user' | 'assistant' | 'system';

export function entryKind(e: TranscriptEntryLike): EntryKind {
  if (e.isError) return 'error';
  if (e.tool_calls != null) return 'tool-call';
  if (e.role === 'tool') return 'tool-result';
  if (e.role === 'user') return 'user';
  if (e.role === 'assistant') return 'assistant';
  return 'system';
}

function roleGlyph(kind: EntryKind): string {
  switch (kind) {
    case 'user': return '❯';
    case 'assistant': return '⏺';
    case 'tool-call': return '→';
    case 'tool-result': return '⎿';
    case 'error': return '✗';
    default: return '·';
  }
}

function toolNames(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return 'tool';
  const names = toolCalls
    .map((c: any) => c?.function?.name ?? c?.name)
    .filter((n: unknown): n is string => typeof n === 'string');
  return names.length ? names.join(', ') : 'tool';
}

/** One-line preview of an entry's payload. */
export function entryPreview(e: TranscriptEntryLike, max = 100): string {
  if (e.tool_calls != null) return `calls ${toolNames(e.tool_calls)}`;
  let text: string;
  if (typeof e.content === 'string') text = e.content;
  else if (Array.isArray(e.content)) {
    const part = (e.content as any[]).find((p) => typeof p?.text === 'string');
    text = part?.text ?? JSON.stringify(e.content);
  } else if (e.content == null) text = '';
  else text = JSON.stringify(e.content);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const prefix = e.role === 'tool' && e.name ? `${e.name}: ` : '';
  const body = `${prefix}${oneLine}`;
  if (!body) return '(empty)';
  return body.length > max ? body.slice(0, max - 1) + '…' : body;
}

/**
 * Filter for `/agents transcript`. With neither flag, all entries pass. With
 * `--tools` and/or `--errors`, keep entries matching ANY requested filter
 * (tool calls + tool results for `--tools`; error entries for `--errors`).
 */
export function filterTranscriptEntries(
  entries: TranscriptEntryLike[],
  opts: { tools?: boolean; errors?: boolean } = {},
): TranscriptEntryLike[] {
  if (!opts.tools && !opts.errors) return entries;
  return entries.filter((e) => {
    if (opts.errors && e.isError) return true;
    if (opts.tools && (e.role === 'tool' || e.tool_calls != null)) return true;
    return false;
  });
}

/** Compact, filterable transcript lines: `<glyph> <hh:mm:ss> <role> <preview>`. */
export function formatAgentTranscript(
  entries: TranscriptEntryLike[],
  opts: { tools?: boolean; errors?: boolean } = {},
): string[] {
  const filtered = filterTranscriptEntries(entries, opts);
  if (filtered.length === 0) return ['(no matching entries)'];
  return filtered.map((e) => {
    const kind = entryKind(e);
    const ts = (e.timestamp ?? '').slice(11, 19) || '  --  ';
    return `${roleGlyph(kind)} ${ts}  ${kind.padEnd(12)} ${entryPreview(e)}`;
  });
}

/** Numbered, read-only step-through of the full run in order. */
export function formatAgentReplay(entries: TranscriptEntryLike[]): string[] {
  if (entries.length === 0) return ['(empty transcript)'];
  const width = String(entries.length).length;
  return entries.map((e, i) => {
    const kind = entryKind(e);
    const step = String(i + 1).padStart(width);
    return `[${step}/${entries.length}] ${roleGlyph(kind)} ${kind.padEnd(12)} ${entryPreview(e, 140)}`;
  });
}
