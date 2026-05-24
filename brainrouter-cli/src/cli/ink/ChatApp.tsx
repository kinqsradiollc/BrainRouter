import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { SlashPalette, type SlashCommandDef } from './SlashPalette.js';

/**
 * Ink-based chat REPL — replaces the readline-based `startREPL` shell.
 *
 * Layout (matches claude-code's chrome):
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  banner (one-time, at top of scrollback)                    │
 *   │  ⏺ assistant turn 1                                          │
 *   │    ⎿ tool call result                                        │
 *   │  ❯ user: what about X?                                       │
 *   │  ⏺ assistant turn 2                                          │
 *   │  ...                                                         │
 *   │                                                              │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  ❯ <input cursor here>                                       │  ← composer
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  model · session · ◉ effort                ? for shortcuts   │  ← footer
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Scrollback rendering uses Ink's `<Static>` so finished entries
 * (banner, completed turns, completed slash command output) are
 * promoted out of the redraw region into terminal scrollback. This
 * is the same pattern claude-code uses.
 *
 * Slash palette is a child component: when the input buffer becomes
 * `/`, the palette renders BELOW the composer with the filtered
 * command list. No more readline detach/Ink mount cycle — Ink owns
 * stdin for the entire REPL lifetime.
 *
 * State machine:
 *   - phase: 'idle' | 'turn-running' | 'side-conversation'
 *   - scrollback: ScrollbackEntry[] — completed entries (banner, turns, slash output)
 *   - composerValue: string — current input buffer
 *   - palette: 'closed' | 'open' — visible when value starts with `/`
 */

marked.use(markedTerminal({ showSectionPrefix: false }) as any);

// --- Public props ------------------------------------------------------

export interface ChatAppProps {
  initialBanner: string;
  initialOfflineWarning?: string;
  initialHint: string;
  /** Static description of the slash commands the user can run. */
  slashCommands: SlashCommandDef[];
  /** Initial prompt label, e.g. "brainrouter[effort:low]". */
  promptLabel: string;
  /** Accent color (hex) for chrome. */
  accentColor?: string;
  /** Called when the user submits a line (slash command OR free-form prompt). */
  onSubmit: (text: string, push: PushScrollback) => Promise<void>;
}

export type ScrollbackEntry =
  | { id: number; kind: 'raw'; text: string }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }
  | { id: number; kind: 'tool'; name: string; ok: boolean; preview?: string }
  | { id: number; kind: 'memory'; level: 'info' | 'warn'; text: string }
  | { id: number; kind: 'plan'; items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { id: number; kind: 'notice'; text: string };

export interface PushScrollback {
  raw(text: string): void;
  user(text: string): void;
  assistant(text: string, meta?: { durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }): void;
  tool(name: string, ok: boolean, preview?: string): void;
  memory(level: 'info' | 'warn', text: string): void;
  plan(items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]): void;
  notice(text: string): void;
}

// --- Main app ---------------------------------------------------------

export function ChatApp({
  initialBanner,
  initialOfflineWarning,
  initialHint,
  slashCommands,
  promptLabel,
  accentColor = '#CC9166',
  onSubmit,
}: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const [scrollback, setScrollback] = useState<ScrollbackEntry[]>(() => seedScrollback(initialBanner, initialOfflineWarning, initialHint));
  const nextIdRef = useRef(scrollback.length);
  const [composerValue, setComposerValue] = useState('');
  const [phase, setPhase] = useState<'idle' | 'turn-running'>('idle');
  const [spinnerLabel, setSpinnerLabel] = useState<string>('');

  const pushFns = useMemo<PushScrollback>(() => {
    const push = (entry: any) => {
      setScrollback((s) => {
        const id = ++nextIdRef.current;
        return [...s, { id, ...entry } as ScrollbackEntry];
      });
    };
    return {
      raw: (text) => push({ kind: 'raw', text }),
      user: (text) => push({ kind: 'user', text }),
      assistant: (text, meta) => push({ kind: 'assistant', text, ...meta }),
      tool: (name, ok, preview) => push({ kind: 'tool', name, ok, preview }),
      memory: (level, text) => push({ kind: 'memory', level, text }),
      plan: (items) => push({ kind: 'plan', items }),
      notice: (text) => push({ kind: 'notice', text }),
    };
  }, []);

  // Slash palette visibility — open when input is just `/<query>`
  // with no whitespace yet (so the user is still composing the
  // command name, not args).
  const slashQuery = useMemo(() => {
    if (!composerValue.startsWith('/')) return null;
    const tail = composerValue.slice(1);
    if (tail.includes(' ')) return null;
    return tail;
  }, [composerValue]);

  const onComposerSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pushFns.user(trimmed);
    setComposerValue('');
    setPhase('turn-running');
    setSpinnerLabel('thinking');
    try {
      await onSubmit(trimmed, pushFns);
    } catch (err: any) {
      pushFns.notice(`✗ ${err?.message ?? err}`);
    } finally {
      setPhase('idle');
      setSpinnerLabel('');
    }
  }, [onSubmit, pushFns]);

  // Ctrl+D / Ctrl+C exit cleanly.
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) {
      exit();
    }
  });

  const divider = '─'.repeat(Math.max(20, cols - 1));

  return (
    <Box flexDirection="column">
      {/* Scrollback (promoted out of the redraw region per render). */}
      <Static items={scrollback}>
        {(entry) => <ScrollbackRow key={entry.id} entry={entry} accentColor={accentColor} />}
      </Static>

      {/* Active turn spinner — shown ONLY while a turn is running, not promoted. */}
      {phase === 'turn-running' ? (
        <Box>
          <Text color="green">{React.createElement(Spinner as any, { type: 'dots' })}</Text>
          <Text color="gray">  {spinnerLabel}</Text>
        </Box>
      ) : null}

      {/* Composer + slash palette stack. */}
      <Box flexDirection="column">
        <Text color={accentColor} dimColor>{divider}</Text>
        <Box>
          <Text color={accentColor}>{' ❯ '}</Text>
          <TextInput
            value={composerValue}
            onChange={setComposerValue}
            onSubmit={onComposerSubmit}
            placeholder={phase === 'turn-running' ? '' : 'type a prompt or / for commands'}
          />
        </Box>
        <Text color={accentColor} dimColor>{divider}</Text>
      </Box>

      {/* Slash palette — renders below composer when the user is typing `/`. */}
      {slashQuery !== null ? (
        <SlashPalettePanel
          query={slashQuery}
          commands={slashCommands}
          accentColor={accentColor}
        />
      ) : null}

      {/* Footer status line. */}
      <FooterStatus
        promptLabel={promptLabel}
        phase={phase}
        accentColor={accentColor}
      />
    </Box>
  );
}

// --- Sub-components ---------------------------------------------------

function ScrollbackRow({ entry, accentColor }: { entry: ScrollbackEntry; accentColor: string }) {
  switch (entry.kind) {
    case 'raw':
      return <Text>{entry.text}</Text>;
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={accentColor}>❯ </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'assistant': {
      // Render the assistant body via marked-terminal so markdown is
      // formatted, then prefix the first line with ⏺ and indent the rest.
      const rendered = typeof entry.text === 'string' ? entry.text : String(entry.text);
      const lines = (markedSafe(rendered)).trimEnd().split('\n');
      const meta = entry.durationMs !== undefined
        ? `  ${Math.floor(entry.durationMs / 1000)}s${entry.tokensIn !== undefined ? ` · ${entry.tokensIn.toLocaleString()} in / ${entry.tokensOut?.toLocaleString() ?? 0} out` : ''}`
        : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          {lines.map((line, i) => (
            <Box key={i}>
              {i === 0 ? <Text color="green">⏺ </Text> : <Text>{'  '}</Text>}
              <Text>{line}</Text>
            </Box>
          ))}
          {meta ? <Text color="gray" dimColor>{meta}</Text> : null}
        </Box>
      );
    }
    case 'tool': {
      const glyph = entry.ok ? '✓' : '✗';
      const color = entry.ok ? 'green' : 'red';
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color}>{'  ⎿ '}</Text>
            <Text color={color}>{glyph}</Text>
            <Text>{' '}{entry.name}</Text>
          </Box>
          {entry.preview ? (
            <Box paddingLeft={5}>
              <Text color="gray" dimColor>{entry.preview}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'memory':
      return (
        <Box>
          <Text color={entry.level === 'warn' ? 'yellow' : 'gray'} dimColor={entry.level === 'info'}>
            {entry.level === 'warn' ? '⚠ ' : '· '}{entry.text}
          </Text>
        </Box>
      );
    case 'plan':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">📋 Plan</Text>
          {entry.items.map((item, i) => {
            const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '⏳' : '☐';
            const color = item.status === 'completed' ? 'green' : item.status === 'in_progress' ? 'yellow' : 'gray';
            return (
              <Box key={i}>
                <Text color={color}>  {mark} </Text>
                <Text color={item.status === 'completed' ? 'gray' : undefined}>{item.step}</Text>
              </Box>
            );
          })}
        </Box>
      );
    case 'notice':
      return <Text color="yellow">{entry.text}</Text>;
  }
}

function SlashPalettePanel({ query, commands, accentColor }: { query: string; commands: SlashCommandDef[]; accentColor: string }) {
  const matches = useMemo(() => filterPaletteCommands(commands, query).slice(0, 6), [commands, query]);
  if (matches.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>(no matching commands)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {matches.map((cmd, i) => (
        <Box key={cmd.cmd}>
          <Text color={accentColor}>{i === 0 ? ' › ' : '   '}</Text>
          <Box width={26}>
            <Text bold={i === 0} color={i === 0 ? accentColor : undefined}>{cmd.cmd}</Text>
          </Box>
          <Text color="gray">{cmd.description}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor> ↵ submit  ·  type to filter  ·  esc / backspace past / to cancel</Text>
      </Box>
    </Box>
  );
}

function FooterStatus({ promptLabel, phase, accentColor }: { promptLabel: string; phase: 'idle' | 'turn-running'; accentColor: string }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color="gray" dimColor>{promptLabel}{phase === 'turn-running' ? ' · running' : ''}</Text>
      <Text color="gray" dimColor>? for shortcuts  ·  / for commands</Text>
    </Box>
  );
}

// --- Helpers ----------------------------------------------------------

function seedScrollback(banner: string, offline: string | undefined, hint: string): ScrollbackEntry[] {
  let id = 0;
  const next = (): number => ++id;
  const out: ScrollbackEntry[] = [{ id: next(), kind: 'raw', text: banner }];
  if (offline) out.push({ id: next(), kind: 'raw', text: offline });
  out.push({ id: next(), kind: 'raw', text: hint });
  return out;
}

function markedSafe(text: string): string {
  try {
    return String(marked.parse(text));
  } catch {
    return text;
  }
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
