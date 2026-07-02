import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, useApp } from 'ink';
export { ScrollbackRow } from './ScrollbackRow.js';
import { type BackgroundTask } from '@kinqs/brainrouter-core/background';
import { useTerminalSize } from './useTerminalSize.js';
import { getFileIndex, matchFiles, extractAtToken } from './fileIndex.js';
import { appendHistory, LIVE } from '../../runtime/inputHistory.js';
import { flagSuggestions } from '../../runtime/slashFlags.js';
import { TuiRouterProvider, useTuiRouter, type TuiRoute } from './TuiRouter.js';
import { GridWorkspace } from './layouts/GridWorkspace.js';
import { Sidebar } from './components/Sidebar.js';
import { WelcomeView } from './views/WelcomeView.js';
import type { BannerInputs } from '../banner.js';
import { resolveTheme } from '../theme.js';
import { TuiHeader } from './components/TuiHeader.js';
import { FooterStatus } from './FooterStatus.js';

// REFAC-CHATAPP-SPLIT (0.4.17) — this file was a ~1.4k-line god component
// (types + the entire ChatAppContent hooks/keybindings/render + a pile of pure
// layout helpers). It's now a thin composition shell: the public type surface
// lives in ./ChatApp/types.js, the scrollback + live-stream subsystem in
// ./ChatApp/useScrollbackState.js, the global keybinding handler in
// ./ChatApp/useChatInput.js, the route/composer render blocks in ./ChatApp/*
// components, and the pure height/pack/filter helpers in ./ChatApp/layout.js.
// All of those are re-exported below so existing importers (tests + sibling
// components) see an unchanged surface. No behavior change.

/**
 * Ink-based chat REPL — replaces the readline-based `startREPL` shell.
 *
 * Layout:
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
 * Scrollback stays in Ink's normal render tree. It is tempting to use
 * `<Static>` for finished entries, but a chat shell has a permanently
 * live composer below it; on terminal resize, the Static/dynamic split
 * can leave old composer frames behind because the resize clear only
 * applies to Ink's live region. Keeping the full frame diffable makes
 * resize redraw exactly one prompt block.
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

// --- Public surface (types + pure helpers moved to ./ChatApp/*) --------

export type {
  ChatAppProps,
  FooterState,
  ChatController,
  ScrollbackEntry,
  PushScrollback,
  VisibleSlice,
} from './ChatApp/types.js';
export {
  estimateTextHeight,
  estimateEntryHeight,
  packVisibleLines,
  filterPaletteCommands,
} from './ChatApp/layout.js';

// REFAC-CHATAPP-SPLIT (0.4.6) — pure reasoning/effort helpers live in
// ./reasoningWindow.js now; re-exported here for the existing
// test/component importers.
export {
  REASONING_TAIL_CHARS,
  REASONING_VISIBLE_LINES,
  effortIndicator,
  tailReasoning,
  buildReasoningWindow,
} from './reasoningWindow.js';

// --- Internal-only imports (component wiring) -------------------------

import type { ChatAppProps, FooterState, ScrollbackEntry } from './ChatApp/types.js';
import {
  seedScrollback,
  estimateTextHeight,
  estimateEntryHeight,
  packVisibleLines,
  filterPaletteCommands,
  CHROME_RESERVED_ROWS,
} from './ChatApp/layout.js';
import { useScrollbackState } from './ChatApp/useScrollbackState.js';
import { useChatInput } from './ChatApp/useChatInput.js';
import { SessionView } from './ChatApp/SessionView.js';
import { WorkflowView, McpView } from './ChatApp/RouteViews.js';
import { ComposerChrome } from './ChatApp/ComposerChrome.js';

// --- Main app ---------------------------------------------------------

function ChatAppContent({
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
  workspaceRoot,
  bannerInputs,
}: ChatAppProps) {
  const { exit } = useApp();
  const { activeRoute, navigate } = useTuiRouter();
  // useTerminalSize subscribes to stdout 'resize' and pushes the new
  // width into React state, forcing a re-render. Reading
  // useStdout().stdout.columns inline LOOKS like it would work (it's a
  // live getter and Ink claims to re-render on resize), but in practice
  // the dividers + footer + slash palette were left at the OLD width
  // until the next unrelated state change — which is what causes the
  // duplicated/growing dash residue when dragging the window. See
  // useTerminalSize.ts for the full rationale.
  const { columns: cols, rows } = useTerminalSize();
  const theme = useMemo(() => resolveTheme(workspaceRoot), [workspaceRoot]);
  const showSidebar = cols >= 100;
  const mainWidth = showSidebar ? Math.floor(cols * 0.7) - 4 : cols;
  const sidebarWidth = showSidebar ? Math.floor(cols * 0.3) - 3 : 0;

  // Scrollback + live-streaming subsystem (scrollback state, id counter,
  // pinned child-fleet row, TIER-A live buffers + flush timer, pushFns).
  const {
    scrollback,
    setScrollback,
    nextIdRef,
    mainWidthRef,
    scrollOffset,
    setScrollOffset,
    liveAssistant,
    liveReasoning,
    spinnerLabel,
    setSpinnerLabel,
    phase,
    setPhase,
    pushFns,
  } = useScrollbackState(() => seedScrollback(workspaceRoot, initialOfflineWarning, initialHint));

  const viewportBudgetRef = useRef(20); // page-step size for PageUp/PageDown
  const scrollMaxRef = useRef(0); // top clamp (totalLines - budget)
  const [scrollMode, setScrollMode] = useState(false);
  // CC-P1.7 — Ctrl+R reverse history search: null = off; query + skip cycle.
  const [histSearch, setHistSearch] = useState<{ query: string; skip: number } | null>(null);
  // CC-P1.3 — Ctrl+O: expand/collapse tool previews + reasoning blocks globally.
  const [verboseTranscript, setVerboseTranscript] = useState(false);
  const [composerValue, setComposerValue] = useState('');
  // INPUT-ERGO — remount key for the composer TextInput. ink-text-input only
  // initializes its internal cursor at the END of `value` on MOUNT; an external
  // value change (Tab-complete, history recall, @/flag completion) leaves the
  // cursor mid-line. Bumping this key remounts the input so the cursor lands at
  // the end. `setComposerProgrammatic` is the one place that does both.
  const [composerKey, setComposerKey] = useState(0);
  const setComposerProgrammatic = useCallback((value: string) => {
    setComposerValue(value);
    setComposerKey((k) => k + 1);
  }, []);
  // INPUT-ERGO — manual typing exits history browse (so ↑/↓ restart from the
  // edited buffer). Programmatic sets go through `setComposerProgrammatic` and
  // remount the input, so they never fire this onChange.
  const onComposerChange = useCallback((next: string) => {
    setComposerValue(next);
    setHistIndex(LIVE);
  }, []);
  // INPUT-ERGO — shell-style input history. `histIndex === LIVE` means "not
  // browsing"; `histDraft` preserves the in-progress buffer while browsing.
  const [histEntries, setHistEntries] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState<number>(LIVE);
  const [histDraft, setHistDraft] = useState('');
  // INPUT-ERGO — flag-suggestion palette cursor (args mode, trailing `-token`).
  const [flagCursor, setFlagCursor] = useState(0);
  // BG-TASKS-PANEL — running workflows/workers/agents, refreshed by runChat's
  // ticker via controller.setBackgroundTasks. Empty → panel hidden.
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>([]);
  const [accessMode, setAccessMode] = useState<'read' | 'write' | 'shell'>(initialAccessMode);
  const [footer, setFooter] = useState<FooterState>(initialFooter);
  /**
   * Per-turn elapsed time, ticked once a second while phase === 'turn-running'.
   * Drives the amber spinner-color transition at 10s — claude-code's
   * "Claude is still working" cue (CHANGELOG v2.1.130 entry 154).
   */
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
  /**
   * Overlay slot — when set, hides the composer + palette and renders
   * the overlay node instead. Set via controller.showOverlay; cleared
   * via controller.clearOverlay. Used by runPicker/runTextField so
   * /config /login /init render inside the chat Ink (not as a second
   * Ink mount that would fight for stdin).
   */
  const [overlay, setOverlay] = useState<React.ReactElement | null>(null);
  const overlayResolveRef = useRef<(() => void) | null>(null);
  /**
   * Slash palette cursor — lifted out of SlashPalettePanel so this
   * component owns both the highlight + the keystroke handlers.
   * (useInput at the panel level would race with TextInput for arrow
   * keys; centralizing here makes the precedence explicit.)
   */
  const [paletteCursor, setPaletteCursor] = useState(0);

  const visibleScrollback = useMemo(() => {
    const maxHeight = Math.max(10, rows - CHROME_RESERVED_ROWS);
    const liveReasoningHeight = liveReasoning ? 8 : 0;
    const liveAssistantHeight = liveAssistant ? estimateTextHeight(liveAssistant, mainWidth) + 2 : 0;
    const budget = Math.max(5, maxHeight - liveReasoningHeight - liveAssistantHeight);
    const packed = packVisibleLines(scrollback, {
      budget,
      lineOffset: scrollOffset,
      estimateHeight: (e) => estimateEntryHeight(e, mainWidth, verboseTranscript),
    });
    // Refs for the scroll keys: page size + the top clamp (g / PageUp), and
    // the width used by push-time line-anchoring estimates.
    viewportBudgetRef.current = budget;
    scrollMaxRef.current = Math.max(0, packed.totalLines - budget);
    mainWidthRef.current = mainWidth;
    return packed;
  }, [scrollback, rows, liveReasoning, liveAssistant, mainWidth, scrollOffset, verboseTranscript]);

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
      replaceBanner: (text) => {
        setScrollback((rows) => {
          const idx = rows.findIndex((entry) => entry.kind === 'raw');
          if (idx < 0) return [{ id: ++nextIdRef.current, kind: 'raw', text, noWrap: true }, ...rows];
          return rows.map((entry, i) => i === idx ? { ...entry, text } : entry);
        });
      },
      setFooter: (patch) => {
        if (patch.accessMode) setAccessMode(patch.accessMode);
        setFooter((prev) => ({ ...prev, ...patch }));
      },
      setComposer: (text) => setComposerValue(text),
      showOverlay: (node) => new Promise<void>((resolve) => {
        // Save the resolver; clearOverlay() will fire it. Setting the
        // overlay React state hides the composer next render so the
        // overlay's own useInput hooks own keystrokes uncontested.
        overlayResolveRef.current = resolve;
        setOverlay(node);
      }),
      clearOverlay: () => {
        setOverlay(null);
        const r = overlayResolveRef.current;
        overlayResolveRef.current = null;
        if (r) r();
      },
      exit,
      setBackgroundTasks: (tasks) => setBgTasks(tasks),
    });
    // Run exactly once — the controller's identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slash palette visibility — open when input is just `/<query>`
  // with no whitespace yet (so the user is still composing the
  // command name, not args).
  // @-mention completion — derive matches from the trailing `@token` in
  // the composer. Empty token (just `@`) shows the top of the index so
  // the user discovers the feature. Disabled (no matches) when the
  // composer doesn't end with an @-token.
  const [atCursor, setAtCursor] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const atMatches = useMemo(() => {
    if (atDismissed) return [];
    const token = extractAtToken(composerValue);
    if (token === null) return [];
    const idx = getFileIndex(workspaceRoot ?? process.cwd());
    return token === '' ? idx.slice(0, 8) : matchFiles(idx, token, 8);
  }, [composerValue, atDismissed, workspaceRoot]);
  useEffect(() => {
    // Reset dismissal as soon as the user starts a fresh @-token.
    const token = extractAtToken(composerValue);
    if (token === null) {
      setAtDismissed(false);
      setAtCursor(0);
    } else {
      setAtCursor((c) => (atMatches.length === 0 ? 0 : Math.min(c, atMatches.length - 1)));
    }
  }, [composerValue, atMatches.length]);

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

  // INPUT-ERGO — flag suggestions when typing `--token` in args mode. Gated on
  // the other palettes being closed (mutually exclusive: slash palette needs no
  // space; @-palette needs a trailing @token — neither overlaps a `-` token).
  const flagMatches = useMemo(() => {
    if (slashQuery !== null || atMatches.length > 0) return [];
    return flagSuggestions(composerValue)?.matches ?? [];
  }, [composerValue, slashQuery, atMatches.length]);
  useEffect(() => {
    setFlagCursor((c) => (flagMatches.length === 0 ? 0 : Math.min(c, flagMatches.length - 1)));
  }, [flagMatches.length]);

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
    setScrollOffset(0);
    // INPUT-ERGO — record the submitted input for ↑/↓ recall and reset browse.
    setHistEntries((h) => appendHistory(h, trimmed));
    setHistIndex(LIVE);
    setHistDraft('');
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

  useChatInput({
    overlay,
    exit,
    histSearch,
    setHistSearch,
    histEntries,
    setComposerProgrammatic,
    setVerboseTranscript,
    scrollMode,
    setScrollMode,
    scrollMaxRef,
    viewportBudgetRef,
    setScrollOffset,
    slashQuery,
    atMatches,
    flagMatches,
    scrollback,
    activeRoute,
    navigate,
    setScrollback,
    onAccessModeCycle,
    setAccessMode,
    pushFns,
    atCursor,
    setAtCursor,
    setAtDismissed,
    composerValue,
    paletteMatches,
    paletteCursor,
    setPaletteCursor,
    flagCursor,
    setFlagCursor,
    histIndex,
    setHistIndex,
    histDraft,
    setHistDraft,
  });

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {overlay !== null ? (
        <>
          {overlay}
          <FooterStatus
            promptLabel={promptLabel}
            phase={phase}
            accentColor={accentColor}
            accessMode={accessMode}
            footer={footer}
            cols={cols}
          />
        </>
      ) : (
        <>
          <TuiHeader
            cols={cols}
            theme={theme}
            accentColor={accentColor}
            mcpProfile={bannerInputs?.mcpProfile}
            mcpTransport={bannerInputs?.mcpTransport}
            mcpOnline={bannerInputs?.mcpOnline}
            mcpIdentity={bannerInputs?.mcpIdentity}
          />
          <GridWorkspace
            cols={cols}
            mainWidth={mainWidth}
            sidebarWidth={sidebarWidth}
            flexGrow={1}
            sidebar={
              <Sidebar
                model={footer.model}
                session={footer.session}
                branch={footer.branch}
                effort={footer.effort}
                accessMode={accessMode}
                workspaceRoot={workspaceRoot}
                bgTasks={bgTasks}
                scrollback={scrollback}
                mcpProfile={bannerInputs?.mcpProfile}
                mcpTransport={bannerInputs?.mcpTransport}
                mcpOnline={bannerInputs?.mcpOnline}
                mcpIdentity={bannerInputs?.mcpIdentity}
                width={sidebarWidth}
              />
            }
          >
            {/* The active route view */}
            {activeRoute === 'home' ? (
              <WelcomeView workspaceRoot={workspaceRoot ?? process.cwd()} accentColor={accentColor} />
            ) : activeRoute === 'session' ? (
              <SessionView
                visibleScrollback={visibleScrollback}
                accentColor={accentColor}
                mainWidth={mainWidth}
                verboseTranscript={verboseTranscript}
                liveReasoning={liveReasoning}
                liveAssistant={liveAssistant}
              />
            ) : activeRoute === 'workflow' ? (
              <WorkflowView bgTasks={bgTasks} />
            ) : (
              <McpView />
            )}
          </GridWorkspace>

          <ComposerChrome
            phase={phase}
            liveAssistant={liveAssistant}
            liveReasoning={liveReasoning}
            turnElapsedMs={turnElapsedMs}
            spinnerLabel={spinnerLabel}
            cols={cols}
            accentColor={accentColor}
            histSearch={histSearch}
            histEntries={histEntries}
            scrollMode={scrollMode}
            composerKey={composerKey}
            composerValue={composerValue}
            onComposerChange={onComposerChange}
            onComposerSubmit={onComposerSubmit}
            slashQuery={slashQuery}
            paletteMatches={paletteMatches}
            paletteCursor={paletteCursor}
            flagMatches={flagMatches}
            flagCursor={flagCursor}
            atMatches={atMatches}
            atCursor={atCursor}
            promptLabel={promptLabel}
            accessMode={accessMode}
            footer={footer}
          />
        </>
      )}
    </Box>
  );
}

export function ChatApp(props: ChatAppProps) {
  return (
    <TuiRouterProvider initialRoute="session">
      <ChatAppContent {...props} />
    </TuiRouterProvider>
  );
}
