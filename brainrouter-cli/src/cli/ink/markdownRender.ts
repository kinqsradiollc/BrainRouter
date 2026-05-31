import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

/**
 * Configure `marked` + `marked-terminal` for the Ink chat REPL, then
 * expose a `renderMarkdown(text)` helper that:
 *
 *   1. **Unwraps `` ```md `` / `` ```markdown `` fences** that LLMs
 *      sometimes wrap a whole response in (or wrap a table in to
 *      get it past their own safety filters). Without unwrapping,
 *      the entire content renders as a yellow code block instead of
 *      formatted markdown.
 *
 *   2. **Disables marked-terminal's internal wrapping** so Ink owns
 *      reflow. marked-terminal's `width` wrap doesn't understand the
 *      surrounding flex layout (the chat is rendered inside a flex
 *      Box that subtracts ~2 cols for the `⏺ ` prefix) so its wrap
 *      points are always wrong. Letting Ink wrap means the width is
 *      always correct.
 *
 *   3. **Preserves ANSI styling across newlines** — marked-terminal
 *      emits a single open/close ANSI scope per block (e.g. a
 *      blockquote is `\x1b[90m\x1b[3m...content with \n in
 *      it...\x1b[39m\x1b[23m`), so when Ink's wrap-ansi splits at the
 *      newlines, lines 2+ lose their style. We post-process the
 *      output to close active codes before each `\n` and reopen them
 *      after, so every rendered line is a self-contained ANSI scope.
 *
 *   4. **Stronger visual hierarchy** — h1 is bold cyan, h2+ bold,
 *      inline code yellow, fenced code dim-yellow, blockquote
 *      gray-italic, links cyan-underline, hr dim-gray. Defaults gave
 *      headings all the same color (green bold) which made nested
 *      sections impossible to scan.
 */

// `marked.use` registers an extension globally on the `marked` singleton.
// Both the readline REPL (cli/repl.ts) and this Ink path import marked;
// the LAST registration wins for renderer overrides. We register here at
// module-load and ChatApp.tsx imports `renderMarkdown` from this file, so
// any caller that imports this module gets the Ink-friendly config.
let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  marked.use(
    markedTerminal({
      showSectionPrefix: false,
      reflowText: false,
      // Effectively disable marked-terminal's own wrapping — Ink reflows
      // the rendered string inside its flex layout, which knows the real
      // available width.
      width: Number.MAX_SAFE_INTEGER,
      // 2-space indent matches the composer / scrollback prefix width.
      tab: 2,
      // Visual style overrides — see module docstring.
      firstHeading: chalk.bold.cyan,
      heading: chalk.bold,
      code: chalk.dim.yellow,
      codespan: chalk.yellow,
      blockquote: chalk.gray.italic,
      strong: chalk.bold,
      em: chalk.italic,
      link: chalk.cyan.underline,
      href: chalk.cyan,
      hr: chalk.gray.dim,
    }) as any,
  );
}

/**
 * Render markdown source to ANSI-styled terminal text suitable for an
 * Ink `<Text>` element. Idempotent across calls (configures `marked`
 * lazily on the first invocation).
 *
 * Empty / non-string input returns the input verbatim.
 */
export function renderMarkdown(source: string, opts?: { width?: number }): string {
  if (typeof source !== 'string' || source.length === 0) return source;
  ensureConfigured();
  const unwrapped = unwrapMarkdownFences(source);
  // marked-terminal renders GFM tables as a fixed-width cli-table3 grid that
  // overflows narrow terminals; Ink then wraps each row mid-cell and mangles
  // the grid. So we OWN table rendering: split the source into table and
  // non-table segments, render tables ourselves at the real terminal width,
  // and pass everything else through marked unchanged. When there's no table
  // the whole source is a single segment → byte-identical to the old path.
  const width = Math.max(20, Math.floor(opts?.width ?? (process.stdout.columns || 80)));
  const segments = extractMarkdownSegments(unwrapped);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.type === 'table') {
      out.push(renderTable(seg.text, width));
      continue;
    }
    try {
      out.push(preserveAnsiAcrossNewlines(String(marked.parse(seg.text))));
    } catch {
      // Some malformed input crashes marked. Fall back to verbatim so the
      // user still sees the LLM's reply.
      out.push(seg.text);
    }
  }
  return out.join('');
}

// --- GFM table rendering ----------------------------------------------

export type MarkdownSegment = { type: 'md' | 'table'; text: string };

/** A GFM separator row: `| --- | :--: | ---: |` (pipes optional at ends). */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line) || /^\s*\|\s*:?-{1,}:?\s*\|\s*$/.test(line);
}

/** A plausible table row: contains a pipe and isn't blank. */
function looksLikeTableRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/**
 * Split markdown into ordered table / non-table segments. A table is a row
 * line immediately followed by a separator line, plus the contiguous pipe
 * rows after it. Everything else accumulates into `md` segments. Exported for
 * tests.
 */
export function extractMarkdownSegments(source: string): MarkdownSegment[] {
  const lines = source.split('\n');
  const segs: MarkdownSegment[] = [];
  let buf: string[] = [];
  const flushMd = () => { if (buf.length) { segs.push({ type: 'md', text: buf.join('\n') }); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushMd();
      const tbl = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && looksLikeTableRow(lines[j])) { tbl.push(lines[j]); j++; }
      segs.push({ type: 'table', text: tbl.join('\n') });
      i = j - 1;
    } else {
      buf.push(lines[i]);
    }
  }
  flushMd();
  return segs.length ? segs : [{ type: 'md', text: source }];
}

type Align = 'left' | 'center' | 'right';

/**
 * Distribute `avail` columns across cells by water-filling: process columns
 * narrowest-first, giving each its natural width when it fits within an even
 * share of the remaining budget, otherwise capping it (min 3) and letting the
 * leftover flow to the still-wide columns. Exported for tests.
 */
export function fitColumns(natural: number[], avail: number): number[] {
  const n = natural.length;
  if (n === 0) return [];
  if (natural.reduce((a, b) => a + b, 0) <= avail) return natural.slice();
  const result = new Array<number>(n).fill(0);
  const order = [...natural.keys()].sort((a, b) => natural[a] - natural[b]);
  let remaining = avail;
  let colsLeft = n;
  for (const idx of order) {
    const fair = Math.floor(remaining / colsLeft);
    result[idx] = natural[idx] <= fair ? natural[idx] : Math.max(3, fair);
    remaining -= result[idx];
    colsLeft--;
  }
  return result;
}

/** Split one `| a | b |` row into trimmed cells (drops the outer pipes). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on unescaped pipes.
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function alignFor(sep: string): Align {
  const t = sep.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** Pad an ANSI-styled string to `w` display columns honouring alignment. */
function padCell(s: string, w: number, align: Align): string {
  const gap = Math.max(0, w - stringWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l); }
  return s + ' '.repeat(gap);
}

/**
 * Render a GFM table to an ANSI box that fits `width` columns. Cells are
 * inline-rendered (bold/code/links), header is bold, content wraps inside its
 * column (ANSI-aware), and columns shrink proportionally when the natural
 * layout would overflow. Each emitted line is a self-contained ANSI scope, so
 * Ink can wrap the block without breaking styling. Exported for tests.
 */
export function renderTable(tableSource: string, width: number): string {
  ensureConfigured();
  const rows = tableSource.split('\n').filter((l) => l.trim() !== '');
  if (rows.length < 2) return tableSource;
  const headerCells = splitRow(rows[0]);
  const aligns = splitRow(rows[1]).map(alignFor);
  const bodyCells = rows.slice(2).map(splitRow);
  const ncols = headerCells.length;
  if (ncols === 0) return tableSource;

  const inline = (s: string): string => {
    try { return String(marked.parseInline(s)).trim(); } catch { return s; }
  };
  const header = headerCells.map((c) => chalk.bold(inline(c)));
  const body = bodyCells.map((r) =>
    Array.from({ length: ncols }, (_, c) => inline(r[c] ?? '')),
  );
  const colAlign = Array.from({ length: ncols }, (_, c) => aligns[c] ?? 'left');

  // Natural width per column = widest rendered cell.
  const natural = Array.from({ length: ncols }, (_, c) =>
    Math.max(1, stringWidth(header[c] ?? ''), ...body.map((r) => stringWidth(r[c] ?? ''))),
  );
  // Budget: borders (ncols+1) + 1-space padding each side of every cell.
  const chrome = (ncols + 1) + ncols * 2;
  const avail = Math.max(ncols * 3, width - chrome);
  // Water-fill: narrow columns keep their natural width; only columns wider
  // than their fair share of the remaining budget get shrunk (min 3). This
  // avoids squishing a "Name" column just because a sibling "Notes" column is
  // long — the long one absorbs the deficit instead.
  const colW = fitColumns(natural, avail);

  const wrapCell = (s: string, w: number): string[] => {
    const wrapped = wrapAnsi(s, w, { hard: true, trim: false });
    return wrapped.length ? wrapped.split('\n') : [''];
  };

  const dim = (s: string) => chalk.gray.dim(s);
  const bar = (l: string, mid: string, r: string) =>
    dim(l + colW.map((w) => '─'.repeat(w + 2)).join(mid) + r);

  const renderRow = (cells: string[]): string[] => {
    const wrapped = cells.map((cell, c) => wrapCell(cell, colW[c]));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let line = 0; line < height; line++) {
      const cols = wrapped.map((w, c) => ` ${padCell(w[line] ?? '', colW[c], colAlign[c])} `);
      out.push(dim('│') + cols.join(dim('│')) + dim('│'));
    }
    return out;
  };

  const lines: string[] = [];
  lines.push(bar('┌', '┬', '┐'));
  lines.push(...renderRow(header));
  lines.push(bar('├', '┼', '┤'));
  for (const r of body) lines.push(...renderRow(r));
  lines.push(bar('└', '┴', '┘'));
  return lines.join('\n') + '\n';
}

/**
 * Strip a single outer ``` markdown / ``` md fence pair when it wraps the
 * entire input. Some LLMs (especially when asked to "format your reply
 * in markdown") emit the whole response inside ``` markdown ... ``` —
 * which then renders as a single yellow code block instead of formatted
 * text. Direct port of codex's helper (markdown.rs:86–123).
 *
 * Also strips fences around tables — LLMs sometimes wrap tables in ``` md
 * to "protect" the pipe characters, but marked then renders the table
 * as code instead of as a native table.
 *
 * Exported for tests; the renderMarkdown caller chains this in.
 */
export function unwrapMarkdownFences(source: string): string {
  const trimmed = source.trimEnd();
  const lines = trimmed.split('\n');
  // Outer wrap case: first line is ```md / ```markdown, last line is ```.
  if (lines.length >= 2) {
    const first = lines[0].trim().toLowerCase();
    const last = lines[lines.length - 1].trim();
    if ((first === '```md' || first === '```markdown') && last === '```') {
      return lines.slice(1, -1).join('\n');
    }
  }
  return source;
}

// --- ANSI preservation ------------------------------------------------

// SGR (Select Graphic Rendition) escape sequence: ESC [ <params> m.
// Capture the param list so we can parse it into individual codes.
const ANSI_SGR_REGEX = /\x1b\[([0-9;]*)m/g;

// Closing-attribute codes — when we see one, drop the matching attr
// from active state.  (22 closes both 1=bold and 2=dim.)
const ATTR_CLOSE_TO_OPENS = new Map<string, string[]>([
  ['22', ['1', '2']],
  ['23', ['3']],
  ['24', ['4']],
  ['25', ['5']],
  ['27', ['7']],
  ['28', ['8']],
  ['29', ['9']],
]);

const ATTR_OPENS = new Set(['1', '2', '3', '4', '5', '7', '8', '9']);

function isForegroundOpen(p: string): boolean {
  // 30–37 standard FG, 90–97 bright FG.
  const n = Number(p);
  return (n >= 30 && n <= 37) || (n >= 90 && n <= 97);
}
function isBackgroundOpen(p: string): boolean {
  // 40–47 standard BG, 100–107 bright BG.
  const n = Number(p);
  return (n >= 40 && n <= 47) || (n >= 100 && n <= 107);
}

/**
 * Re-scope ANSI styling across newline boundaries so each rendered line
 * carries its own complete open/close pair.
 *
 * Walks the input as a stream of segments — plain text, ANSI SGR
 * sequences, and `\n` — maintaining a small state machine of active
 * styles (foreground color, background color, set of attribute flags).
 * At every `\n`, emit a "close everything currently open" sequence,
 * then the newline, then a "reopen everything that was open" sequence.
 *
 * Edge cases handled:
 *   - 256-color (38;5;N) and truecolor (38;2;R;G;B) sequences — treated
 *     as opaque opening codes, replayed verbatim
 *   - `0` / empty params reset all state
 *   - already-empty active state at a newline → emit just the newline
 *
 * Exported for tests.
 */
export function preserveAnsiAcrossNewlines(text: string): string {
  if (!text.includes('\n') || !text.includes('\x1b[')) return text;
  // Active style state.
  let fg: string | null = null;      // e.g. "32" or "38;5;208"
  let bg: string | null = null;      // e.g. "42" or "48;2;100;150;200"
  const attrs = new Set<string>();   // "1", "2", "3", etc.

  const buildSgr = (parts: string[]): string => parts.length ? `\x1b[${parts.join(';')}m` : '';
  const buildClose = (): string => {
    const parts: string[] = [];
    if (fg) parts.push('39');
    if (bg) parts.push('49');
    for (const a of attrs) {
      // Pick the close code that matches.
      for (const [closeCode, opens] of ATTR_CLOSE_TO_OPENS) {
        if (opens.includes(a)) { parts.push(closeCode); break; }
      }
    }
    return buildSgr(parts);
  };
  const buildReopen = (): string => {
    const parts: string[] = [];
    if (fg) parts.push(fg);
    if (bg) parts.push(bg);
    for (const a of attrs) parts.push(a);
    return buildSgr(parts);
  };

  // Walk the text. We use a fresh regex with `lastIndex` since ANSI_SGR_REGEX
  // is module-level and stateful.
  const re = /\x1b\[([0-9;]*)m|\n/g;
  let i = 0;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Emit any plain text leading up to the match.
    if (m.index > i) out += text.slice(i, m.index);
    if (m[0] === '\n') {
      // Close active codes, newline, reopen.
      out += buildClose() + '\n' + buildReopen();
    } else {
      // SGR sequence — update state and pass through verbatim.
      const params = m[1].split(';');
      // 256-color / truecolor: 38;5;N and 38;2;R;G;B are foreground;
      // 48;5;N and 48;2;R;G;B are background. Handle by joining the
      // surrounding params into one logical fg/bg code.
      let j = 0;
      while (j < params.length) {
        const p = params[j];
        if (p === '0' || p === '') {
          fg = null; bg = null; attrs.clear();
          j++;
        } else if (p === '38' && params[j + 1] === '5' && params[j + 2] !== undefined) {
          fg = `38;5;${params[j + 2]}`;
          j += 3;
        } else if (p === '38' && params[j + 1] === '2' && params[j + 4] !== undefined) {
          fg = `38;2;${params[j + 2]};${params[j + 3]};${params[j + 4]}`;
          j += 5;
        } else if (p === '48' && params[j + 1] === '5' && params[j + 2] !== undefined) {
          bg = `48;5;${params[j + 2]}`;
          j += 3;
        } else if (p === '48' && params[j + 1] === '2' && params[j + 4] !== undefined) {
          bg = `48;2;${params[j + 2]};${params[j + 3]};${params[j + 4]}`;
          j += 5;
        } else if (p === '39') {
          fg = null; j++;
        } else if (p === '49') {
          bg = null; j++;
        } else if (ATTR_CLOSE_TO_OPENS.has(p)) {
          for (const open of ATTR_CLOSE_TO_OPENS.get(p)!) attrs.delete(open);
          j++;
        } else if (isForegroundOpen(p)) {
          fg = p; j++;
        } else if (isBackgroundOpen(p)) {
          bg = p; j++;
        } else if (ATTR_OPENS.has(p)) {
          attrs.add(p); j++;
        } else {
          j++;
        }
      }
      out += m[0];
    }
    i = m.index + m[0].length;
  }
  if (i < text.length) out += text.slice(i);
  return out;
}
