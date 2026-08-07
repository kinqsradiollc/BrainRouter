/**
 * ADR-029 B5 — search covers content AND references.
 *
 * *"The note where I wrote about BR-114"* is as real a question as *"the note
 * where I wrote about the parser"*, and a search that only reads prose cannot
 * answer it: the id lives inside a `brainrouter://` URI that nobody typed as
 * words.
 *
 * **The two are searched separately, and that is the decision worth stating.**
 * The naive version — match the raw text and be done — technically finds
 * `BR-114` because the URI is in the text. It also makes every block containing
 * any planner link a hit for "planner", and it reports a block whose only
 * connection to the query is a machine-generated identifier as though the
 * person had written the word. So URIs are lifted out of the text before the
 * prose is matched, and each hit says which half it matched on. A result that
 * matched only a link is a different answer from one that matched a sentence,
 * and collapsing them is how a search stops being trusted.
 *
 * Extraction is layer one's (`workspace/references`), so a note and a chat turn
 * and a meeting summary all agree on what counts as a reference.
 */
import {
  extractWorkspaceRefs, formatWorkspaceRef, workspaceRefKey,
  type WorkspaceReferenceSource,
} from '../workspace/references/index.js';
import { noteBlockRef, type NoteBlock, type NoteBlockKind } from './block.js';

/** Same shape the extractor scans for, so the two cannot disagree about a URI. */
const REF_IN_TEXT = /brainrouter:\/\/[^\s<>"'`]+/gi;

/** Enough to show a line without turning results into a second document. */
const SNIPPET = 160;

export type NoteMatchOn = 'text' | 'reference';

export interface NoteSearchHit {
  blockId: string;
  kind: NoteBlockKind;
  /** Which halves matched. Never empty. */
  matched: readonly NoteMatchOn[];
  /** The prose around the match, with references already lifted out. */
  snippet: string;
  /** References in this block that matched, canonically spelled. */
  matchedRefs: readonly string[];
  score: number;
}

export interface NoteSearchOptions {
  limit?: number;
  /** Include tombstoned blocks. Off by default: a deleted block is not a result. */
  includeDeleted?: boolean;
}

/** The prose, with reference URIs removed. See the header for why. */
export function contentWithoutRefs(text: string): string {
  return text.replace(REF_IN_TEXT, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The sources layer one's backlink index is built from.
 *
 * A2 says the reference lives in the referring content and backlinks are
 * derived, so this is a projection and never a second store: it reads the
 * blocks' current text, and rebuilding it cannot disagree with them.
 */
export function noteReferenceSources(blocks: Iterable<NoteBlock>): WorkspaceReferenceSource[] {
  const sources: WorkspaceReferenceSource[] = [];
  for (const block of blocks) {
    if (block.deletedAt) continue;
    sources.push({ from: noteBlockRef(block.id), text: block.text.value });
  }
  return sources;
}

/** Every reference a block currently makes, canonically spelled and de-duplicated. */
export function blockReferences(block: NoteBlock): string[] {
  const seen = new Set<string>();
  for (const ref of extractWorkspaceRefs(block.text.value)) seen.add(formatWorkspaceRef(ref));
  return [...seen].sort();
}

function snippetAround(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text.slice(0, SNIPPET);
  const start = Math.max(0, index - Math.floor(SNIPPET / 3));
  const slice = text.slice(start, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${slice}${start + SNIPPET < text.length ? '…' : ''}`;
}

/**
 * Search blocks by what they say and what they link to.
 *
 * Scoring is deliberately crude — a prose match outranks a link-only match, and
 * an earlier match outranks a later one. It is a lookup over one person's
 * notes, not a ranking problem, and a scoring scheme nobody can predict is
 * worse than an obvious one at this size.
 */
export function searchNotes(
  blocks: Iterable<NoteBlock>,
  query: string,
  opts: NoteSearchOptions = {},
): NoteSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: NoteSearchHit[] = [];
  for (const block of blocks) {
    if (block.deletedAt && !opts.includeDeleted) continue;

    const prose = contentWithoutRefs(block.text.value);
    const textIndex = prose.toLowerCase().indexOf(needle);

    const matchedRefs = blockReferences(block).filter((uri) => {
      // The id alone as well as the whole URI, because B5's example query is
      // `BR-114` — the thing a person remembers — not the address it lives at.
      const parsed = extractWorkspaceRefs(uri)[0];
      const id = parsed ? parsed.id.toLowerCase() : '';
      return uri.toLowerCase().includes(needle) || id.includes(needle);
    });

    const matched: NoteMatchOn[] = [];
    if (textIndex >= 0) matched.push('text');
    if (matchedRefs.length > 0) matched.push('reference');
    if (matched.length === 0) continue;

    hits.push({
      blockId: block.id,
      kind: block.kind.value,
      matched,
      snippet: textIndex >= 0 ? snippetAround(prose, needle) : prose.slice(0, SNIPPET),
      matchedRefs,
      score: (textIndex >= 0 ? 100 - Math.min(99, textIndex) : 0) + matchedRefs.length,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.blockId.localeCompare(b.blockId));
  return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
}

/**
 * Which blocks reference a given target, without building a full index.
 *
 * Fragment-insensitive, matching `workspaceRefKey`: a note citing `x.ts#L59`
 * and one citing `#L12` both link to the same file, and splitting them by line
 * number answers a question nobody asked.
 */
export function blocksReferencing(blocks: Iterable<NoteBlock>, targetUri: string): string[] {
  const target = extractWorkspaceRefs(targetUri)[0];
  if (!target) return [];
  const key = workspaceRefKey(target);

  const out: string[] = [];
  for (const block of blocks) {
    if (block.deletedAt) continue;
    const cites = extractWorkspaceRefs(block.text.value).some((ref) => workspaceRefKey(ref) === key);
    if (cites) out.push(block.id);
  }
  return out.sort();
}
