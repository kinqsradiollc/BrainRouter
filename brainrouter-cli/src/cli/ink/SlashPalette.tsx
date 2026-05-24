import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

/**
 * Claude-code-style slash command palette.
 *
 * Opens when the user types `/` at an empty prompt. Renders:
 *
 *   ─────────────────────────────────────────────────────────
 *    ❯ /loop
 *   ─────────────────────────────────────────────────────────
 *    › /loop         Run a prompt or slash command on a cadence
 *      /login        In-REPL MCP profile editor
 *      /logout       Clear API keys from the active profile
 *      ↑/↓ select  ·  ↵ confirm  ·  tab autocomplete  ·  esc cancel
 *
 * Filter ranking (lifted from openSrc/grok-cli/src/ui/slash-menu.ts +
 * openSrc/codex/codex-rs/tui/src/bottom_pane/command_popup.rs:143):
 *
 *   0  command body starts with query  (best — same-prefix match)
 *   1  command body contains query
 *   2  description contains query
 *   3  no match — filtered out
 *
 * Stable secondary sort by original index so commands with the same
 * score render in their canonical order each keystroke. Max visible
 * rows capped at 8 (claude-code CHANGELOG line 378 — popup should
 * NOT scale with terminal height; it stays compact).
 */

export interface SlashCommandDef {
  /** "/help", "/config", etc. — the literal token. */
  cmd: string;
  /** One-line description shown after the command. */
  description: string;
}

export interface SlashPaletteProps {
  /** Initial input buffer (typically just "/" — the keystroke that opened the palette). */
  initialQuery: string;
  /** All registered slash commands. */
  commands: SlashCommandDef[];
  /** Theme accent for highlights / borders. Defaults to brand orange. */
  accentColor?: string;
  /** Called when the user accepts a line (Enter) — text is the full submitted line. */
  onResolve: (result: SlashPaletteResult) => void;
}

export type SlashPaletteResult =
  | { kind: 'submit'; text: string }
  | { kind: 'cancelled' };

const MAX_VISIBLE = 8;

export function scoreSlashCommand(cmd: SlashCommandDef, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const body = cmd.cmd.slice(1).toLowerCase();
  if (body.startsWith(q)) return 0;
  if (body.includes(q)) return 1;
  if (cmd.description.toLowerCase().includes(q)) return 2;
  return 3;
}

export function filterCommands(commands: SlashCommandDef[], query: string): SlashCommandDef[] {
  if (!query) return commands.slice(0, MAX_VISIBLE);
  const scored = commands
    .map((c, i) => ({ c, i, s: scoreSlashCommand(c, query) }))
    .filter((x) => x.s < 3);
  scored.sort((a, b) => (a.s - b.s) || (a.i - b.i));
  return scored.slice(0, MAX_VISIBLE).map((x) => x.c);
}

export function SlashPalette({ initialQuery, commands, accentColor = '#CC9166', onResolve }: SlashPaletteProps) {
  const [value, setValue] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const { exit } = useApp();

  // Compute the query portion (everything after the leading `/`, up to
  // the first space — so `/spawn researcher` filters by `spawn`).
  const query = useMemo(() => {
    if (!value.startsWith('/')) return '';
    const tail = value.slice(1);
    const space = tail.indexOf(' ');
    return space < 0 ? tail : tail.slice(0, space);
  }, [value]);

  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Clamp cursor when matches shrink.
  useEffect(() => {
    if (cursor >= matches.length) setCursor(Math.max(0, matches.length - 1));
  }, [matches.length, cursor]);

  const onResolveRef = useRef(onResolve);
  useEffect(() => { onResolveRef.current = onResolve; });

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onResolveRef.current({ kind: 'cancelled' });
      exit();
      return;
    }
    if (key.escape) {
      onResolveRef.current({ kind: 'cancelled' });
      exit();
      return;
    }
    if (key.upArrow) {
      if (matches.length > 0) {
        setCursor((c) => (c - 1 + matches.length) % matches.length);
      }
      return;
    }
    if (key.downArrow) {
      if (matches.length > 0) {
        setCursor((c) => (c + 1) % matches.length);
      }
      return;
    }
    if (key.tab) {
      // Tab autocompletes to the currently-highlighted command + space.
      // User can continue typing args, then hit Enter to submit.
      if (matches.length > 0) {
        const picked = matches[cursor] ?? matches[0];
        setValue(picked.cmd + ' ');
        setCursor(0);
      }
      return;
    }
  });

  // When user presses Enter — TextInput's onSubmit fires. Resolve with
  // the highlighted match IF the buffer is JUST `/<query>` (no args
  // typed yet); otherwise submit the buffer as-is so /spawn role prompt
  // works without forcing the user to tab-complete first.
  const onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onResolveRef.current({ kind: 'cancelled' });
      exit();
      return;
    }
    // If the user typed JUST the slash + query (no args yet), AND the
    // highlighted match is different from what they typed, expand to
    // the match. Otherwise submit verbatim.
    const tail = trimmed.slice(1);
    const hasSpace = tail.includes(' ');
    if (!hasSpace && matches.length > 0) {
      const picked = matches[cursor] ?? matches[0];
      if (picked.cmd !== trimmed) {
        onResolveRef.current({ kind: 'submit', text: picked.cmd });
        exit();
        return;
      }
    }
    onResolveRef.current({ kind: 'submit', text: trimmed });
    exit();
  };

  // If the user types more than just `/`, AND it no longer starts with
  // `/` (e.g. backspaced past the slash), cancel the palette so the
  // user returns to the normal readline prompt.
  useEffect(() => {
    if (value.length > 0 && !value.startsWith('/')) {
      onResolveRef.current({ kind: 'cancelled' });
      exit();
    }
  }, [value, exit]);

  return (
    <Box flexDirection="column">
      <Divider color={accentColor} />
      <Box paddingX={1}>
        <Text color={accentColor}>❯ </Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      <Divider color={accentColor} />
      {matches.length === 0 ? (
        <Box paddingX={1}>
          <Text color="gray" dimColor>(no matching commands)</Text>
        </Box>
      ) : (
        <>
          {matches.map((cmd, i) => (
            <SlashRow
              key={cmd.cmd}
              cmd={cmd}
              selected={i === cursor}
              accentColor={accentColor}
            />
          ))}
        </>
      )}
      <Box paddingX={1} marginTop={1}>
        <Text color="gray" dimColor>
          ↑/↓ select  ·  ↵ confirm  ·  tab autocomplete  ·  esc cancel
        </Text>
      </Box>
    </Box>
  );
}

function SlashRow({ cmd, selected, accentColor }: { cmd: SlashCommandDef; selected: boolean; accentColor: string }) {
  // Width hint: pad the cmd column so descriptions align across rows.
  // The widest known slash command is around 28 chars (e.g. `/implement-plan`
  // is 15; longest help cmd lines are longer); 24 is a sensible target.
  const cmdCol = 26;
  const padded = cmd.cmd.length >= cmdCol ? cmd.cmd : cmd.cmd + ' '.repeat(cmdCol - cmd.cmd.length);
  return (
    <Box paddingX={1}>
      <Text color={accentColor}>{selected ? '› ' : '  '}</Text>
      <Text bold={selected} color={selected ? accentColor : undefined}>{padded}</Text>
      <Text color="gray">{cmd.description}</Text>
    </Box>
  );
}

function Divider({ color }: { color: string }) {
  // Full-width horizontal rule — matches claude-code's chrome.
  const cols = process.stdout.columns ?? 80;
  return (
    <Box>
      <Text color={color} dimColor>{'─'.repeat(Math.max(20, cols - 1))}</Text>
    </Box>
  );
}
