/**
 * ADR-030 D1 — positioned runs down to a string, for the callers that take one.
 *
 * This is deliberately the DUMB half of the job. Reading order for columns,
 * headings from size ratios and tables from alignment are all reconstruction
 * work that belongs to the layer above; all this does is put line breaks and
 * word gaps where the geometry says they are, in the order the page emitted
 * them, so the string is at worst honest about what it saw.
 *
 * The one thing it will not do is stay silent: a page whose runs were all
 * undecodable says so, because an empty page and a page we could not read are
 * different facts and the agent must not confuse them.
 */
import type { PdfDocumentExtract, PdfPageExtract, PdfTextItem } from './types.js';

/**
 * Prefix of the line emitted for a page whose text could not be decoded. The
 * routing layer keys on it when it decides what to tell the person.
 */
export const UNDECODABLE_NOTICE_PREFIX = '[unreadable page';

/** A vertical move larger than this fraction of the line height starts a new line. */
const LINE_BREAK_RATIO = 0.5;
/** A horizontal gap larger than this fraction of the glyph size is a word space. */
const WORD_GAP_RATIO = 0.2;

export function flattenDocument(doc: PdfDocumentExtract): string {
  const pages: string[] = [];
  for (const page of doc.pages) {
    const text = flattenPage(page);
    if (text.length > 0) pages.push(text);
  }
  return pages.join('\n\n').trim();
}

export function flattenPage(page: PdfPageExtract): string {
  let out = '';
  let previous: PdfTextItem | undefined;
  for (const item of page.items) {
    if (item.text.length === 0) {
      // An undecodable run still moves the pen; keeping it as the geometric
      // predecessor stops the NEXT run from being glued onto the last decoded one.
      previous = item;
      continue;
    }
    if (previous) out += separator(previous, item);
    out += item.text;
    previous = item;
  }
  const trimmed = collapse(out);
  if (trimmed.length > 0) return trimmed;
  if (page.undecodableRuns > 0) {
    return `${UNDECODABLE_NOTICE_PREFIX} ${page.index}: ${page.undecodableRuns} text run${
      page.undecodableRuns === 1 ? '' : 's'
    } use a font with no Unicode mapping, so the characters are not recoverable]`;
  }
  return '';
}

function separator(previous: PdfTextItem, item: PdfTextItem): string {
  const height = Math.max(previous.fontSize, item.fontSize, 1);
  if (Math.abs(item.y - previous.y) > height * LINE_BREAK_RATIO) return '\n';
  const gap = item.x - (previous.x + previous.width);
  if (gap < -height * LINE_BREAK_RATIO) return '\n'; // pen jumped backwards: a new line, or a column
  if (gap > height * WORD_GAP_RATIO) return ' ';
  return '';
}

/**
 * Tidy the joined text: no trailing spaces, no runs of blank lines, no control
 * characters. Everything here is a bounded single-pass replacement — this
 * string is attacker-controlled and a backtracking regex over it is a denial of
 * service with extra steps.
 */
function collapse(text: string): string {
  let out = '';
  let spaceRun = 0;
  let newlineRun = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\n') {
      newlineRun++;
      spaceRun = 0;
      if (newlineRun <= 2) out += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      spaceRun++;
      if (spaceRun === 1 && newlineRun === 0) out += ' ';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue; // stray control bytes are not text
    spaceRun = 0;
    newlineRun = 0;
    out += ch;
  }
  // Trim trailing whitespace per line without a regex: walk back over the tail.
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].trimEnd();
  return lines.join('\n').trim();
}
