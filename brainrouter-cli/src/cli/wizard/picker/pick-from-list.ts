import { buildTheme, type Theme } from '../../theme.js';
import { type PickerRow, type PickFromListOptions, type PickFromListResult } from './types.js';
import { renderFrame, formatBodyRow, visibleLength } from './frame-render.js';
import { runFramedInput } from './frame-runtime.js';

// --- pickFromList ------------------------------------------------------

export async function pickFromList(opts: PickFromListOptions): Promise<PickFromListResult> {
  return runFramedInput(async (frame) => {
    const theme = opts.theme ?? buildTheme('dark');
    const augmentedRows: PickerRow[] = opts.allowOther
      ? [
          ...opts.rows,
          {
            id: '__other__',
            label: opts.otherLabel ?? 'Other',
            description: opts.otherDescription ?? 'Type a free-form answer',
          },
        ]
      : [...opts.rows];

    let cursor = clamp(opts.initialCursor ?? 0, 0, augmentedRows.length - 1);
    let phase: 'pick' | 'other' = opts.prefilledOther !== undefined ? 'other' : 'pick';
    let otherText = opts.prefilledOther ?? '';
    let previewLines: string[] | undefined;

    // Initial preview if a row is selected on entry.
    const fireCursorChange = () => {
      if (opts.onCursorChange && phase === 'pick') {
        const row = augmentedRows[cursor];
        if (row && row.id !== '__other__') {
          try { previewLines = opts.onCursorChange(row.id, cursor); } catch { previewLines = undefined; }
        } else {
          previewLines = undefined;
        }
      }
    };
    fireCursorChange();

    const computeFrame = (): string => {
      const W = computeWidth(opts.title, augmentedRows, theme);
      const inner = Math.max(20, W - 4);
      const bodyLines: string[] = [];
      if (phase === 'pick') {
        const valueColWidth = computeValueColumn(augmentedRows);
        for (let i = 0; i < augmentedRows.length; i++) {
          const row = augmentedRows[i];
          const formatted = formatBodyRow(theme, row, i === cursor, valueColWidth, inner);
          bodyLines.push(...formatted);
        }
      } else {
        // Free-text "Other" phase.
        bodyLines.push(' ' + theme.muted('›') + ' ' + theme.heading('Type your answer'));
        bodyLines.push('     ' + theme.dim(opts.otherDescription ?? 'Press ENTER to accept · Esc to go back'));
        bodyLines.push('');
        const display = otherText.length > 0 ? otherText : theme.dim('(empty)');
        bodyLines.push('   ' + theme.info('›') + ' ' + display + theme.muted('_'));
      }
      const footer = opts.footer ?? defaultFooter(phase, !!opts.allowOther);
      return renderFrame({
        theme,
        title: opts.title,
        subtitle: opts.subtitle,
        badge: opts.badge,
        bodyLines,
        previewLines,
        footer,
        width: W,
      });
    };

    return new Promise<PickFromListResult>((resolve) => {
      frame.draw(computeFrame());

      frame.onKey((key, str) => {
        if (key.ctrl && (key.name === 'c' || key.sequence === '')) {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }

        if (phase === 'other') {
          if (key.name === 'return') {
            const trimmed = otherText.trim();
            if (!trimmed) return; // require non-empty
            frame.close();
            resolve({ kind: 'other', text: trimmed });
            return;
          }
          if (key.name === 'escape') {
            phase = 'pick';
            otherText = '';
            fireCursorChange();
            frame.draw(computeFrame());
            return;
          }
          if (key.name === 'backspace') {
            if (otherText.length > 0) {
              otherText = otherText.slice(0, -1);
              frame.draw(computeFrame());
            }
            return;
          }
          if (typeof str === 'string' && str.length === 1 && !key.ctrl && key.name !== 'tab') {
            otherText += str;
            frame.draw(computeFrame());
            return;
          }
          return;
        }

        // pick phase
        if (key.name === 'up' || (key.name === 'k' && !key.ctrl && !key.meta)) {
          cursor = (cursor - 1 + augmentedRows.length) % augmentedRows.length;
          while (augmentedRows[cursor].disabled) cursor = (cursor - 1 + augmentedRows.length) % augmentedRows.length;
          fireCursorChange();
          frame.draw(computeFrame());
          return;
        }
        if (key.name === 'down' || (key.name === 'j' && !key.ctrl && !key.meta)) {
          cursor = (cursor + 1) % augmentedRows.length;
          while (augmentedRows[cursor].disabled) cursor = (cursor + 1) % augmentedRows.length;
          fireCursorChange();
          frame.draw(computeFrame());
          return;
        }
        if (key.name === 'return') {
          const row = augmentedRows[cursor];
          if (row.disabled) return;
          if (row.id === '__other__') {
            phase = 'other';
            previewLines = undefined;
            frame.draw(computeFrame());
            return;
          }
          frame.close();
          resolve({ kind: 'pick', id: row.id });
          return;
        }
        if (key.name === 'escape' || key.name === 'q') {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
      });
    });
  }, { eraseOnClose: opts.eraseOnClose });
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function computeValueColumn(rows: PickerRow[]): number {
  let max = 0;
  for (const row of rows) if (row.value) max = Math.max(max, visibleLength(row.value));
  return max;
}

function computeWidth(title: string, rows: PickerRow[], _theme: Theme): number {
  const terminal = (process.stdout.columns ?? 80);
  const target = 76;
  const min = 56;
  const max = Math.max(min, Math.min(terminal - 4, 100));
  let widest = visibleLength(title) + 12; // title + badge slack
  for (const row of rows) {
    const valueW = row.value ? visibleLength(row.value) : 0;
    const labelW = visibleLength(row.label);
    widest = Math.max(widest, labelW + 6 + valueW); // gap + glyph
    if (row.description) widest = Math.max(widest, visibleLength(row.description) + 6);
  }
  return clamp(Math.max(widest + 4, target), min, max);
}

export function defaultFooter(phase: 'pick' | 'other', allowOther: boolean): string {
  if (phase === 'other') {
    return '↵ accept  ·  esc back  ·  ⌫ erase';
  }
  return allowOther
    ? '↑/↓ navigate  ·  ↵ confirm  ·  esc / q cancel'
    : '↑/↓ navigate  ·  ↵ confirm  ·  esc / q cancel';
}
