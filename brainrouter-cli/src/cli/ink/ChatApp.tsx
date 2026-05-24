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
  /**
   * Imperative hook — invoked once during mount with a controller object the
   * orchestrator can use to push scrollback / footer updates from outside the
   * React tree (e.g. when the parent-turn closure wants to print a side-channel
   * message after `agent.runTurn` resolved but before the next prompt cycle).
   */
  onReady?: (controller: ChatController) => void;
  /**
   * Cycle the access mode (read → write → shell → read). Returned label is
   * appended to the footer pill. Called when the user presses Shift+Tab.
   */
  onAccessModeCycle?: () => string;
  /**
   * Initial access mode for the footer pill — kept in sync via
   * `controller.setFooter({ accessMode })`. Defaults to 'read'.
   */
  initialAccessMode?: 'read' | 'write' | 'shell';
  /**
   * Initial extra footer segments (model, session, effort, branch). Updated
   * after each turn via `controller.setFooter`.
   */
  initialFooter?: FooterState;
}

export interface FooterState {
  /** e.g. "gpt-4o-mini". */
  model?: string;
  /** e.g. "rep-2026-…-abc123". Truncated for display. */
  session?: string;
  /** e.g. "main". */
  branch?: string;
  /** "low" | "medium" | "high". Rendered as a pill. */
  effort?: string;
  /** Free-form right-side text (statusline segments). */
  rightExtra?: string;
}

export interface ChatController {
  /** Push entries from outside the React tree (e.g. after the parent turn ended). */
  push: PushScrollback;
  /** Update the footer status row (model, session, access mode, effort, etc.). */
  setFooter: (patch: Partial<FooterState & { accessMode: 'read' | 'write' | 'shell' }>) => void;
  /** Programmatically inject text into the composer (e.g. workflow.ts loop tick). */
  setComposer: (text: string) => void;
  /** Exit the chat app gracefully. */
  exit: () => void;
}

export type ScrollbackEntry =
  | { id: number; kind: 'raw'; text: string }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; raw?: boolean; durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }
  | { id: number; kind: 'tool'; name: string; ok: boolean; preview?: string }
  | { id: number; kind: 'memory'; level: 'info' | 'warn'; text: string }
  | { id: number; kind: 'plan'; items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { id: number; kind: 'notice'; text: string };

export interface PushScrollback {
  raw(text: string): void;
  user(text: string): void;
  /** `raw: true` skips marked-terminal rendering (use when caller already pre-rendered or user wants raw scrollback). */
  assistant(text: string, meta?: { raw?: boolean; durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }): void;
  tool(name: string, ok: boolean, preview?: string): void;
  memory(level: 'info' | 'warn', text: string): void;
  plan(items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]): void;
  notice(text: string): void;
  /** Update the live spinner label (e.g. "Thinking  5s  1.2k↑ 0.4k↓"). */
  setStatus(label: string): void;
  /** Show / hide the spinner without pushing a scrollback entry. */
  setPhase(phase: 'idle' | 'turn-running'): void;
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
  onReady,
  onAccessModeCycle,
  initialAccessMode = 'read',
  initialFooter = {},
}: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const [scrollback, setScrollback] = useState<ScrollbackEntry[]>(() => seedScrollback(initialBanner, initialOfflineWarning, initialHint));
  const nextIdRef = useRef(scrollback.length);
  const [composerValue, setComposerValue] = useState('');
  const [phase, setPhase] = useState<'idle' | 'turn-running'>('idle');
  const [spinnerLabel, setSpinnerLabel] = useState<string>('');
  const [accessMode, setAccessMode] = useState<'read' | 'write' | 'shell'>(initialAccessMode);
  const [footer, setFooter] = useState<FooterState>(initialFooter);
  /**
   * Slash palette cursor — lifted out of SlashPalettePanel so this
   * component owns both the highlight + the keystroke handlers.
   * (useInput at the panel level would race with TextInput for arrow
   * keys; centralizing here makes the precedence explicit.)
   */
  const [paletteCursor, setPaletteCursor] = useState(0);

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
      setStatus: (label) => setSpinnerLabel(label),
      setPhase: (p) => setPhase(p),
    };
  }, []);

  // Imperative controller — exposed once on mount via onReady so the
  // orchestrator can push from outside the React tree (child agent
  // callbacks fire long after `await agent.runTurn()` resolves and need
  // a way to inject into scrollback without re-entering React state).
  useEffect(() => {
    if (!onReady) return;
    onReady({
      push: pushFns,
      setFooter: (patch) => {
        if (patch.accessMode) setAccessMode(patch.accessMode);
        setFooter((prev) => ({ ...prev, ...patch }));
      },
      setComposer: (text) => setComposerValue(text),
      exit,
    });
    // Run exactly once — the controller's identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // All matches for the current query, in filter rank order. Computed
  // once per keystroke so the panel and the Enter/Tab handlers all
  // share the same view of "what's highlighted".
  const paletteMatches = useMemo(
    () => (slashQuery !== null ? filterPaletteCommands(slashCommands, slashQuery) : []),
    [slashCommands, slashQuery],
  );

  // Reset the cursor whenever the filter changes (matches array shrinks
  // or shifts), and snap to 0 when the palette closes so a fresh `/`
  // doesn't land on a stale row index.
  useEffect(() => {
    if (slashQuery === null) {
      setPaletteCursor(0);
      return;
    }
    setPaletteCursor((c) => (paletteMatches.length === 0 ? 0 : Math.min(c, paletteMatches.length - 1)));
  }, [slashQuery, paletteMatches.length]);

  const onComposerSubmit = useCallback(async (text: string) => {
    let trimmed = text.trim();
    // Palette substitution: if the user pressed Enter while a slash
    // palette match is highlighted AND the buffer is still in palette
    // mode (just `/<query>`, no args yet), submit the highlighted
    // command instead of the literal typed text. Matches the standalone
    // SlashPalette in cli/ink/SlashPalette.tsx:onSubmit.
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && paletteMatches.length > 0) {
      const picked = paletteMatches[paletteCursor] ?? paletteMatches[0];
      if (picked.cmd !== trimmed) {
        trimmed = picked.cmd;
      }
    }
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
  }, [onSubmit, pushFns, paletteMatches, paletteCursor]);

  // Ctrl+D / Ctrl+C exit; Shift+Tab cycles access mode; while the
  // slash palette is open, arrow keys navigate it and Tab autocompletes
  // the highlighted command into the composer.
  //
  // Why centralize here vs inside SlashPalettePanel: ink-text-input also
  // uses `useInput` and consumes some key events. Up/down arrows are
  // no-ops in a single-line text input so they don't conflict, but if
  // we added the panel-level handler it would still receive the events
  // even when the panel was unmounted (different mount-cycle bug).
  // Centralizing keeps the precedence explicit and the handler scoped
  // to ChatApp's lifetime.
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'd')) {
      exit();
      return;
    }
    if (key.shift && key.tab && onAccessModeCycle) {
      const next = onAccessModeCycle();
      if (next === 'read' || next === 'write' || next === 'shell') {
        setAccessMode(next);
        pushFns.notice(`Access mode → ${next}`);
      }
      return;
    }
    // Palette navigation — only when palette is open AND there's at
    // least one match. We DON'T use `key.return` here because Enter is
    // handled by TextInput's onSubmit (which calls onComposerSubmit
    // above, which performs the highlight-substitution).
    if (slashQuery !== null && paletteMatches.length > 0) {
      if (key.upArrow) {
        setPaletteCursor((c) => (c - 1 + paletteMatches.length) % paletteMatches.length);
        return;
      }
      if (key.downArrow) {
        setPaletteCursor((c) => (c + 1) % paletteMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        // Tab autocompletes the highlighted command into the composer
        // (with a trailing space so the user can keep typing args).
        const picked = paletteMatches[paletteCursor] ?? paletteMatches[0];
        setComposerValue(picked.cmd + ' ');
        setPaletteCursor(0);
        return;
      }
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
          matches={paletteMatches}
          cursor={paletteCursor}
          accentColor={accentColor}
          cols={cols}
        />
      ) : null}

      {/* Footer status line. */}
      <FooterStatus
        promptLabel={promptLabel}
        phase={phase}
        accentColor={accentColor}
        accessMode={accessMode}
        footer={footer}
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
      // `raw: true` skips marked — the caller already rendered (avoids
      // double-rendering when runChat pre-marks) or the user has the
      // rawScrollback preference enabled.
      const rendered = typeof entry.text === 'string' ? entry.text : String(entry.text);
      const lines = (entry.raw ? rendered : markedSafe(rendered)).trimEnd().split('\n');
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

function SlashPalettePanel({
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

  // Description width budget: terminal cols minus the cmd column,
  // cursor prefix (3 chars), and 2 padding chars. Floored at 12 so
  // very narrow terminals still show *some* description.
  const descBudget = Math.max(12, cols - PALETTE_CMD_COL_WIDTH - 5);

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
            <Box width={PALETTE_CMD_COL_WIDTH}>
              <Text bold={isSelected} color={isSelected ? accentColor : undefined} wrap="truncate">{cmd.cmd}</Text>
            </Box>
            <Box width={descBudget}>
              <Text color="gray" wrap="truncate">{cmd.description}</Text>
            </Box>
          </Box>
        );
      })}
      {hiddenBelow > 0 ? (
        <Box>
          <Text color="gray" dimColor>{`   ↓ ${hiddenBelow} more below`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑/↓ navigate  ·  tab autocomplete  ·  ↵ submit  ·  type to filter  ·  esc / backspace past / to cancel
        </Text>
      </Box>
    </Box>
  );
}

function FooterStatus({
  promptLabel,
  phase,
  accentColor,
  accessMode,
  footer,
}: {
  promptLabel: string;
  phase: 'idle' | 'turn-running';
  accentColor: string;
  accessMode: 'read' | 'write' | 'shell';
  footer: FooterState;
}) {
  // Pill background mirrors the readline REPL's mode-to-token mapping:
  //   read  → green   (safe)
  //   write → accent  (default brand)
  //   shell → red     (escalated)
  // See cli/repl.ts:refreshPromptForMode for the rationale.
  const pillBg = accessMode === 'shell' ? 'red' : accessMode === 'write' ? accentColor : 'green';
  const pillFg = 'black';
  // Effort pill — only shown when set. Same visual language as the access pill.
  const effortBg = footer.effort === 'high' ? 'magenta' : footer.effort === 'medium' ? 'yellow' : 'gray';

  // Left side: model · session · branch.  Right side: ? for shortcuts.
  // Spreads out so the footer feels like claude-code's bottom bar.
  const leftSegs: string[] = [];
  if (footer.model) leftSegs.push(footer.model);
  if (footer.session) leftSegs.push(footer.session.slice(0, 16));
  if (footer.branch) leftSegs.push(footer.branch);
  if (footer.rightExtra) leftSegs.push(footer.rightExtra);

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text backgroundColor={pillBg} color={pillFg}>{` ◉ ${accessMode} `}</Text>
        {footer.effort ? (
          <>
            <Text> </Text>
            <Text backgroundColor={effortBg} color={pillFg}>{` ${footer.effort} `}</Text>
          </>
        ) : null}
        {leftSegs.length > 0 ? (
          <Text color="gray" dimColor wrap="truncate">{'  ' + leftSegs.join(' · ')}</Text>
        ) : null}
        {phase === 'turn-running' ? (
          <Text color="gray" dimColor wrap="truncate">{'  · running'}</Text>
        ) : null}
        {leftSegs.length === 0 && phase === 'idle' ? (
          <Text color="gray" dimColor wrap="truncate">{'  ' + promptLabel}</Text>
        ) : null}
      </Box>
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
