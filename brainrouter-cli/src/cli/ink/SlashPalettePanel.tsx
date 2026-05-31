import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommandDef } from './SlashPalette.js';

/**
 * REFAC-CHATAPP-SPLIT part 2 (0.4.6) — the slash-command palette panel,
 * extracted verbatim from ChatApp.tsx. Presentational only (props in, JSX out).
 */
/**
 * Slash command palette — scrollable, navigable, full-list view.
 *
 * Sized to a fixed `MAX_VISIBLE` window; when the match count exceeds
 * the window, the viewport scrolls to keep the highlighted cursor in
 * range. "↑ N more" / "↓ N more" hints render at the edges so the user
 * knows there's more list to see.
 *
 * The command column has a fixed width so descriptions align across
 * rows; descriptions use Ink's `wrap="truncate"` so a long line is
 * cut with an ellipsis at the terminal edge instead of wrapping to
 * the next row (which would break the per-row layout).
 */
const PALETTE_MAX_VISIBLE = 10;
const PALETTE_CMD_COL_WIDTH = 24;

export function SlashPalettePanel({
  matches,
  cursor,
  accentColor,
  cols,
}: {
  matches: SlashCommandDef[];
  cursor: number;
  accentColor: string;
  cols: number;
}) {
  if (matches.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>(no matching commands)</Text>
      </Box>
    );
  }
  // Compute a sliding viewport so the cursor stays comfortably inside.
  // Prefer centering when possible; clamp at the ends so we never show
  // an empty row at top or bottom.
  const total = matches.length;
  const safeCursor = Math.max(0, Math.min(cursor, total - 1));
  const windowSize = Math.min(PALETTE_MAX_VISIBLE, total);
  let viewportStart = safeCursor - Math.floor(windowSize / 2);
  if (viewportStart < 0) viewportStart = 0;
  if (viewportStart + windowSize > total) viewportStart = Math.max(0, total - windowSize);
  const visible = matches.slice(viewportStart, viewportStart + windowSize);
  const hiddenAbove = viewportStart;
  const hiddenBelow = total - (viewportStart + windowSize);

  // Progressive collapse for narrow terminals:
  //   - Below 50 cols: drop the description column entirely; the cmd
  //     column expands to fill the remaining width.
  //   - At normal widths: fixed 24-col cmd column, description takes
  //     the rest with `wrap="truncate"`.
  const showDescription = cols >= 50;
  const cmdColWidth = showDescription
    ? PALETTE_CMD_COL_WIDTH
    : Math.max(12, cols - 6);
  const descBudget = showDescription ? Math.max(12, cols - cmdColWidth - 5) : 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hiddenAbove > 0 ? (
        <Box>
          <Text color="gray" dimColor>{`   ↑ ${hiddenAbove} more above`}</Text>
        </Box>
      ) : null}
      {visible.map((cmd, i) => {
        const actualIdx = viewportStart + i;
        const isSelected = actualIdx === safeCursor;
        return (
          <Box key={cmd.cmd}>
            <Text color={accentColor}>{isSelected ? ' › ' : '   '}</Text>
            <Box width={cmdColWidth}>
              <Text bold={isSelected} color={isSelected ? accentColor : undefined} wrap="truncate">{cmd.cmd}</Text>
            </Box>
            {showDescription ? (
              <Box width={descBudget}>
                <Text color="gray" wrap="truncate">{cmd.description}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? (
        <Box>
          <Text color="gray" dimColor>{`   ↓ ${hiddenBelow} more below`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray" dimColor wrap="truncate">
          {cols >= 90
            ? '↑/↓ navigate  ·  tab autocomplete  ·  ↵ submit  ·  type to filter  ·  esc / backspace past / to cancel'
            : cols >= 60
              ? '↑/↓  ·  tab autocomplete  ·  ↵ submit  ·  esc to cancel'
              : '↑/↓  ·  tab  ·  ↵  ·  esc'}
        </Text>
      </Box>
    </Box>
  );
}
