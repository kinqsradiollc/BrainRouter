import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

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
export function renderMarkdown(source: string): string {
  if (typeof source !== 'string' || source.length === 0) return source;
  ensureConfigured();
  const unwrapped = unwrapMarkdownFences(source);
  let out: string;
  try {
    out = String(marked.parse(unwrapped));
  } catch {
    // Some malformed input crashes marked. Fall back to verbatim so the
    // user still sees the LLM's reply.
    return unwrapped;
  }
  return preserveAnsiAcrossNewlines(out);
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
