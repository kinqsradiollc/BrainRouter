/**
 * PDF-TEXT (0.4.15) — best-effort, dependency-free PDF text + page extraction.
 *
 * Real-world PDFs are a mess: most content streams are FlateDecode-compressed,
 * which we cannot inflate without a dependency. This module makes a pragmatic,
 * never-throwing attempt:
 *   - `pageCount` from `/Type /Page` objects (falling back to `/Count <n>`).
 *   - `text` from string literals shown by the `Tj` / `TJ` text operators
 *     inside `BT`…`ET` blocks of *uncompressed* content streams; when nothing
 *     usable is found, it falls back to printable ASCII runs harvested from the
 *     text-ish regions of the file.
 *
 * Feeds `AttachmentRecord.extractedText` / `.textTruncated` / `.pageCount`.
 * Output is capped to `maxChars` (default 20000). No `fs`, no network. If no
 * sensible text can be recovered, `text` is `''`. Never throws.
 */

export interface PdfExtract {
  /** Number of pages, when it could be determined. */
  pageCount?: number;
  /** Extracted (best-effort) plain text. Empty string when nothing usable. */
  text: string;
  /** Whether `text` was truncated to the `maxChars` cap. */
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 20000;

/** Decode a PDF string-literal body, resolving PDF escape sequences. */
function unescapePdfLiteral(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break; // trailing backslash — drop it
    switch (next) {
      case 'n':
        out += '\n';
        i++;
        break;
      case 'r':
        out += '\r';
        i++;
        break;
      case 't':
        out += '\t';
        i++;
        break;
      case 'b':
        out += '\b';
        i++;
        break;
      case 'f':
        out += '\f';
        i++;
        break;
      case '(':
        out += '(';
        i++;
        break;
      case ')':
        out += ')';
        i++;
        break;
      case '\\':
        out += '\\';
        i++;
        break;
      case '\n':
        // Line continuation — backslash + newline collapses to nothing.
        i++;
        break;
      case '\r':
        i++;
        if (body[i + 1] === '\n') i++;
        break;
      default:
        if (next >= '0' && next <= '7') {
          // Octal escape: up to 3 octal digits.
          let oct = '';
          let j = i + 1;
          while (j < body.length && oct.length < 3 && body[j] >= '0' && body[j] <= '7') {
            oct += body[j];
            j++;
          }
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = j - 1;
        } else {
          // Unknown escape — the spec says drop the backslash, keep the char.
          out += next;
          i++;
        }
        break;
    }
  }
  return out;
}

/**
 * Scan a string-literal that begins at `open` (the index of '(') and return its
 * body (without the surrounding parens) plus the index just past the closing
 * ')'. Honors balanced inner parens and backslash escapes. Returns `null` if
 * the literal is unterminated.
 */
function readLiteral(src: string, open: number): { body: string; end: number } | null {
  let depth = 1;
  let i = open + 1;
  let body = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      // Keep the escape pair verbatim; unescaping happens later.
      body += ch;
      if (i + 1 < src.length) body += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      body += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { body, end: i + 1 };
      body += ch;
      i++;
      continue;
    }
    body += ch;
    i++;
  }
  return null; // unterminated
}

/** Count `/Type /Page` objects (per-page), excluding the `/Pages` tree node. */
function countPageObjects(src: string): number {
  // Match `/Type` then optional whitespace then `/Page` NOT followed by a
  // letter (so `/Pages` is excluded). PDFs may also write `/Page/Type`-style
  // dictionaries, but `/Type /Page` is overwhelmingly the common form.
  const re = /\/Type\s*\/Page(?![a-zA-Z])/g;
  let count = 0;
  while (re.exec(src) !== null) count++;
  return count;
}

/** Read the first `/Count <n>` integer (the page-tree count), if present. */
function firstCount(src: string): number | undefined {
  const m = /\/Count\s+(\d+)/.exec(src);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull text from `Tj` / `TJ` operators across the whole latin1 source. We scan
 * every parenthesized literal and decide, by looking at what follows it,
 * whether it is being shown:
 *   - `(...) Tj`               → a single shown string
 *   - `[(...) -250 (...)] TJ`  → array show; each literal contributes
 * To keep things dependency-free and robust we collect any literal that is
 * eventually followed (allowing array glue: numbers, whitespace, more
 * literals) by a `Tj` or `TJ` operator.
 */
function extractShownText(src: string): string {
  const pieces: string[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch !== '(') {
      i++;
      continue;
    }
    const lit = readLiteral(src, i);
    if (!lit) {
      // Unterminated literal — stop trying to parse structurally.
      break;
    }
    // Look ahead past array glue to see whether a show operator follows.
    let j = lit.end;
    let sawShow = false;
    // Allow a bounded look-ahead window so we do not walk the whole file.
    const limit = Math.min(src.length, lit.end + 4096);
    while (j < limit) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ']' || c === '[') {
        j++;
        continue;
      }
      if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
        // Numeric kerning value inside a TJ array.
        j++;
        continue;
      }
      if (c === '(') {
        // Another literal in the same array — this one is shown too.
        sawShow = true;
        break;
      }
      if (c === 'T' && (src[j + 1] === 'j' || src[j + 1] === 'J')) {
        sawShow = true;
        break;
      }
      // Anything else means this literal is not part of a show sequence.
      break;
    }

    if (sawShow) {
      const text = unescapePdfLiteral(lit.body);
      if (text.length > 0) pieces.push(text);
    }
    i = lit.end;
  }

  // Join: glue adjacent fragments, but treat ones that already contain
  // newlines as paragraph-ish. A single space between fragments reads best for
  // the common "one literal per word/line" case.
  return pieces.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Fallback: harvest printable ASCII runs (length ≥ 4) that look like prose,
 * skipping the obviously binary / structural noise. Used when no `Tj`/`TJ`
 * text could be recovered (e.g. fully FlateDecode-compressed content).
 */
function harvestPrintable(src: string): string {
  const runs: string[] = [];
  let cur = '';
  const flush = () => {
    const trimmed = cur.trim();
    // Require length and at least one ASCII letter so we skip pure punctuation
    // / number noise that litters PDF cross-reference tables.
    if (trimmed.length >= 4 && /[A-Za-z]/.test(trimmed)) runs.push(trimmed);
    cur = '';
  };
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    const printable = (code >= 0x20 && code <= 0x7e) || code === 0x09;
    if (printable) {
      cur += src[i];
    } else {
      flush();
    }
  }
  flush();

  // Drop runs that are clearly PDF structure rather than document prose.
  const skip = /^(obj|endobj|stream|endstream|xref|trailer|startxref|%PDF|%%EOF)\b/;
  const looksStructural = (s: string) =>
    skip.test(s) ||
    // A run dominated by slashes/angle-brackets is dictionary syntax.
    (s.split(/[/<>\[\]{}]/).length - 1) > Math.max(2, s.length / 8);

  const kept = runs.filter((r) => !looksStructural(r));
  return kept.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Extract page count and best-effort text from a PDF buffer.
 *
 * Decodes as latin1, counts `/Type /Page` objects (or the first `/Count`),
 * pulls `Tj`/`TJ` string literals from uncompressed content, and falls back to
 * printable-ASCII harvesting when the streams are compressed. The text is
 * capped at `opts.maxChars` (default 20000) with `truncated` set accordingly.
 * Always returns a value — never throws. Empty/garbage input yields
 * `{ text: '', truncated: false }`.
 */
export function extractPdf(buf: Buffer, opts?: { maxChars?: number }): PdfExtract {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;

  if (!buf || buf.length === 0) {
    return { text: '', truncated: false };
  }

  let src: string;
  try {
    src = buf.toString('latin1');
  } catch {
    return { text: '', truncated: false };
  }

  // --- page count ---------------------------------------------------------
  let pageCount: number | undefined;
  try {
    const pages = countPageObjects(src);
    if (pages > 0) {
      pageCount = pages;
    } else {
      pageCount = firstCount(src);
    }
  } catch {
    pageCount = undefined;
  }

  // --- text ---------------------------------------------------------------
  let text = '';
  try {
    text = extractShownText(src);
    if (text.length === 0) {
      text = harvestPrintable(src);
    }
  } catch {
    text = '';
  }

  // Cap the (possibly very large) harvested text.
  let truncated = false;
  if (maxChars >= 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  const result: PdfExtract = { text, truncated };
  if (pageCount !== undefined) result.pageCount = pageCount;
  return result;
}
