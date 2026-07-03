// REFAC-CHATAPP-SPLIT (0.4.17) — the bottom chrome (turn spinner, composer +
// dividers, reverse-i-search line, slash-palette panel, flag suggestions,
// @-mention list, and footer), extracted verbatim from ChatApp.tsx.
// Presentational only (props + callbacks in, JSX out); all state stays in the
// parent component. No behavior change.
import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { SlashPalettePanel } from '../SlashPalettePanel.js';
import { FooterStatus } from '../FooterStatus.js';
import { searchHistory } from '../../../runtime/input/inputHistory.js';
import type { SlashCommandDef } from '../SlashPalette.js';
import type { FlagDef } from '../../../runtime/input/slashFlags.js';
import type { FooterState } from './types.js';

export interface ComposerChromeProps {
  phase: 'idle' | 'turn-running';
  liveAssistant: string;
  liveReasoning: string;
  turnElapsedMs: number;
  spinnerLabel: string;
  cols: number;
  accentColor: string;
  histSearch: { query: string; skip: number } | null;
  histEntries: string[];
  scrollMode: boolean;
  composerKey: number;
  composerValue: string;
  onComposerChange: (next: string) => void;
  onComposerSubmit: (text: string) => void | Promise<void>;
  slashQuery: string | null;
  paletteMatches: SlashCommandDef[];
  paletteCursor: number;
  flagMatches: FlagDef[];
  flagCursor: number;
  atMatches: string[];
  atCursor: number;
  promptLabel: string;
  accessMode: 'read' | 'write' | 'shell';
  footer: FooterState;
}

export function ComposerChrome(p: ComposerChromeProps) {
  return (
    <>
      {/* Active turn spinner */}
      {p.phase === 'turn-running' && !p.liveAssistant && !p.liveReasoning ? (
        <Box marginTop={1} flexShrink={0}>
          <Text color={p.turnElapsedMs >= 10_000 ? 'yellow' : 'green'}>
            {React.createElement(Spinner as any, { type: 'dots' })}
          </Text>
          <Text color="gray" wrap="truncate">  {p.spinnerLabel}</Text>
        {p.turnElapsedMs >= 1000 ? (
          <Text color={p.turnElapsedMs >= 10_000 ? 'yellow' : 'gray'} dimColor>{`  · ${Math.floor(p.turnElapsedMs / 1000)}s`}</Text>
        ) : null}
        </Box>
      ) : null}

      {/* Global Composer (TextInput) and dividers */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text color={p.accentColor} dimColor>{'─'.repeat(Math.max(10, p.cols - 2))}</Text>
        {p.histSearch !== null ? (() => {
          const m = searchHistory(p.histEntries, p.histSearch.query, p.histSearch.skip);
          return (
            <Box>
              <Text color="cyan" bold>{` (reverse-i-search) `}</Text>
              <Text color="yellow">{`'${p.histSearch.query}'`}</Text>
              <Text color="gray">{': '}</Text>
              <Text wrap="truncate-end">{m ? m.value : p.histSearch.query ? '(no match)' : 'type to search · Ctrl+R next · Enter accept · Esc cancel'}</Text>
            </Box>
          );
        })() : null}
        <Box>
          <Text color={p.scrollMode ? 'cyan' : p.accentColor} bold={p.scrollMode}>{p.scrollMode ? ' ⊟ ' : ' ❯ '}</Text>
          <TextInput
            key={p.composerKey}
            value={p.composerValue}
            onChange={p.onComposerChange}
            onSubmit={p.onComposerSubmit}
            focus={!p.scrollMode && p.histSearch === null}
            placeholder={p.scrollMode ? 'SCROLL — w/s · j/k · ↑/↓ scroll · g/G top·bottom · Esc or i to type' : (p.phase === 'turn-running' ? '' : 'type a prompt or / for commands')}
          />
        </Box>
        <Text color={p.accentColor} dimColor>{'─'.repeat(Math.max(10, p.cols - 2))}</Text>
      </Box>

      {/* Slash palette panel */}
      {p.slashQuery !== null ? (
        <Box flexShrink={0}>
          <SlashPalettePanel
            matches={p.paletteMatches}
            cursor={p.paletteCursor}
            accentColor={p.accentColor}
            cols={p.cols}
          />
        </Box>
      ) : null}

      {/* Flag suggestions */}
      {p.flagMatches.length > 0 ? (
        <Box flexDirection="column" marginTop={0} flexShrink={0}>
          <Text color="gray" dimColor>  flags (Tab to complete, ↑/↓ to navigate)</Text>
          {p.flagMatches.map((m, i) => (
            <Box key={m.flag}>
              <Text color={i === p.flagCursor ? p.accentColor : 'gray'}>
                {i === p.flagCursor ? '  › ' : '    '}{m.flag}
              </Text>
              {p.cols >= 50 ? <Text color="gray" dimColor>{`  ${m.desc}`}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}

      {/* @-mentions */}
      {p.atMatches.length > 0 ? (
        <Box flexDirection="column" marginTop={0} flexShrink={0}>
          <Text color="gray" dimColor>  @ files (Tab to accept, ↑/↓ to navigate, Esc to dismiss)</Text>
          {p.atMatches.map((m, i) => (
            <Text key={m} color={i === p.atCursor ? p.accentColor : 'gray'}>
              {i === p.atCursor ? '  › ' : '    '}{m}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Global TUI Footer */}
      <Box flexShrink={0}>
        <FooterStatus
          promptLabel={p.promptLabel}
          phase={p.phase}
          accentColor={p.accentColor}
          accessMode={p.accessMode}
          footer={p.footer}
          cols={p.cols}
        />
      </Box>
    </>
  );
}
