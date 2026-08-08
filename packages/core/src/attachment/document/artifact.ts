/**
 * ADR-030 Q4 — the cap stops being the whole answer.
 *
 * The 20,000-character cap exists because context is finite, not because
 * documents are short. Today a 13-page deck arrives as one truncated string and
 * everything past the cap is simply gone — the turn does not say it existed, so
 * an answer built on the first third is indistinguishable from an answer built
 * on the file. Q4's decision is not a bigger number:
 *
 * > the document becomes **an artifact with addressable parts**: the turn gets a
 * > bounded, structured extract, and the rest stays reachable at a
 * > `brainrouter://` reference the agent can ask for by section.
 *
 * So a parsed document is written down whole, next to the original bytes, and
 * split into parts that each have an address in ADR-029's space:
 *
 *   `brainrouter://document/outline/<attachmentId>`   — what the document is,
 *                                                       and what its parts are
 *   `brainrouter://document/part/<attachmentId>/<n>`  — one part's own text
 *
 * **A part is a page whenever the parse knew which page it was.** The structured
 * engine emits `<!-- Page N -->` markers, so its output splits exactly where the
 * document does and part 7 IS page 7 — which is what makes "what does the table
 * on page 9 say" answerable. The baseline emits no markers, so its text is
 * chunked at paragraph boundaries and a part carries no page number rather than
 * a guessed one. That asymmetry is deliberate: a part labelled "page 9" that is
 * not page 9 is the quietly-wrong outcome ADR-029 A3 refuses.
 *
 * **Everything here is bounded twice**, because a PDF is attacker-controlled
 * (D4) and this is the layer that writes its contents to disk and reads them
 * back into a turn: the whole artifact has a character budget, each part has its
 * own, and the number of parts is capped. What does not fit is DROPPED and
 * COUNTED — the outline says how many parts it is not showing, because a
 * silently short list is the same failure as a silently truncated string.
 */
import fs from 'node:fs';
import path from 'node:path';
import { attachmentDirPath } from '../store/attachmentStore.js';
import { formatWorkspaceRef, type WorkspaceRef } from '../../workspace/references/ref.js';
import type {
  DocumentClassification, DocumentPageKind, ParsedDocument, ParsedDocumentPage,
} from './types.js';

/** Bumped when the on-disk shape changes; an older file is ignored, not guessed at. */
export const DOCUMENT_ARTIFACT_VERSION = 1;

/** The mode this lives under in ADR-029's address space. */
export const DOCUMENT_MODE = 'document';

const FILE_NAME = 'document.json';

/**
 * The walls. Sized so the artifact for the largest document the parser will
 * touch (200 pages, `bounds.ts`) still fits comfortably, and so a hostile file
 * that inflates to something enormous is refused by a number rather than by the
 * filesystem running out of room.
 */
export const DOCUMENT_ARTIFACT_LIMITS = {
  /** Total characters kept across all parts. */
  maxChars: 400_000,
  /** One part's own budget — a single page cannot be the whole artifact. */
  maxPartChars: 12_000,
  /** Parts kept. Beyond this the outline counts what it dropped. */
  maxParts: 400,
  /** Chunk size used when the parse produced no page markers. */
  targetPartChars: 4_000,
} as const;

/**
 * Ids reach the filesystem, so they are checked before they do.
 *
 * The reference `brainrouter://document/part/<id>/<n>` is attacker-supplied — it
 * can be typed into a note, arrive in fetched page text, or be invented by a
 * model — and `<id>` becomes a path segment. The record lookup in the resolver
 * is the real gate, but a bounded allowlist here means a traversal attempt never
 * reaches `path.join` at all, on any caller's path, including one written later.
 */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `<!-- Page 7 -->`, and nothing else. Anchored, bounded, linear. */
const PAGE_MARKER = /^<!-- Page ([0-9]{1,7}) -->$/;

export interface DocumentPart {
  /** 1-based, and the thing the reference addresses. */
  index: number;
  /** The document page this part is — present only when the parse said so. */
  page?: number;
  /** What that page is (D3), when a page was identified. */
  kind?: DocumentPageKind;
  /** The part's own text. UNTRUSTED: this is the document talking. */
  text: string;
  /** True when this part's text was cut to `maxPartChars`. */
  truncated?: boolean;
}

export interface DocumentArtifact {
  version: number;
  attachmentId: string;
  /** The attachment's file name. UNTRUSTED — a person named this file. */
  name: string;
  classification: DocumentClassification;
  pageCount?: number;
  pages: ParsedDocumentPage[];
  /** Our sentence about the document (D3). Assembled from counts, never from content. */
  notice: string;
  parts: DocumentPart[];
  /** Parts the budget refused. Counted so the outline can say so. */
  partsOmitted: number;
  /** True when the parse itself was cut before it got here. */
  parseTruncated: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------- addressing */

export function documentOutlineRef(attachmentId: string): WorkspaceRef {
  return { mode: DOCUMENT_MODE, kind: 'outline', id: attachmentId };
}

export function documentPartRef(attachmentId: string, part: number): WorkspaceRef {
  return { mode: DOCUMENT_MODE, kind: 'part', id: `${attachmentId}/${part}` };
}

export function documentOutlineUri(attachmentId: string): string {
  return formatWorkspaceRef(documentOutlineRef(attachmentId));
}

/**
 * `att_1234/7` → the pair. Null when it is not one.
 *
 * A part id is two segments and the second is a positive integer. Anything else
 * — a float, a negative, a third segment, a number with a leading zero — is a
 * reference to nothing, and saying so at the parse is how the resolver never has
 * to decide what `part/att_x/0` means.
 */
export function parseDocumentPartId(id: string): { attachmentId: string; part: number } | null {
  const slash = id.lastIndexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  const attachmentId = id.slice(0, slash);
  const tail = id.slice(slash + 1);
  if (!ATTACHMENT_ID.test(attachmentId)) return null;
  if (!/^[1-9][0-9]{0,6}$/.test(tail)) return null;
  return { attachmentId, part: Number(tail) };
}

/* ---------------------------------------------------------------- storage */

/** Where the artifact for an attachment lives. Pure — creates nothing. */
export function documentArtifactPath(workspaceRoot: string, attachmentId: string): string | null {
  if (!ATTACHMENT_ID.test(attachmentId)) return null;
  return path.join(attachmentDirPath(workspaceRoot, attachmentId), FILE_NAME);
}

/**
 * Write the artifact beside the original bytes.
 *
 * Returns false rather than throwing. This runs on the ingest path, and an
 * artifact that could not be written must cost the attachment its addressable
 * parts, not its existence — the bounded extract is already on the record and
 * the turn is still correct without the rest, merely smaller.
 */
export function writeDocumentArtifact(workspaceRoot: string, artifact: DocumentArtifact): boolean {
  const file = documentArtifactPath(workspaceRoot, artifact.attachmentId);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(artifact), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read it back, or null.
 *
 * Defensive about its own file on purpose: it is JSON on a disk a person can
 * edit, it survives upgrades that change this shape, and it is read on a path
 * that ends in the agent's context. A file that is not exactly what this version
 * writes is treated as absent, which is a state every caller already handles.
 */
export function readDocumentArtifact(
  workspaceRoot: string,
  attachmentId: string,
): DocumentArtifact | null {
  const file = documentArtifactPath(workspaceRoot, attachmentId);
  if (!file) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // A file bigger than the budget that wrote it did not come from here.
  if (raw.length > DOCUMENT_ARTIFACT_LIMITS.maxChars * 4) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return asArtifact(parsed, attachmentId);
}

// There is deliberately no `deleteDocumentArtifact`. The artifact lives in the
// attachment's own directory, and `deleteAttachment` removes that directory
// whole — a second delete would be a second lifecycle to keep in step, and the
// first symptom of them drifting is a parsed document outliving the file it was
// parsed from.

function asArtifact(value: unknown, attachmentId: string): DocumentArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== DOCUMENT_ARTIFACT_VERSION) return null;
  if (raw.attachmentId !== attachmentId) return null;
  if (!Array.isArray(raw.parts)) return null;

  const parts: DocumentPart[] = [];
  for (const entry of raw.parts.slice(0, DOCUMENT_ARTIFACT_LIMITS.maxParts)) {
    if (!entry || typeof entry !== 'object') continue;
    const part = entry as Record<string, unknown>;
    if (typeof part.index !== 'number' || typeof part.text !== 'string') continue;
    parts.push({
      index: part.index,
      text: part.text.slice(0, DOCUMENT_ARTIFACT_LIMITS.maxPartChars),
      ...(typeof part.page === 'number' ? { page: part.page } : {}),
      ...(typeof part.kind === 'string' ? { kind: part.kind as DocumentPageKind } : {}),
      ...(part.truncated === true ? { truncated: true } : {}),
    });
  }

  return {
    version: DOCUMENT_ARTIFACT_VERSION,
    attachmentId,
    name: typeof raw.name === 'string' ? raw.name : '',
    classification: typeof raw.classification === 'string'
      ? (raw.classification as DocumentClassification)
      : 'unreadable',
    ...(typeof raw.pageCount === 'number' ? { pageCount: raw.pageCount } : {}),
    pages: Array.isArray(raw.pages) ? (raw.pages as ParsedDocumentPage[]).filter(isPage) : [],
    notice: typeof raw.notice === 'string' ? raw.notice : '',
    parts,
    partsOmitted: typeof raw.partsOmitted === 'number' ? raw.partsOmitted : 0,
    parseTruncated: raw.parseTruncated === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

function isPage(value: unknown): value is ParsedDocumentPage {
  return !!value && typeof value === 'object'
    && typeof (value as ParsedDocumentPage).index === 'number'
    && typeof (value as ParsedDocumentPage).kind === 'string';
}

/* ---------------------------------------------------------------- building */

export interface BuildDocumentArtifactInput {
  attachmentId: string;
  name: string;
  parsed: ParsedDocument;
  nowMs?: number;
}

/** Turn one parse into the stored artifact. Pure — the caller writes it. */
export function buildDocumentArtifact(input: BuildDocumentArtifactInput): DocumentArtifact {
  const { parsed } = input;
  const kindByPage = new Map(parsed.pages.map((page) => [page.index, page.kind]));
  const split = splitDocumentParts(parsed.markdown, kindByPage);
  return {
    version: DOCUMENT_ARTIFACT_VERSION,
    attachmentId: input.attachmentId,
    name: input.name,
    classification: parsed.classification,
    ...(parsed.pageCount !== undefined ? { pageCount: parsed.pageCount } : {}),
    pages: [...parsed.pages],
    notice: parsed.notice,
    parts: split.parts,
    partsOmitted: split.omitted,
    parseTruncated: parsed.truncated,
    createdAt: new Date(input.nowMs ?? Date.now()).toISOString(),
  };
}

/**
 * The split, and the reason it is one function rather than two.
 *
 * Both engines' text arrives here and the difference between them is one
 * predicate — whether a line is a page marker. Two code paths would drift, and
 * the drift would show up as the baseline's parts claiming page numbers on the
 * day someone made the marker optional.
 *
 * Single pass over the lines, no backtracking, no accumulation of a string that
 * is later re-scanned: the input is a document an attacker chose the shape of,
 * and a 100,000-line file of nothing but page markers costs one pass.
 */
export function splitDocumentParts(
  markdown: string,
  kindByPage: ReadonlyMap<number, DocumentPageKind>,
): { parts: DocumentPart[]; omitted: number } {
  const limits = DOCUMENT_ARTIFACT_LIMITS;
  const parts: DocumentPart[] = [];
  let omitted = 0;
  let budget = limits.maxChars;

  let buffer: string[] = [];
  let bufferChars = 0;
  let page: number | undefined;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    bufferChars = 0;
    if (!text) return;
    if (parts.length >= limits.maxParts || budget <= 0) {
      omitted += 1;
      return;
    }
    const room = Math.min(limits.maxPartChars, budget);
    const cut = text.length > room;
    const body = cut ? text.slice(0, room) : text;
    budget -= body.length;
    const kind = page !== undefined ? kindByPage.get(page) : undefined;
    parts.push({
      index: parts.length + 1,
      ...(page !== undefined ? { page } : {}),
      ...(kind !== undefined ? { kind } : {}),
      text: body,
      ...(cut ? { truncated: true } : {}),
    });
  };

  for (const line of markdown.split('\n')) {
    const marker = PAGE_MARKER.exec(line);
    if (marker) {
      flush();
      page = Number(marker[1]);
      continue;
    }
    // Without markers a part is a run of paragraphs, broken at the first blank
    // line past the target size — never mid-sentence, which would make the last
    // line of one part and the first of the next both unreadable.
    if (page === undefined && bufferChars >= limits.targetPartChars && line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
    bufferChars += line.length + 1;
  }
  flush();

  return { parts, omitted };
}

/* -------------------------------------------------------------- projection */

/**
 * What a resolved reference hands back.
 *
 * Tagged rather than shape-sniffed. The renderer in
 * `workspace/participants/agentContext.ts` has to tell these apart from a note
 * block's context, and a structural guess ("it has `text`, so it must be…") is
 * how the wrong renderer runs on the day a third mode grows a `text` field.
 */
export interface DocumentOutlineState {
  documentOutline: {
    name: string;
    classification: DocumentClassification;
    pageCount?: number;
    partCount: number;
    /** Our sentence about the document. Assembled from counts, never from content. */
    notice: string;
    parts: Array<{
      uri: string;
      index: number;
      page?: number;
      kind?: DocumentPageKind;
      chars: number;
      /** The part's first line, so the list is navigable rather than numeric. */
      preview: string;
    }>;
    /** Present when the artifact's budget refused parts. */
    omittedLabel?: string;
  };
}

export interface DocumentPartState {
  documentPart: {
    name: string;
    index: number;
    partCount: number;
    page?: number;
    kind?: DocumentPageKind;
    text: string;
    truncated?: boolean;
    /** The neighbours, so reading on does not need a second outline round-trip. */
    nextUri?: string;
    previousUri?: string;
  };
}

/** How much of a part's first line the outline shows. A line, not a paragraph. */
const PREVIEW_CHARS = 100;

export function documentOutlineState(artifact: DocumentArtifact): DocumentOutlineState {
  const outline: DocumentOutlineState['documentOutline'] = {
    name: artifact.name,
    classification: artifact.classification,
    ...(artifact.pageCount !== undefined ? { pageCount: artifact.pageCount } : {}),
    partCount: artifact.parts.length,
    notice: artifact.notice,
    parts: artifact.parts.map((part) => ({
      uri: formatWorkspaceRef(documentPartRef(artifact.attachmentId, part.index)),
      index: part.index,
      ...(part.page !== undefined ? { page: part.page } : {}),
      ...(part.kind !== undefined ? { kind: part.kind } : {}),
      chars: part.text.length,
      preview: firstLine(part.text).slice(0, PREVIEW_CHARS),
    })),
  };
  if (artifact.partsOmitted > 0) {
    outline.omittedLabel = `${artifact.partsOmitted} more part${artifact.partsOmitted === 1 ? '' : 's'} `
      + 'were not kept: the document is larger than this store holds';
  } else if (artifact.parseTruncated) {
    outline.omittedLabel = 'the parse itself stopped at its character budget, '
      + 'so the end of the document is not here';
  }
  return { documentOutline: outline };
}

export function documentPartState(
  artifact: DocumentArtifact,
  part: DocumentPart,
): DocumentPartState {
  const state: DocumentPartState['documentPart'] = {
    name: artifact.name,
    index: part.index,
    partCount: artifact.parts.length,
    ...(part.page !== undefined ? { page: part.page } : {}),
    ...(part.kind !== undefined ? { kind: part.kind } : {}),
    text: part.text,
    ...(part.truncated ? { truncated: true } : {}),
  };
  if (part.index < artifact.parts.length) {
    state.nextUri = formatWorkspaceRef(documentPartRef(artifact.attachmentId, part.index + 1));
  }
  if (part.index > 1) {
    state.previousUri = formatWorkspaceRef(documentPartRef(artifact.attachmentId, part.index - 1));
  }
  return { documentPart: state };
}

/**
 * The label a part or an outline renders as inline.
 *
 * Says the PAGE when there is one and the part number when there is not, which
 * is the same honesty rule the split follows: never name a page the parse did
 * not identify.
 */
export function documentPartLabel(artifact: DocumentArtifact, part: DocumentPart): string {
  const where = part.page !== undefined
    ? `page ${part.page}`
    : `part ${part.index} of ${artifact.parts.length}`;
  const kind = part.kind && part.kind !== 'text' ? ` (${part.kind}, no text layer)` : '';
  return `${artifact.name} — ${where}${kind}`;
}

export function documentOutlineLabel(artifact: DocumentArtifact): string {
  const pages = artifact.pageCount !== undefined
    ? `${artifact.pageCount} page${artifact.pageCount === 1 ? '' : 's'}`
    : `${artifact.parts.length} part${artifact.parts.length === 1 ? '' : 's'}`;
  return `${artifact.name} — ${artifact.classification} document, ${pages}`;
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
