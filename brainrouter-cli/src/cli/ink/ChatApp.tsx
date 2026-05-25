import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { SlashPalette, type SlashCommandDef } from './SlashPalette.js';
import { classifyDiffLine, looksLikeDiff } from './toolFormat.js';
import { renderMarkdown } from './markdownRender.js';

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

// marked + marked-terminal are configured in ./markdownRender.ts so the
// Ink path has its own knob set (no internal wrapping, stronger heading
// hierarchy, fence unwrapping, ANSI re-scoping). Don't reconfigure here.

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
  /**
   * Tool call result row — claude-code style:
   *   ⏺ Read(src/foo.ts)            (green ⏺ when ok, red when failed)
   *     ⎿ <preview line 1>          (if preview present, with ⎿ connector)
   *       <preview line 2>           (continuation lines plain indent)
   *       (+N more lines hidden)     (truncation hint)
   * `header` is the formatToolCall'd string. `kind` of preview rendering
   * is derived: if the preview looks like a diff, lines colored +green/-red.
   */
  | { id: number; kind: 'tool'; header: string; ok: boolean; durationMs?: number; preview?: string }
  | { id: number; kind: 'memory'; level: 'info' | 'warn'; text: string }
  /** Plan rendering: optional `explanation` renders above the checklist as a dim line. */
  | { id: number; kind: 'plan'; items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]; explanation?: string }
  /** Notice severity:  info → gray dim · warn → yellow · error → red bold. */
  | { id: number; kind: 'notice'; text: string; level?: 'info' | 'warn' | 'error' };

export interface PushScrollback {
  raw(text: string): void;
  user(text: string): void;
  /** `raw: true` skips marked-terminal rendering (use when caller already pre-rendered or user wants raw scrollback). */
  assistant(text: string, meta?: { raw?: boolean; durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }): void;
  /**
   * `header` is the formatted call (e.g. `Read(src/foo.ts)` from
   * `formatToolCall` in toolFormat.ts), NOT the raw tool name. Pass the
   * full result preview unmodified — the renderer applies diff coloring
   * + truncation hints.
   */
  tool(header: string, ok: boolean, opts?: { preview?: string; durationMs?: number }): void;
  memory(level: 'info' | 'warn', text: string): void;
  plan(items: { step: string; status: 'pending' | 'in_progress' | 'completed' }[], explanation?: string): void;
  /** Severity defaults to 'info' when omitted (back-compat). */
  notice(text: string, level?: 'info' | 'warn' | 'error'): void;
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
   * Per-turn elapsed time, ticked once a second while phase === 'turn-running'.
   * Drives the amber spinner-color transition at 10s — claude-code's
   * "Claude is still working" cue (CHANGELOG v2.1.130 entry 154).
   */
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
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
      tool: (header, ok, opts) => push({ kind: 'tool', header, ok, ...opts }),
      memory: (level, text) => push({ kind: 'memory', level, text }),
      plan: (items, explanation) => push({ kind: 'plan', items, explanation }),
      notice: (text, level) => push({ kind: 'notice', text, level: level ?? 'info' }),
      setStatus: (label) => setSpinnerLabel(label),
      setPhase: (p) => setPhase(p),
    };
  }, []);

  // Tick the per-turn elapsed time while a turn is running. Resets to 0
  // on each phase change. Spinner color blends from green → amber when
  // this crosses 10s, matching claude-code's "still working" cue
  // (CHANGELOG v2.1.130 entry 154).
  useEffect(() => {
    if (phase !== 'turn-running') {
      setTurnElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setTurnElapsedMs(0);
    const interval = setInterval(() => {
      setTurnElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

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

      {/* Active turn spinner. Warms to amber after 10s ("still working"
          cue lifted from claude-code v2.1.130). Label is the runChat
          adapter's status text — typically the formatted active tool. */}
      {phase === 'turn-running' ? (
        <Box>
          <Text color={turnElapsedMs >= 10_000 ? 'yellow' : 'green'}>
            {React.createElement(Spinner as any, { type: 'dots' })}
          </Text>
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

/**
 * Per-entry renderer — every scrollback kind has its own claude-code-style
 * layout. Glyph conventions:
 *
 *   ⏺  assistant turn (first line) — green dot
 *   ❯  user prompt (left margin)   — accent (orange)
 *   ⏺  tool call header            — green dot when ok, red when failed
 *   ⎿  tool result connector       — first line of preview
 *   ✓ / ✗  status mark             — final status line of tool block
 *   ↳  plan / memory dim-italic explanation
 */
function ScrollbackRow({ entry, accentColor }: { entry: ScrollbackEntry; accentColor: string }) {
  switch (entry.kind) {
    case 'raw':
      return <Text>{entry.text}</Text>;
    case 'user':
      // Flex layout: ❯ on the left, prompt body in an inner column that
      // takes the remaining width. Continuation lines (when the user
      // pastes a multi-line prompt) align under the body column, not
      // under the caret.
      return (
        <Box marginTop={1}>
          <Text color={accentColor}>❯ </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{entry.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant': {
      // Pass the WHOLE rendered markdown to a single <Text> instead of
      // splitting on \n and re-rendering each line. The old line-split
      // approach broke ANSI styling that spans newlines — e.g. a
      // multi-line blockquote whose `gray italic` open code sat on line
      // 1 but whose close code sat on line 3 lost its style on lines
      // 2-3. `renderMarkdown` re-scopes the styling per line so the
      // single <Text> reads cleanly.
      //
      // The `⏺` lives in its own Text to the left of the body. The body
      // Box has flexGrow=1 so it takes the remaining terminal width and
      // Ink's wrap-ansi handles reflow inside it. Continuation lines
      // (both from wrap and from explicit \n in the rendered output)
      // align under the body column.
      //
      // `entry.raw === true` (user's rawScrollback preference) skips
      // marked entirely — useful when the user wants to see the LLM's
      // literal markdown source.
      const rendered = (entry.raw ? entry.text : renderMarkdown(entry.text)).trimEnd();
      const meta = entry.durationMs !== undefined
        ? `  ${Math.floor(entry.durationMs / 1000)}s${entry.tokensIn !== undefined ? ` · ${entry.tokensIn.toLocaleString()} in / ${entry.tokensOut?.toLocaleString() ?? 0} out` : ''}`
        : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="green">⏺ </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Text>{rendered}</Text>
            </Box>
          </Box>
          {meta ? (
            <Box paddingLeft={2}>
              <Text color="gray" dimColor>{meta}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'tool': {
      // Claude-code layout:
      //   ⏺ Read(src/foo.ts)
      //     ⎿ <line 1 of preview>
      //       <line 2 of preview>
      //       (+N more lines hidden)
      // The header DOT is green on success and red on failure so the user
      // can scan a long turn at a glance. Duration appended in dim if set.
      const dotColor = entry.ok ? 'green' : 'red';
      const previewLines = entry.preview ? splitForPreview(entry.preview) : null;
      const isDiff = entry.preview ? looksLikeDiff(entry.preview) : false;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={dotColor}>⏺ </Text>
            <Text wrap="truncate">{entry.header}</Text>
            {entry.durationMs !== undefined ? (
              <Text color="gray" dimColor>{`  · ${formatDuration(entry.durationMs)}`}</Text>
            ) : null}
            {!entry.ok ? (
              <Text color="red" dimColor>{'  · failed'}</Text>
            ) : null}
          </Box>
          {previewLines ? previewLines.visible.map((line, i) => (
            <ToolPreviewLine
              key={i}
              line={line}
              isFirst={i === 0}
              isDiff={isDiff}
            />
          )) : null}
          {previewLines && previewLines.hidden > 0 ? (
            <Box>
              <Text color="gray" dimColor>{`    (+${previewLines.hidden} more line${previewLines.hidden === 1 ? '' : 's'} hidden)`}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'memory':
      // Memory pipeline events — briefing / capture / citation / contradiction.
      // Warnings (contradictions, extraction failures) stand out; info events
      // stay dim so the chat doesn't drown in capture chatter.
      return (
        <Box>
          <Text
            color={entry.level === 'warn' ? 'yellow' : 'gray'}
            bold={entry.level === 'warn'}
            dimColor={entry.level === 'info'}
            wrap="truncate"
          >
            {entry.level === 'warn' ? '⚠ ' : '· '}{entry.text}
          </Text>
        </Box>
      );
    case 'plan':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" bold>📋 Plan</Text>
          {entry.explanation ? (
            <Box marginBottom={1}>
              <Text color="gray" dimColor italic>   ↳ {entry.explanation}</Text>
            </Box>
          ) : null}
          {entry.items.map((item, i) => {
            const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '⏳' : '☐';
            const color = item.status === 'completed' ? 'green' : item.status === 'in_progress' ? 'yellow' : 'gray';
            // Multi-line steps indent under the first line so the checkbox
            // anchor stays visually attached to the whole step.
            const stepLines = String(item.step).split('\n');
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={color}>  {mark} </Text>
                  <Text color={item.status === 'completed' ? 'gray' : undefined}>{stepLines[0]}</Text>
                </Box>
                {stepLines.slice(1).map((line, j) => (
                  <Box key={j}>
                    <Text>{'      '}</Text>
                    <Text color={item.status === 'completed' ? 'gray' : undefined} dimColor>{line}</Text>
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      );
    case 'notice': {
      // info  → gray dim
      // warn  → yellow
      // error → red bold
      const level = entry.level ?? 'info';
      const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'gray';
      return (
        <Box>
          <Text color={color} bold={level === 'error'} dimColor={level === 'info'} wrap="truncate">
            {entry.text}
          </Text>
        </Box>
      );
    }
  }
}

/**
 * Render one line of a tool-result preview. Diff lines get red/green
 * coloring (see classifyDiffLine). The first line of the preview is
 * prefixed with `⎿` connector under the tool header; continuation lines
 * just indent to align with the connector body.
 */
function ToolPreviewLine({ line, isFirst, isDiff }: { line: string; isFirst: boolean; isDiff: boolean }) {
  const indent = isFirst ? '    ⎿ ' : '      ';
  let textColor: string | undefined = 'gray';
  let dim = true;
  if (isDiff) {
    const kind = classifyDiffLine(line);
    if (kind === 'add') { textColor = 'green'; dim = false; }
    else if (kind === 'del') { textColor = 'red'; dim = false; }
    else if (kind === 'hunk') { textColor = 'cyan'; dim = true; }
  }
  return (
    <Box>
      <Text color="gray" dimColor>{indent}</Text>
      <Text color={textColor} dimColor={dim} wrap="truncate">{line}</Text>
    </Box>
  );
}

const TOOL_PREVIEW_MAX_LINES = 8;

/** Split preview into the visible head + the count of hidden tail lines. */
function splitForPreview(preview: string): { visible: string[]; hidden: number } {
  const lines = preview.split('\n');
  if (lines.length <= TOOL_PREVIEW_MAX_LINES) return { visible: lines, hidden: 0 };
  return { visible: lines.slice(0, TOOL_PREVIEW_MAX_LINES), hidden: lines.length - TOOL_PREVIEW_MAX_LINES };
}

/** Human-readable duration: 950ms, 1.2s, 12s, 1m 23s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
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
  // Effort glyphs — claude-code v2.1.147 convention:
  //   low    → ○ (open circle, light)
  //   medium → ◐ (half circle)
  //   high   → ● (filled circle, heavy)
  // Rendered inline next to the pill, not as a separate boxed pill, so
  // the footer stays compact on narrow terminals.
  const effortGlyph = footer.effort === 'high' ? '●' : footer.effort === 'medium' ? '◐' : footer.effort === 'low' ? '○' : '';
  const effortColor = footer.effort === 'high' ? 'magenta' : footer.effort === 'medium' ? 'yellow' : 'gray';

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
        {effortGlyph ? (
          <>
            <Text> </Text>
            <Text color={effortColor}>{effortGlyph}</Text>
            <Text color="gray" dimColor>{` ${footer.effort}`}</Text>
          </>
        ) : null}
        {leftSegs.length > 0 ? (
          <Text color="gray" dimColor wrap="truncate">{'  ' + leftSegs.join(' · ')}</Text>
        ) : null}
        {phase === 'turn-running' ? (
          <Text color="gray" dimColor wrap="truncate">{'  · running'}</Text>
        ) : null}
        {leftSegs.length === 0 && phase === 'idle' && !footer.effort ? (
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
