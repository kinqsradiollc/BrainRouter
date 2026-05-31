/**
 * REFAC-CHATAPP-SPLIT (0.4.6) — pure reasoning-panel + footer-effort helpers,
 * extracted verbatim from ChatApp.tsx. No React, no other ChatApp deps — just
 * text/width math, so they unit-test in isolation. Re-exported from ChatApp.tsx
 * for back-compat with existing importers (tests + the main component).
 */

// Live reasoning is rendered as a fixed-height tail window; the full chain is
// preserved in the scrollback 'reasoning' entry on call-end. ~1.5 KB is roughly
// 20-30 lines on a typical 100-col terminal — live without overwhelming layout.
export const REASONING_TAIL_CHARS = 1500;

/**
 * Footer effort indicator (glyph + colour). claude-code-style ramp:
 *   low ○ · medium ◐ · high ● · xhigh ✦. `max` is the user alias for `xhigh`.
 * Returns an empty glyph for unknown/undefined so the footer hides it.
 * Pure + exported for tests.
 */
export function effortIndicator(effort?: string): { glyph: string; color: string } {
  const level = effort === 'max' ? 'xhigh' : effort;
  switch (level) {
    case 'xhigh': return { glyph: '✦', color: 'redBright' };
    case 'high': return { glyph: '●', color: 'magenta' };
    case 'medium': return { glyph: '◐', color: 'yellow' };
    case 'low': return { glyph: '○', color: 'gray' };
    default: return { glyph: '', color: 'gray' };
  }
}

export function tailReasoning(text: string): string {
  if (text.length <= REASONING_TAIL_CHARS) return text;
  // Cut at a word boundary near the start of the tail window so the
  // first visible character isn't a mid-word fragment.
  const slice = text.slice(text.length - REASONING_TAIL_CHARS);
  const firstSpace = slice.indexOf(' ');
  return '… ' + (firstSpace > 0 && firstSpace < 80 ? slice.slice(firstSpace + 1) : slice);
}

// Stable-height window for the LIVE reasoning panel. Without this, the
// dim-italic block grows line-by-line as the model thinks, pushing the
// composer downward; once the block exceeds the terminal viewport, the
// terminal itself scrolls ("keep scrolling while thinking" bug). The fix:
// render at a FIXED row count — wrap the tail to terminal width, keep only the
// last REASONING_VISIBLE_LINES wrapped lines, padding when fewer.
export const REASONING_VISIBLE_LINES = 6;

export function buildReasoningWindow(text: string, cols: number): string {
  if (!text) return '';
  // Wrap the visible tail to terminal width. We use a simple greedy
  // word-wrap; long unbroken tokens are hard-cut at `cols`. Account for
  // the paddingLeft={3} on the render Box, hence `cols - 4` (3 for
  // padding, 1 for safety/cursor).
  const width = Math.max(20, cols - 4);
  const wrapped: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') {
      wrapped.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if ((line + word).length <= width) {
        line += word;
      } else {
        if (line.trim()) wrapped.push(line.trimEnd());
        if (word.length > width) {
          // Hard-break very long tokens at width boundaries.
          for (let i = 0; i < word.length; i += width) {
            const chunk = word.slice(i, i + width);
            if (i + width >= word.length) {
              line = chunk;
            } else {
              wrapped.push(chunk);
            }
          }
        } else {
          line = word.trimStart();
        }
      }
    }
    if (line) wrapped.push(line);
  }
  // Keep only the last N lines.
  const tail = wrapped.slice(-REASONING_VISIBLE_LINES);
  return tail.join('\n');
}
