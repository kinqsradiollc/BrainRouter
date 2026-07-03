import { type Theme } from '../../theme/theme.js';
import { type PickerRow } from './types.js';

// --- Frame renderer ----------------------------------------------------

interface FrameInputs {
  theme: Theme;
  title: string;
  subtitle?: string;
  badge?: string;
  bodyLines: string[];
  previewLines?: string[];
  footer: string;
  width: number;
}

/**
 * Compute the full picker frame as a single string. Pure function so
 * tests can assert on the exact output without driving a TTY.
 *
 * Layout (single column for now — wide-terminal two-column comes in a
 * follow-up):
 *
 *   ┌─ <title> ─────────────────────── <badge> ─┐
 *   │ <subtitle>                                │
 *   │                                           │
 *   │ <body line 1>                             │
 *   │ <body line 2>                             │
 *   │ ...                                       │
 *   │                                           │  (preview block if present)
 *   │ <preview line 1>                          │
 *   │ <preview line 2>                          │
 *   │                                           │
 *   │ <footer>                                  │
 *   └───────────────────────────────────────────┘
 */
export function renderFrame(f: FrameInputs): string {
  const t = f.theme;
  const W = f.width;
  // Inner content width: W minus 2 border cols minus 2 padding cols.
  const inner = Math.max(20, W - 4);

  const top = renderTopBorder(t, f.title, f.badge, W);
  const lines: string[] = [top];

  if (f.subtitle) {
    for (const wrapped of wrap(f.subtitle, inner)) {
      lines.push(t.primary('│') + ' ' + t.muted(padRight(wrapped, inner)) + ' ' + t.primary('│'));
    }
    lines.push(blank(t, W));
  }

  for (const raw of f.bodyLines) {
    // Wrap is opt-out for body — the picker pre-formats option rows with
    // exact widths, so let those pass through verbatim.
    lines.push(t.primary('│') + ' ' + padRightVisible(raw, inner) + ' ' + t.primary('│'));
  }

  if (f.previewLines && f.previewLines.length > 0) {
    lines.push(divider(t, W));
    for (const raw of f.previewLines) {
      lines.push(t.primary('│') + ' ' + padRightVisible(raw, inner) + ' ' + t.primary('│'));
    }
  }

  lines.push(blank(t, W));
  lines.push(t.primary('│') + ' ' + padRightVisible(t.muted(f.footer), inner) + ' ' + t.primary('│'));
  lines.push(t.primary('└' + '─'.repeat(W - 2) + '┘'));

  return lines.join('\n');
}

function renderTopBorder(t: Theme, title: string, badge: string | undefined, W: number): string {
  const titleText = ` ${t.heading(title)} `;
  const badgeText = badge ? ` ${t.muted(badge)} ` : '';
  const titleWidth = visibleLength(titleText);
  const badgeWidth = visibleLength(badgeText);
  const dashWidth = Math.max(2, W - 2 - titleWidth - badgeWidth);
  return (
    t.primary('┌─') + titleText
    + t.primary('─'.repeat(dashWidth))
    + badgeText
    + t.primary('┐')
  );
}

function blank(t: Theme, W: number): string {
  return t.primary('│') + ' '.repeat(W - 2) + t.primary('│');
}
function divider(t: Theme, W: number): string {
  // Subtle in-frame separator — single dim line, no chars.
  return t.primary('├') + t.dim('─'.repeat(W - 2)) + t.primary('┤');
}

function padRight(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

/** ANSI-aware right-pad. Strips ANSI sequences when counting width. */
export function padRightVisible(s: string, w: number): string {
  const v = visibleLength(s);
  if (v >= w) return clipVisible(s, w);
  return s + ' '.repeat(w - v);
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
function clipVisible(s: string, w: number): string {
  // Naive ANSI-aware clip — used only for badge / overflow protection.
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end < 0) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += s[i];
    i++;
    visible++;
  }
  return out;
}

/** Simple word-wrap; doesn't try to be ANSI-aware (subtitle takes plain text). */
export function wrap(s: string, w: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= w) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

// --- Body row formatting ----------------------------------------------

interface FormattedRow {
  selected: boolean;
  text: string;
  description?: string;
}

export function formatBodyRow(t: Theme, row: PickerRow, isSelected: boolean, valueColWidth: number, inner: number): string[] {
  // Selected glyph: `›`
  // (we use ▶ in the LLM-tool picker; switch to › for the internal picker
  // because it reads cleaner against the chalk gray + bold combo).
  const marker = isSelected ? t.primary('›') : ' ';
  const labelFg = row.disabled ? t.dim : isSelected ? t.heading : t.plain;
  const valueFg = isSelected ? t.muted : t.dim;
  const label = labelFg(row.label);
  const value = row.value ? valueFg(row.value) : '';
  // Layout: " › LABEL ...VALUE"   with value right-aligned.
  const leftPart = ' ' + marker + ' ' + label;
  const leftVisible = visibleLength(leftPart);
  const valueVisible = visibleLength(value);
  const gapWidth = Math.max(2, inner - leftVisible - valueVisible);
  const line = leftPart + ' '.repeat(gapWidth) + value;
  const lines = [line];
  if (row.description) {
    const INDENT = '     '; // 5 spaces — aligns under "› LABEL"
    // Wrap the bare description (no indent) to the inner width MINUS
    // the indent so the indented line stays inside the frame. Then
    // re-indent each wrapped line and apply the dim color uniformly.
    const wrapped = wrap(row.description, Math.max(8, inner - INDENT.length));
    for (const w of wrapped) {
      lines.push(INDENT + t.dim(w));
    }
  }
  return lines;
}
