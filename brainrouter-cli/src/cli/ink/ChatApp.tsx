import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { SlashPalette, type SlashCommandDef } from './SlashPalette.js';
import { SlashPalettePanel } from './SlashPalettePanel.js';
import { FooterStatus } from './FooterStatus.js';
import { ScrollbackRow } from './ScrollbackRow.js';
export { ScrollbackRow } from './ScrollbackRow.js';
import { type BackgroundTask, formatBackgroundTasks, summarizeTasks } from '@kinqs/brainrouter-core/dist/background/backgroundTasks.js';
import { useTerminalSize } from './useTerminalSize.js';
import { getFileIndex, matchFiles, extractAtToken, applyAtCompletion } from './fileIndex.js';
import { appendHistory, historyPrev, historyNext, searchHistory, LIVE } from '../../runtime/inputHistory.js';
import { flagSuggestions, applyFlagCompletion } from '../../runtime/slashFlags.js';
// 0.3.9 — show the model's max prompt-context window in the footer next
// to the model name (e.g. `gpt-4o-mini · 128k ctx · session-…`).
import { formatContextWindow } from '@kinqs/brainrouter-core/dist/context/contextWindow.js';
import { TuiRouterProvider, useTuiRouter, type TuiRoute } from './TuiRouter.js';
import { GridWorkspace } from './layouts/GridWorkspace.js';
import { renderMarkdown } from './markdownRender.js';
import { Sidebar } from './components/Sidebar.js';
import { WelcomeView } from './views/WelcomeView.js';
import type { BannerInputs } from '../banner.js';
import { resolveTheme } from '../theme.js';
import { TuiHeader } from './components/TuiHeader.js';
import { VERSION } from '@kinqs/brainrouter-core/dist/version.js';

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

// --- Public props ------------------------------------------------------

export interface ChatAppProps {
  initialBanner: string;
  initialOfflineWarning?: string;
  initialHint: string;
  /** Workspace root for @-mention file completions. Defaults to cwd. */
  workspaceRoot?: string;
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
  bannerInputs?: BannerInputs;
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
  /**
   * Count of background child agents (delegate_agent / fire-and-forget
   * spawn_agent) currently in `pending` or `running` status. When > 0 the
   * footer renders "· N working" even if the parent turn has yielded back
   * to idle — without this the user can't tell the CLI is still doing work
   * and has to run /where to check. Refreshed on every child lifecycle
   * event and once per turn boundary.
   */
  runningChildren?: number;
}

export interface ChatController {
  /** Push entries from outside the React tree (e.g. after the parent turn ended). */
  push: PushScrollback;
  /** Replace the startup banner row without clearing the chat scrollback. */
  replaceBanner: (text: string) => void;
  /** Update the footer status row (model, session, access mode, effort, etc.). */
  setFooter: (patch: Partial<FooterState & { accessMode: 'read' | 'write' | 'shell' }>) => void;
  /** Programmatically inject text into the composer (e.g. workflow.ts loop tick). */
  setComposer: (text: string) => void;
  /**
   * Render `node` as an overlay above the chat composer. The composer
   * hides while the overlay is active so the overlay's own useInput
   * handlers own keystrokes. Used by `runPicker` / `runTextField` to
   * show /config, /login, /init pickers WITHOUT mounting a second Ink
   * instance (which would race the chat for stdin and terminal state).
   * Promise resolves when `clearOverlay()` is called.
   */
  showOverlay: (node: React.ReactElement) => Promise<void>;
  /** Remove whatever overlay is currently shown; safe to call when none is set. */
  clearOverlay: () => void;
  /** Exit the chat app gracefully. */
  exit: () => void;
  /** Update the live background-tasks panel (running workflows / workers /
   *  agents). Pass an empty array to hide it. */
  setBackgroundTasks: (tasks: BackgroundTask[]) => void;
}

export type ScrollbackEntry = (
  | { id: number; kind: 'raw'; text: string; noWrap?: boolean }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; raw?: boolean; durationMs?: number; tokensIn?: number; tokensOut?: number; calls?: number }
  /**
   * Tool call result row:
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
  | { id: number; kind: 'notice'; text: string; level?: 'info' | 'warn' | 'error' }
  /**
   * Multi-line child-agent completion block — green ✓ header + indented
   * wrapped body containing the agent's actual headline/summary. Replaces
   * the old single-line `🏁 Agent X — Y` notice that was being clipped at
   * terminal width by Ink's `wrap="truncate"`. The body wraps freely so the
   * user can read the agent's findings without running /agent transcript.
   */
  | { id: number; kind: 'agent-result'; childId: string; role: string; status: 'completed' | 'failed'; body: string }
  /** TIER B compaction row. */
  | { id: number; kind: 'compaction'; droppedMessages: number; keptMessages: number; summary: string }
  /**
   * Persisted reasoning / chain-of-thought block. Rendered dim-italic
   * with a 💭 marker so it's visually distinct from prose. Stays in
   * scrollback after the LLM call ends so users can scroll back and
   * read what the model was thinking.
   */
  | { id: number; kind: 'reasoning'; text: string }
  /**
   * Pinned multi-agent fleet row — surfaces ALL currently-running children
   * at once so users see parallelism. Updates in place via setChildFleet
   * (controller.push.setChildFleet) instead of pushing a new row per
   * event. Removed when the fleet drains to zero.
   */
  | { id: number; kind: 'child-fleet'; children: Array<{ childId: string; role: string; tool?: string }>; }
) & { timestamp?: Date };

export interface PushScrollback {
  raw(text: string, opts?: { noWrap?: boolean }): void;
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
  /** Multi-line agent completion block — used by spawn_agent's onChildComplete callback in runChat. */
  agentResult(event: { childId: string; role: string; status: 'completed' | 'failed'; body: string }): void;
  /** Update the live spinner label (e.g. "Thinking  5s  1.2k↑ 0.4k↓"). */
  setStatus(label: string): void;
  /** Show / hide the spinner without pushing a scrollback entry. */
  setPhase(phase: 'idle' | 'turn-running'): void;
  /**
   * TIER A live-streaming API. The agent pushes incremental text via
   * `assistantDelta`; the chat renders a transient row beneath the
   * scrollback. `assistantDeltaEnd` clears the transient buffer — the
   * caller is responsible for pushing the final `assistant(...)` entry
   * afterwards (so token / duration metadata can ride along).
   */
  assistantDeltaStart(): void;
  assistantDelta(chunk: string): void;
  assistantDeltaEnd(): void;
  /** Streaming reasoning (chain-of-thought) preview. Replaces, not appends. */
  reasoningDelta(chunk: string): void;
  /** Visible compaction notice. */
  compaction(event: { droppedMessages: number; keptMessages: number; summary: string }): void;
  /**
   * Update (or remove) the pinned child-fleet row. Pass an empty array
   * to remove the row entirely. Pass N>=1 to add or replace it; the row
   * lives at a stable id so updates don't churn scrollback.
   */
  setChildFleet(children: Array<{ childId: string; role: string; tool?: string }>): void;
  /**
   * Multi-agent batch-spawn notice. Renders `🚀 Spawned N agents in
   * parallel: a, b, c` as a single scrollback row so the user sees the
   * launch as one event instead of N interleaved "▶ X running" lines.
   */
  spawnBatch(children: Array<{ childId: string; role: string }>): void;
}

// Max characters of reasoning to display in the live dim-italic block.
// Long chains-of-thought (10k+ chars) used to reflow the whole Ink
// frame on every flush — the dim block grew unbounded and dominated
// the viewport, making scrolling feel jittery as it pushed older
// scrollback off-screen. We render only the trailing window during
// streaming; the full text is still committed to scrollback as a
// 'reasoning' entry on call-end (see assistantDeltaEnd) so users can
// scroll back and read the entire chain. ~1.5 KB is roughly 20-30
// lines on a typical 100-col terminal — enough to feel live without
// overwhelming the layout.
// REFAC-CHATAPP-SPLIT (0.4.6) — pure reasoning/effort helpers live in
// ./reasoningWindow.js now; imported for use here and re-exported for the
// existing test/component importers.
import {
  REASONING_TAIL_CHARS,
  REASONING_VISIBLE_LINES,
  effortIndicator,
  tailReasoning,
  buildReasoningWindow,
} from './reasoningWindow.js';
export {
  REASONING_TAIL_CHARS,
  REASONING_VISIBLE_LINES,
  effortIndicator,
  tailReasoning,
  buildReasoningWindow,
} from './reasoningWindow.js';

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

  const [scrollback, setScrollback] = useState<ScrollbackEntry[]>(() => seedScrollback(workspaceRoot, initialOfflineWarning, initialHint));
  const nextIdRef = useRef(scrollback.length);
  // CC-P1.1 — scroll position in VISUAL LINES from the bottom of history
  // (0 = stuck to the latest output). Line-granular so w/s glide smoothly.
  const [scrollOffset, setScrollOffset] = useState(0);
  const viewportBudgetRef = useRef(20); // page-step size for PageUp/PageDown
  const scrollMaxRef = useRef(0); // top clamp (totalLines - budget)
  const mainWidthRef = useRef(80); // width for push-time height estimates
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
  // TIER A: transient live-assistant + reasoning rows shown beneath the
  // scrollback while the model streams. Cleared when the agent fires
  // assistantDeltaEnd() and the final assistant() row lands in scrollback.
  const [liveAssistant, setLiveAssistant] = useState<string>('');
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  // Throttle delta-driven setState to ~30Hz so a high-rate token stream
  // doesn't pin the Ink reconciler. We accumulate into a ref-buffer and
  // flush on a timer.
  const liveAssistantBufRef = useRef<string>('');
  // Reasoning is also streamed, and the *previous* implementation
  // replaced state with just the latest chunk — so the dim-italic row
  // flashed one token at a time instead of building up. We now
  // accumulate in a ref-buffer (same pattern as the assistant stream)
  // and render the trailing window so long chains-of-thought don't
  // dominate the viewport.
  const liveReasoningBufRef = useRef<string>('');
  // Single shared flush timer for BOTH assistant + reasoning streams.
  // Originally each had its own 33ms timer which meant two independent
  // setState calls per ~33ms, doubling the re-render rate of the entire
  // tree and producing visible flicker. Coalescing into one timer at
  // 80ms gives us ~12Hz which is still visually fluid for token
  // streaming while letting the reconciler breathe between frames.
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Back-compat aliases kept so any code path still touching the
  // per-stream timer refs (e.g. cancellation paths in turn-end) sees
  // the same shared timer. assistantDeltaEnd / assistant() clear via
  // these names; pointing both at the shared ref keeps that working.
  const liveAssistantFlushTimerRef = liveFlushTimerRef;
  const liveReasoningFlushTimerRef = liveFlushTimerRef;
  const scheduleLiveFlush = useCallback(() => {
    if (liveFlushTimerRef.current) return;
    liveFlushTimerRef.current = setTimeout(() => {
      liveFlushTimerRef.current = null;
      // Single render pass for both streams — React 18 auto-batches
      // setState calls in timers/microtasks, but being explicit makes
      // the intent clear: one frame, not two.
      setLiveAssistant(liveAssistantBufRef.current);
      setLiveReasoning(liveReasoningBufRef.current);
    }, 80);
  }, []);
  // Stable id of the pinned child-fleet row (when present). Lets
  // setChildFleet update the same row in place instead of churning a
  // new entry on every child tool event. -1 means no row currently shown.
  const childFleetIdRef = useRef<number>(-1);

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

  const pushFns = useMemo<PushScrollback>(() => {
    const push = (entry: any) => {
      // Stick to the bottom ONLY when already at the bottom. If the user has
      // scrolled up to read history, keep their viewport LINE-anchored: bump
      // the line offset by the new entry's estimated height so the content
      // they're reading doesn't shift (the old yank-on-every-push bug).
      setScrollOffset((prev) => {
        if (prev <= 0) return 0;
        const h = Math.max(1, estimateEntryHeight({ id: -1, timestamp: new Date(), ...entry } as ScrollbackEntry, mainWidthRef.current));
        return prev + h;
      });
      setScrollback((s) => {
        const id = ++nextIdRef.current;
        return [...s, { id, timestamp: new Date(), ...entry } as ScrollbackEntry];
      });
    };
    return {
      raw: (text, opts) => push({ kind: 'raw', text, noWrap: opts?.noWrap }),
      user: (text) => { setScrollOffset(0); push({ kind: 'user', text }); },
      assistant: (text, meta) => {
        // The final assistant message for the turn is landing — clear
        // any leftover live-stream state so we don't double-render it.
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        liveAssistantBufRef.current = '';
        liveReasoningBufRef.current = '';
        setLiveAssistant('');
        setLiveReasoning('');
        push({ kind: 'assistant', text, ...meta });
      },
      tool: (header, ok, opts) => push({ kind: 'tool', header, ok, ...opts }),
      memory: (level, text) => push({ kind: 'memory', level, text }),
      plan: (items, explanation) => push({ kind: 'plan', items, explanation }),
      notice: (text, level) => push({ kind: 'notice', text, level: level ?? 'info' }),
      agentResult: (event) => push({ kind: 'agent-result', childId: event.childId, role: event.role, status: event.status, body: event.body }),
      setStatus: (label) => setSpinnerLabel(label),
      setPhase: (p) => setPhase(p),
      assistantDeltaStart: () => {
        // A new LLM call is streaming. If there's leftover text from a
        // PRIOR call in this same turn (model emitted a preamble, then
        // tool-called, now coming back for the real answer), commit it
        // as its own scrollback row first so it doesn't vanish. Same
        // treatment for the reasoning buffer.
        const carryAssistant = liveAssistantBufRef.current;
        if (carryAssistant && carryAssistant.trim()) {
          push({ kind: 'assistant', text: carryAssistant });
        }
        const carryReasoning = liveReasoningBufRef.current;
        if (carryReasoning && carryReasoning.trim()) {
          push({ kind: 'reasoning', text: carryReasoning });
        }
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        liveAssistantBufRef.current = '';
        liveReasoningBufRef.current = '';
        setLiveAssistant('');
        setLiveReasoning('');
      },
      assistantDelta: (chunk) => {
        liveAssistantBufRef.current += chunk;
        scheduleLiveFlush();
      },
      assistantDeltaEnd: () => {
        // Stop appending and flush whatever's pending so the visible
        // row matches the model's final text. Do NOT clear — clearing
        // here was the "text vanishes" bug: for intermediate LLM calls
        // (preamble → tool → real answer) the text gets wiped before
        // anything commits it. We let it persist; the NEXT
        // assistantDeltaStart commits it as a row, and the final
        // assistant(...) push clears the live state with metadata.
        if (liveAssistantFlushTimerRef.current) {
          clearTimeout(liveAssistantFlushTimerRef.current);
          liveAssistantFlushTimerRef.current = null;
        }
        setLiveAssistant(liveAssistantBufRef.current);
        // Commit the reasoning block to scrollback so the chain-of-thought
        // persists for scrollback review. The next LLM call's reasoning
        // gets its own block via assistantDeltaStart's carry-commit.
        if (liveReasoningFlushTimerRef.current) {
          clearTimeout(liveReasoningFlushTimerRef.current);
          liveReasoningFlushTimerRef.current = null;
        }
        const finalReasoning = liveReasoningBufRef.current;
        if (finalReasoning && finalReasoning.trim()) {
          push({ kind: 'reasoning', text: finalReasoning });
        }
        liveReasoningBufRef.current = '';
        setLiveReasoning('');
      },
      reasoningDelta: (chunk) => {
        // Stream the FULL reasoning the same way prose streams: append
        // to the buffer and render the whole thing in a dim-italic
        // block. Throttled to ~33Hz so a fast token rate doesn't pin
        // Ink. On call-end the buffer is committed to scrollback as a
        // persistent `reasoning` entry so users can scroll back and
        // read it later.
        const safe = chunk.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
        liveReasoningBufRef.current += safe;
        scheduleLiveFlush();
      },
      compaction: (event) => push({ kind: 'compaction', droppedMessages: event.droppedMessages, keptMessages: event.keptMessages, summary: event.summary }),
      setChildFleet: (children) => {
        setScrollback((rows) => {
          const currentId = childFleetIdRef.current;
          // Empty → remove the pinned row (if any).
          if (children.length === 0) {
            if (currentId < 0) return rows;
            childFleetIdRef.current = -1;
            return rows.filter((r) => r.id !== currentId);
          }
          // Existing row → update in place.
          if (currentId >= 0) {
            const idx = rows.findIndex((r) => r.id === currentId);
            if (idx >= 0) {
              const next = rows.slice();
              next[idx] = { id: currentId, kind: 'child-fleet', children };
              return next;
            }
          }
          // New row → push and remember id.
          const id = ++nextIdRef.current;
          childFleetIdRef.current = id;
          return [...rows, { id, kind: 'child-fleet', children }];
        });
      },
      spawnBatch: (children) => {
        if (children.length === 0) return;
        const names = children.map((c) => {
          const idShort = c.childId.startsWith('agent-') ? c.childId.slice(0, 14) : `agent-${c.childId.slice(0, 8)}`;
          return `${idShort} (${c.role})`;
        }).join(', ');
        const prefix = children.length > 1
          ? `🚀 Spawned ${children.length} agents in parallel`
          : `🚀 Spawned 1 agent`;
        push({ kind: 'notice', text: `${prefix}: ${names}`, level: 'info' });
      },
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

  // Ctrl+D / Ctrl+C exit; Shift+Tab cycles access mode; while the
  // slash palette is open, arrow keys navigate it and Tab autocompletes
  // the highlighted command into the composer.
  //
  // CRITICAL: when an overlay is active (e.g. /config picker), this
  // handler returns immediately so the overlay's useInput owns every
  // keystroke uncontested. Without this, Ctrl+C / Shift+Tab would
  // still fire from chat-level and cause double-handling — the kind
  // of bug that makes "/config exits to bash" symptoms.
  useInput((input, key) => {
    if (overlay !== null) return;
    // Ctrl+C / Ctrl+D always exit, even from scroll mode.
    if (key.ctrl && (input === 'c' || input === 'd')) { exit(); return; }
    // SCROLL MODE — toggle with Esc. While on, the composer is INACTIVE
    // (focus=false), so plain keys scroll instead of typing into the prompt:
    //   w / k / ↑ = up · s / j / ↓ = down · g / G = top / bottom · Esc / i / Enter = type
    // This is the only way to scroll with letter keys without them being typed.
    // CC-P1.7 — reverse history search owns the keyboard while active. The
    // composer is defocused (focus prop below), so plain chars build the query
    // instead of typing into the prompt; Ctrl+R cycles older matches; Enter
    // accepts the match into the composer; Esc cancels.
    if (histSearch !== null) {
      const match = searchHistory(histEntries, histSearch.query, histSearch.skip);
      if (key.return) {
        if (match) setComposerProgrammatic(match.value);
        setHistSearch(null);
      } else if (key.escape) {
        setHistSearch(null);
      } else if (key.ctrl && (input === 'r' || input === 'R')) {
        setHistSearch((h) => h ? { ...h, skip: h.skip + 1 } : h);
      } else if (key.backspace || key.delete) {
        setHistSearch((h) => h ? { query: h.query.slice(0, -1), skip: 0 } : h);
      } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setHistSearch((h) => h ? { query: h.query + input, skip: 0 } : h);
      }
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      setHistSearch({ query: '', skip: 0 });
      return;
    }
    // CC-P1.3 — Ctrl+O toggles the verbose transcript (full tool previews).
    if (key.ctrl && (input === 'o' || input === 'O')) {
      setVerboseTranscript((v) => !v);
      return;
    }
    if (scrollMode) {
      // CC-P1.1 — LINE-granular: w/s move one visual line (holding glides
      // smoothly); PageUp/Dn move a viewport page; g/G jump top/bottom.
      const top = scrollMaxRef.current;
      const page = Math.max(3, viewportBudgetRef.current - 2);
      if (input === 'w' || input === 'k' || key.upArrow) {
        setScrollOffset((p) => Math.min(top, p + 1));
      } else if (input === 's' || input === 'j' || key.downArrow) {
        setScrollOffset((p) => Math.max(0, p - 1));
      } else if (key.pageUp) {
        setScrollOffset((p) => Math.min(top, p + page));
      } else if (key.pageDown) {
        setScrollOffset((p) => Math.max(0, p - page));
      } else if (input === 'g') {
        setScrollOffset(top);
      } else if (input === 'G') {
        setScrollOffset(0);
      } else if (key.escape || key.return || input === 'i' || input === 'q') {
        setScrollMode(false);
      }
      return;
    }
    // Enter scroll mode with Esc when no palette / completion popup owns the key.
    if (key.escape && slashQuery === null && atMatches.length === 0 && flagMatches.length === 0) {
      setScrollMode(true);
      return;
    }
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(scrollback.length - 1, prev + 5));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - 5));
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      exit();
      return;
    }
    if (key.ctrl && key.tab) {
      const routes: TuiRoute[] = ['home', 'session', 'workflow', 'mcp'];
      const nextIdx = (routes.indexOf(activeRoute) + 1) % routes.length;
      navigate(routes[nextIdx]);
      return;
    }
    if (key.meta) {
      if (input === '1') { navigate('home'); return; }
      if (input === '2') { navigate('session'); return; }
      if (input === '3') { navigate('workflow'); return; }
      if (input === '4') { navigate('mcp'); return; }
    }
    // Ctrl+L clears the visible scrollback (terminal-level) and the
    // in-memory entry list, leaving only the banner. Standard REPL UX
    // — when long sessions feel cluttered, the user can hard-reset the
    // viewport without restarting the CLI. The agent's conversation
    // history is unaffected; only the rendered scrollback resets.
    if (key.ctrl && input === 'l') {
      setScrollback((rows) => rows.filter((r) => r.kind === 'raw'));
      if (process.stdout.isTTY) {
        // \x1b[2J clears visible screen; \x1b[3J clears scrollback;
        // \x1b[H homes the cursor. Same sequence renderWithResizeClear
        // emits on resize.
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      }
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
    // @-mention navigation — takes precedence over slash palette since
    // they're mutually exclusive (slash starts the buffer; @ trails it).
    if (atMatches.length > 0) {
      if (key.upArrow) {
        setAtCursor((c) => (c - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (key.downArrow) {
        setAtCursor((c) => (c + 1) % atMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        const picked = atMatches[atCursor] ?? atMatches[0];
        setComposerProgrammatic(applyAtCompletion(composerValue, picked));
        setAtCursor(0);
        return;
      }
      if (key.escape) {
        setAtDismissed(true);
        return;
      }
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
        // (with a trailing space so the user can keep typing args). Uses the
        // programmatic setter so the cursor lands at the END (INPUT-ERGO).
        const picked = paletteMatches[paletteCursor] ?? paletteMatches[0];
        setComposerProgrammatic(picked.cmd + ' ');
        setPaletteCursor(0);
        return;
      }
    }
    // INPUT-ERGO — flag-suggestion palette (args mode, trailing `-token`).
    // ↑/↓ navigate, Tab completes the highlighted flag.
    if (flagMatches.length > 0) {
      if (key.upArrow) {
        setFlagCursor((c) => (c - 1 + flagMatches.length) % flagMatches.length);
        return;
      }
      if (key.downArrow) {
        setFlagCursor((c) => (c + 1) % flagMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        const picked = flagMatches[flagCursor] ?? flagMatches[0];
        setComposerProgrammatic(applyFlagCompletion(composerValue, picked.flag));
        setFlagCursor(0);
        return;
      }
    }
    // INPUT-ERGO — shell-style history recall. Only when NO palette owns the
    // arrow keys (slash / @ / flag all closed). ↑ older, ↓ newer; falling off
    // the new end restores the draft the user was typing.
    if (slashQuery === null && atMatches.length === 0 && flagMatches.length === 0) {
      if (key.upArrow) {
        if (histIndex === LIVE) setHistDraft(composerValue); // entering browse — stash the live draft
        const move = historyPrev(histEntries, histIndex);
        if (move.value !== null) {
          setHistIndex(move.index);
          setComposerProgrammatic(move.value);
        }
        return;
      }
      if (key.downArrow) {
        const move = historyNext(histEntries, histIndex, histDraft);
        if (move.value !== null || move.index === LIVE) {
          setHistIndex(move.index);
          if (move.value !== null) setComposerProgrammatic(move.value);
        }
        return;
      }
    }
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
            ) : activeRoute === 'workflow' ? (
              <Box flexDirection="column" padding={1}>
                <Text color="cyan" bold>WORKFLOWS & DURABLE TASKS</Text>
                <Box flexDirection="column" marginTop={1} gap={1}>
                  {bgTasks.length === 0 ? (
                    <Text color="gray" italic>No active workflows running in the background.</Text>
                  ) : (
                    bgTasks.map((task) => (
                      <Box key={task.id} flexDirection="column" borderStyle="single" borderColor="cyan" borderDimColor padding={1}>
                        <Text bold color="cyan">{`⚡ ${task.kind}: ${task.id.substring(0, 8)}`}</Text>
                        <Box marginTop={1}>
                          <Text color="white">{task.label}</Text>
                        </Box>
                      </Box>
                    ))
                  )}
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column" padding={1}>
                <Text color="cyan" bold>MCP TOOLS & CONSOLE</Text>
                <Box flexDirection="column" marginTop={1} gap={1}>
                  <Text color="white">Connected Servers:</Text>
                  <Text color="gray">  · filesystem (local)</Text>
                  <Text color="gray">  · brainrouter-mcp (memory)</Text>
                  <Box marginTop={1}>
                    <Text color="gray">Run <Text color="cyan" bold>/tools</Text> or <Text color="cyan" bold>/mcp</Text> to configure servers and view available API actions.</Text>
                  </Box>
                </Box>
              </Box>
            )}
          </GridWorkspace>

          {/* Active turn spinner */}
          {phase === 'turn-running' && !liveAssistant && !liveReasoning ? (
            <Box marginTop={1} flexShrink={0}>
              <Text color={turnElapsedMs >= 10_000 ? 'yellow' : 'green'}>
                {React.createElement(Spinner as any, { type: 'dots' })}
              </Text>
              <Text color="gray" wrap="truncate">  {spinnerLabel}</Text>
            {turnElapsedMs >= 1000 ? (
              <Text color={turnElapsedMs >= 10_000 ? 'yellow' : 'gray'} dimColor>{`  · ${Math.floor(turnElapsedMs / 1000)}s`}</Text>
            ) : null}
            </Box>
          ) : null}

          {/* Global Composer (TextInput) and dividers */}
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            <Text color={accentColor} dimColor>{'─'.repeat(Math.max(10, cols - 2))}</Text>
            {histSearch !== null ? (() => {
              const m = searchHistory(histEntries, histSearch.query, histSearch.skip);
              return (
                <Box>
                  <Text color="cyan" bold>{` (reverse-i-search) `}</Text>
                  <Text color="yellow">{`'${histSearch.query}'`}</Text>
                  <Text color="gray">{': '}</Text>
                  <Text wrap="truncate-end">{m ? m.value : histSearch.query ? '(no match)' : 'type to search · Ctrl+R next · Enter accept · Esc cancel'}</Text>
                </Box>
              );
            })() : null}
            <Box>
              <Text color={scrollMode ? 'cyan' : accentColor} bold={scrollMode}>{scrollMode ? ' ⊟ ' : ' ❯ '}</Text>
              <TextInput
                key={composerKey}
                value={composerValue}
                onChange={onComposerChange}
                onSubmit={onComposerSubmit}
                focus={!scrollMode && histSearch === null}
                placeholder={scrollMode ? 'SCROLL — w/s · j/k · ↑/↓ scroll · g/G top·bottom · Esc or i to type' : (phase === 'turn-running' ? '' : 'type a prompt or / for commands')}
              />
            </Box>
            <Text color={accentColor} dimColor>{'─'.repeat(Math.max(10, cols - 2))}</Text>
          </Box>

          {/* Slash palette panel */}
          {slashQuery !== null ? (
            <Box flexShrink={0}>
              <SlashPalettePanel
                matches={paletteMatches}
                cursor={paletteCursor}
                accentColor={accentColor}
                cols={cols}
              />
            </Box>
          ) : null}

          {/* Flag suggestions */}
          {flagMatches.length > 0 ? (
            <Box flexDirection="column" marginTop={0} flexShrink={0}>
              <Text color="gray" dimColor>  flags (Tab to complete, ↑/↓ to navigate)</Text>
              {flagMatches.map((m, i) => (
                <Box key={m.flag}>
                  <Text color={i === flagCursor ? accentColor : 'gray'}>
                    {i === flagCursor ? '  › ' : '    '}{m.flag}
                  </Text>
                  {cols >= 50 ? <Text color="gray" dimColor>{`  ${m.desc}`}</Text> : null}
                </Box>
              ))}
            </Box>
          ) : null}

          {/* @-mentions */}
          {atMatches.length > 0 ? (
            <Box flexDirection="column" marginTop={0} flexShrink={0}>
              <Text color="gray" dimColor>  @ files (Tab to accept, ↑/↓ to navigate, Esc to dismiss)</Text>
              {atMatches.map((m, i) => (
                <Text key={m} color={i === atCursor ? accentColor : 'gray'}>
                  {i === atCursor ? '  › ' : '    '}{m}
                </Text>
              ))}
            </Box>
          ) : null}

          {/* Global TUI Footer */}
          <Box flexShrink={0}>
            <FooterStatus
              promptLabel={promptLabel}
              phase={phase}
              accentColor={accentColor}
              accessMode={accessMode}
              footer={footer}
              cols={cols}
            />
          </Box>
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

// --- Sub-components ---------------------------------------------------

/**
 * Per-entry renderer — every scrollback kind has its own
 * layout. Glyph conventions:
 *
 *   ⏺  assistant turn (first line) — green dot
 *   ❯  user prompt (left margin)   — accent (orange)
 *   ⏺  tool call header            — green dot when ok, red when failed
 *   ⎿  tool result connector       — first line of preview
 *   ✓ / ✗  status mark             — final status line of tool block
 *   ↳  plan / memory dim-italic explanation
 */
// React.memo: scrollback entries are immutable once pushed (their `id`
// is stable, their `entry` object is never mutated in place — push
// always allocates a fresh object), so we can short-circuit re-renders
// when the parent re-renders for unrelated reasons (live streaming
// state, spinner tick, composer keystroke). Without this memo, every
// 80ms streaming tick re-walks the entire scrollback (potentially 1000+
// entries) and Ink re-diffs each row — that's the dominant cause of
// the visible flicker / flashing during streaming.
// --- Helpers ----------------------------------------------------------

function seedScrollback(workspaceRoot: string | undefined, offline: string | undefined, hint: string): ScrollbackEntry[] {
  let id = 0;
  const next = (): number => ++id;
  const theme = resolveTheme(workspaceRoot);
  const welcomeText = theme.primary(`🧠 Welcome to BrainRouter CLI v${VERSION}\n\n`);
  const out: ScrollbackEntry[] = [{ id: next(), kind: 'raw', text: welcomeText, noWrap: true, timestamp: new Date() }];
  if (offline) out.push({ id: next(), kind: 'raw', text: offline, noWrap: true, timestamp: new Date() });
  out.push({ id: next(), kind: 'raw', text: hint, noWrap: true, timestamp: new Date() });
  return out;
}

export function estimateTextHeight(text: string, cols: number): number {
  if (!text) return 0;
  const lines = text.split('\n');
  let count = 0;
  for (const line of lines) {
    count += Math.max(1, Math.ceil(line.length / Math.max(1, cols)));
  }
  return count;
}

// Rows the chrome (header + composer + footer + spinner + scroll hint) reserves
// outside the scrollback area. The budget undershooting this is what let the
// scrollback overflow onto the composer/footer rows.
const CHROME_RESERVED_ROWS = 10;

// Markdown height is measured by ACTUALLY rendering (mirrors ScrollbackRow) —
// the old raw-`\n` estimate ignored marked's list spacing / wrapping and
// undershot badly, which overflowed the frame. Cached + bounded (FIFO) so the
// per-render cost stays flat even while streaming re-runs the memo.
const _mdRenderCache = new Map<string, string>();
function renderMarkdownCached(text: string, width: number): string {
  const key = width + ' ' + text;
  let rendered = _mdRenderCache.get(key);
  if (rendered === undefined) {
    rendered = renderMarkdown(text, { width }).trimEnd();
    if (_mdRenderCache.size >= 256) _mdRenderCache.delete(_mdRenderCache.keys().next().value as string);
    _mdRenderCache.set(key, rendered);
  }
  return rendered;
}

export function estimateEntryHeight(entry: ScrollbackEntry, cols: number, verbose = false): number {
  switch (entry.kind) {
    case 'raw':
    case 'user':
    case 'notice':
      return estimateTextHeight(entry.text ?? '', cols) + (entry.kind === 'user' ? 1 : 0);
    case 'assistant': {
      const text = entry.text ?? '';
      // Mirror the renderer: markdown rendered at width `cols-2`, then displayed
      // in a flexGrow column to the right of "⏺ " (+ optional timestamp). Re-wrap
      // at that narrower width so we OVER- rather than under-estimate.
      const rendered = entry.raw ? text : renderMarkdownCached(text, Math.max(1, cols - 2));
      const bodyWidth = Math.max(1, cols - (entry.timestamp ? 13 : 2));
      return 1 /* marginTop */ + estimateTextHeight(rendered, bodyWidth) + (entry.durationMs !== undefined ? 1 : 0);
    }
    case 'tool': {
      let h = 1;
      if (entry.preview) {
        const lines = entry.preview.split('\n').length;
        h += verbose ? lines : Math.min(8, lines);
        if (!verbose && lines > 8) h += 1;
      }
      return h + 1;
    }
    case 'memory':
      return 1;
    case 'plan':
      return 1 + (entry.explanation ? 1 : 0) + entry.items.length + 1;
    case 'agent-result': {
      // Body wraps (wrap="wrap") inside a paddingLeft={4} column.
      return 1 + estimateTextHeight(entry.body ?? '', Math.max(1, cols - 4));
    }
    case 'reasoning': {
      const rawLines = entry.text ? entry.text.split('\n') : [];
      const shown = rawLines.slice(0, verbose ? rawLines.length : 10).join('\n');
      const visible = estimateTextHeight(shown, Math.max(1, cols - 3)); // wraps inside a bordered column
      const hiddenExtra = rawLines.length > 10 ? 1 : 0;
      return 1 + visible + hiddenExtra + 1;
    }
    case 'child-fleet':
      return 1;
    case 'compaction': {
      // Renderer shows up to 8 summary lines, each wrapping inside a paddingLeft={3} column.
      const shown = entry.summary ? entry.summary.split('\n').slice(0, 8).join('\n') : '';
      return 1 + estimateTextHeight(shown, Math.max(1, cols - 3)) + 1;
    }
    default:
      return 1;
  }
}


export interface VisibleSlice<T> {
  entry: T;
  /** Estimated full height of the entry in terminal rows (≥1). */
  height: number;
  /** Rows clipped off the TOP of the entry (scrolled past the window top). */
  clipTop: number;
  /** Rows clipped off the BOTTOM (scrolled below the window bottom). */
  clipBottom: number;
}

/**
 * CC-P1.1 — LINE-level scrollback window. The window position (`lineOffset`)
 * counts VISUAL LINES from the bottom of history, so scrolling moves one line
 * at a time instead of jumping whole entries. Boundary entries are returned
 * with `clipTop`/`clipBottom` so the renderer can show just their visible rows
 * (fixed-height overflow:hidden wrappers). The packed window NEVER exceeds
 * `budget` rows, so it cannot spill onto the composer/footer chrome.
 * `lineOffset` is clamped internally; `totalLines` lets callers clamp keys.
 * Pure → tested.
 */
export function packVisibleLines<T>(
  entries: T[],
  opts: { budget: number; lineOffset: number; estimateHeight: (entry: T) => number },
): { slices: Array<VisibleSlice<T>>; hiddenLinesAbove: number; hiddenLinesBelow: number; totalLines: number } {
  const budget = Math.max(1, opts.budget);
  const heights = entries.map((e) => Math.max(1, opts.estimateHeight(e)));
  const totalLines = heights.reduce((n, h) => n + h, 0);
  const maxOffset = Math.max(0, totalLines - budget);
  const offset = Math.min(Math.max(0, opts.lineOffset), maxOffset);

  const slices: Array<VisibleSlice<T>> = [];
  let toSkip = offset; // lines below the window (scrolled past)
  let remaining = Math.min(budget, totalLines - offset);
  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const h = heights[i];
    if (toSkip >= h) { toSkip -= h; continue; } // entirely below the window
    const clipBottom = toSkip;
    toSkip = 0;
    const availableOfEntry = h - clipBottom;
    const used = Math.min(availableOfEntry, remaining);
    const clipTop = availableOfEntry - used;
    slices.unshift({ entry: entries[i], height: h, clipTop, clipBottom });
    remaining -= used;
  }
  const visible = Math.min(budget, totalLines - offset);
  return {
    slices,
    hiddenLinesAbove: Math.max(0, totalLines - offset - visible),
    hiddenLinesBelow: offset,
    totalLines,
  };
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
