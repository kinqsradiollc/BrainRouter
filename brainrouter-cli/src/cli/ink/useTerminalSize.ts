import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

/**
 * Live terminal dimensions hook — re-renders the component whenever
 * the user resizes the terminal window.
 *
 * Why this exists:
 *
 *   Ink's `useStdout()` returns the stdout stream, and `stdout.columns`
 *   IS a live getter that always returns the current width. Ink also
 *   subscribes to `stdout.on('resize')` internally and triggers a
 *   re-render. In theory, reading `stdout?.columns` inside a render
 *   function automatically picks up the new width on the next resize.
 *
 *   In practice, several dynamic parts of the chat REPL — the composer
 *   divider, the slash palette description column, the footer hints —
 *   were computed from a single inline `cols` const at the top of
 *   render. When the user dragged the terminal narrower or wider:
 *
 *     - The divider stayed at its old length (overflowing or short).
 *     - The slash palette's description budget didn't update.
 *     - The footer right-side hint didn't collapse on narrow widths.
 *
 *   Cause: Ink does re-render on resize, but children that received
 *   `cols` as a stable prop weren't being re-invoked with the new value
 *   in all of our cases. Explicitly subscribing to `resize` and using a
 *   React state update guarantees a re-render with the new dimensions
 *   regardless of Ink's internal heuristics.
 *
 * Returns `{ columns, rows }` — both auto-update on every resize event.
 * Defaults to 80 × 24 when stdout is unavailable (non-TTY tests).
 */
export interface TerminalSize {
  columns: number;
  rows: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? DEFAULT_COLUMNS,
    rows: stdout?.rows ?? DEFAULT_ROWS,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({
        columns: stdout.columns ?? DEFAULT_COLUMNS,
        rows: stdout.rows ?? DEFAULT_ROWS,
      });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
