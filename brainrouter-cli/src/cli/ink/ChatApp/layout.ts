// REFAC-CHATAPP-SPLIT (0.4.17) — pure scrollback-layout + height-estimation +
// palette-filter helpers, extracted verbatim from ChatApp.tsx. No React, no
// component state — just text/width math + markdown measurement. Unit-tested in
// isolation (scrollback-layout.test.ts, ink-chat.test.ts) and re-exported from
// ChatApp.tsx for back-compat with existing importers.
import { renderMarkdown } from '../text/markdownRender.js';
import { resolveTheme } from '../../theme/theme.js';
import { VERSION } from '@kinqs/brainrouter-core/version';
import type { SlashCommandDef } from '../prompt/SlashPalette.js';
import type { ScrollbackEntry, VisibleSlice } from './types.js';

export function seedScrollback(workspaceRoot: string | undefined, offline: string | undefined, hint: string): ScrollbackEntry[] {
  let id = 0;
  const next = (): number => ++id;
  const theme = resolveTheme(workspaceRoot);
  const welcomeText = theme.primary(`🧠 Welcome to BrainRouter CLI v${VERSION}\n\n`);
  const out: ScrollbackEntry[] = [{ id: next(), kind: 'raw', text: welcomeText, noWrap: true, timestamp: new Date() }];
  if (offline) out.push({ id: next(), kind: 'raw', text: offline, noWrap: true, timestamp: new Date() });
  out.push({ id: next(), kind: 'raw', text: hint, noWrap: true, timestamp: new Date() });
  return out;
}

export function estimateTextHeight(text: string, cols: number): number {
  if (!text) return 0;
  const lines = text.split('\n');
  let count = 0;
  for (const line of lines) {
    count += Math.max(1, Math.ceil(line.length / Math.max(1, cols)));
  }
  return count;
}

// Rows the chrome (header + composer + footer + spinner + scroll hint) reserves
// outside the scrollback area. The budget undershooting this is what let the
// scrollback overflow onto the composer/footer rows.
export const CHROME_RESERVED_ROWS = 10;

// Markdown height is measured by ACTUALLY rendering (mirrors ScrollbackRow) —
// the old raw-`\n` estimate ignored marked's list spacing / wrapping and
// undershot badly, which overflowed the frame. Cached + bounded (FIFO) so the
// per-render cost stays flat even while streaming re-runs the memo.
const _mdRenderCache = new Map<string, string>();
function renderMarkdownCached(text: string, width: number): string {
  const key = width + '\x00' + text;
  let rendered = _mdRenderCache.get(key);
  if (rendered === undefined) {
    rendered = renderMarkdown(text, { width }).trimEnd();
    if (_mdRenderCache.size >= 256) _mdRenderCache.delete(_mdRenderCache.keys().next().value as string);
    _mdRenderCache.set(key, rendered);
  }
  return rendered;
}

export function estimateEntryHeight(entry: ScrollbackEntry, cols: number, verbose = false): number {
  switch (entry.kind) {
    case 'raw':
    case 'user':
    case 'notice':
      return estimateTextHeight(entry.text ?? '', cols) + (entry.kind === 'user' ? 1 : 0);
    case 'assistant': {
      const text = entry.text ?? '';
      // Mirror the renderer: markdown rendered at width `cols-2`, then displayed
      // in a flexGrow column to the right of "⏺ " (+ optional timestamp). Re-wrap
      // at that narrower width so we OVER- rather than under-estimate.
      const rendered = entry.raw ? text : renderMarkdownCached(text, Math.max(1, cols - 2));
      const bodyWidth = Math.max(1, cols - (entry.timestamp ? 13 : 2));
      return 1 /* marginTop */ + estimateTextHeight(rendered, bodyWidth) + (entry.durationMs !== undefined ? 1 : 0);
    }
    case 'tool': {
      let h = 1;
      if (entry.preview) {
        const lines = entry.preview.split('\n').length;
        h += verbose ? lines : Math.min(8, lines);
        if (!verbose && lines > 8) h += 1;
      }
      return h + 1;
    }
    case 'memory':
      return 1;
    case 'plan':
      return 1 + (entry.explanation ? 1 : 0) + entry.items.length + 1;
    case 'agent-result': {
      // Body wraps (wrap="wrap") inside a paddingLeft={4} column.
      return 1 + estimateTextHeight(entry.body ?? '', Math.max(1, cols - 4));
    }
    case 'reasoning': {
      const rawLines = entry.text ? entry.text.split('\n') : [];
      const shown = rawLines.slice(0, verbose ? rawLines.length : 10).join('\n');
      const visible = estimateTextHeight(shown, Math.max(1, cols - 3)); // wraps inside a bordered column
      const hiddenExtra = rawLines.length > 10 ? 1 : 0;
      return 1 + visible + hiddenExtra + 1;
    }
    case 'child-fleet':
      return 1;
    case 'compaction': {
      // Renderer shows up to 8 summary lines, each wrapping inside a paddingLeft={3} column.
      const shown = entry.summary ? entry.summary.split('\n').slice(0, 8).join('\n') : '';
      return 1 + estimateTextHeight(shown, Math.max(1, cols - 3)) + 1;
    }
    default:
      return 1;
  }
}

/**
 * CC-P1.1 — LINE-level scrollback window. The window position (`lineOffset`)
 * counts VISUAL LINES from the bottom of history, so scrolling moves one line
 * at a time instead of jumping whole entries. Boundary entries are returned
 * with `clipTop`/`clipBottom` so the renderer can show just their visible rows
 * (fixed-height overflow:hidden wrappers). The packed window NEVER exceeds
 * `budget` rows, so it cannot spill onto the composer/footer chrome.
 * `lineOffset` is clamped internally; `totalLines` lets callers clamp keys.
 * Pure → tested.
 */
export function packVisibleLines<T>(
  entries: T[],
  opts: { budget: number; lineOffset: number; estimateHeight: (entry: T) => number },
): { slices: Array<VisibleSlice<T>>; hiddenLinesAbove: number; hiddenLinesBelow: number; totalLines: number } {
  const budget = Math.max(1, opts.budget);
  const heights = entries.map((e) => Math.max(1, opts.estimateHeight(e)));
  const totalLines = heights.reduce((n, h) => n + h, 0);
  const maxOffset = Math.max(0, totalLines - budget);
  const offset = Math.min(Math.max(0, opts.lineOffset), maxOffset);

  const slices: Array<VisibleSlice<T>> = [];
  let toSkip = offset; // lines below the window (scrolled past)
  let remaining = Math.min(budget, totalLines - offset);
  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const h = heights[i];
    if (toSkip >= h) { toSkip -= h; continue; } // entirely below the window
    const clipBottom = toSkip;
    toSkip = 0;
    const availableOfEntry = h - clipBottom;
    const used = Math.min(availableOfEntry, remaining);
    const clipTop = availableOfEntry - used;
    slices.unshift({ entry: entries[i], height: h, clipTop, clipBottom });
    remaining -= used;
  }
  const visible = Math.min(budget, totalLines - offset);
  return {
    slices,
    hiddenLinesAbove: Math.max(0, totalLines - offset - visible),
    hiddenLinesBelow: offset,
    totalLines,
  };
}

export function filterPaletteCommands(commands: SlashCommandDef[], query: string): SlashCommandDef[] {
  if (!query) return commands;
  const q = query.toLowerCase();
  const scored = commands
    .map((c, i) => {
      const body = c.cmd.slice(1).toLowerCase();
      let s = 3;
      if (body.startsWith(q)) s = 0;
      else if (body.includes(q)) s = 1;
      else if (c.description.toLowerCase().includes(q)) s = 2;
      return { c, i, s };
    })
    .filter((x) => x.s < 3);
  scored.sort((a, b) => (a.s - b.s) || (a.i - b.i));
  return scored.map((x) => x.c);
}
