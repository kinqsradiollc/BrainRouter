// REFAC-CHATAPP-SPLIT (0.4.17) — the `session` route body, extracted verbatim
// from ChatApp.tsx. Renders the packed scrollback window (with mid-entry
// clipping wrappers), the live dim-italic reasoning panel, and the live
// streaming assistant row. Presentational only (props in, JSX out); no state.
import React from 'react';
import { Box, Text } from 'ink';
import { ScrollbackRow } from '../ScrollbackRow.js';
import {
  REASONING_TAIL_CHARS,
  REASONING_VISIBLE_LINES,
  tailReasoning,
  buildReasoningWindow,
} from '../reasoningWindow.js';
import type { ScrollbackEntry, VisibleSlice } from './types.js';

export interface SessionViewProps {
  visibleScrollback: {
    slices: Array<VisibleSlice<ScrollbackEntry>>;
    hiddenLinesAbove: number;
    hiddenLinesBelow: number;
    totalLines: number;
  };
  accentColor: string;
  mainWidth: number;
  verboseTranscript: boolean;
  liveReasoning: string;
  liveAssistant: string;
}

export function SessionView({
  visibleScrollback,
  accentColor,
  mainWidth,
  verboseTranscript,
  liveReasoning,
  liveAssistant,
}: SessionViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
      <Box flexDirection="column">
        {visibleScrollback.hiddenLinesAbove > 0 || visibleScrollback.hiddenLinesBelow > 0 ? (
          <Text color="gray" dimColor wrap="truncate">
            {`  ⋯ ${visibleScrollback.hiddenLinesAbove} line${visibleScrollback.hiddenLinesAbove === 1 ? '' : 's'} above · Esc to scroll (w/s · j/k · ↑/↓ · g/G)${visibleScrollback.hiddenLinesBelow > 0 ? ` · ${visibleScrollback.hiddenLinesBelow} below` : ''}`}
          </Text>
        ) : null}
        {visibleScrollback.slices.map((slice) => {
          const row = <ScrollbackRow key={slice.entry.id} entry={slice.entry} accentColor={accentColor} cols={mainWidth} verbose={verboseTranscript} />;
          if (slice.clipTop === 0 && slice.clipBottom === 0) return row;
          // Boundary entry: show only its visible rows. Fixed-height
          // overflow:hidden wrapper; a negative top margin slides the
          // content up by clipTop so the window lands mid-entry.
          const visibleRows = Math.max(1, slice.height - slice.clipTop - slice.clipBottom);
          return (
            <Box key={slice.entry.id} height={visibleRows} overflow="hidden" flexDirection="column">
              <Box flexDirection="column" flexShrink={0} marginTop={-slice.clipTop}>
                {row}
              </Box>
            </Box>
          );
        })}
        {liveReasoning ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="magenta" italic dimColor>
              💭 thinking{liveReasoning.length > REASONING_TAIL_CHARS ? ` (${liveReasoning.length.toLocaleString()} chars)` : ''}
            </Text>
            <Box
              marginLeft={1}
              paddingLeft={1}
              height={REASONING_VISIBLE_LINES}
              flexDirection="column"
              borderStyle="single"
              borderColor="magenta"
              borderDimColor
              borderTop={false}
              borderRight={false}
              borderBottom={false}
            >
              <Text color="gray" italic wrap="truncate-end">
                {buildReasoningWindow(tailReasoning(liveReasoning), mainWidth)}<Text color="gray">▍</Text>
              </Text>
            </Box>
          </Box>
        ) : null}
        {liveAssistant ? (
          <Box marginTop={1}>
            <Text color="green">⏺ </Text>
            <Text>{liveAssistant}<Text color="gray">▍</Text></Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
