// REFAC-CHATAPP-SPLIT (0.4.17) — the public ChatApp type surface, extracted
// verbatim from ChatApp.tsx. Type-only (no runtime, no React deps) so it can be
// imported by hooks/sub-components/tests without any cycle. Re-exported from
// ChatApp.tsx for back-compat with existing importers.
import type React from 'react';
import type { SlashCommandDef } from '../prompt/SlashPalette.js';
import type { BannerInputs } from '../../view/banner.js';

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
  setBackgroundTasks: (tasks: import('@kinqs/brainrouter-core/background').BackgroundTask[]) => void;
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

export interface VisibleSlice<T> {
  entry: T;
  /** Estimated full height of the entry in terminal rows (≥1). */
  height: number;
  /** Rows clipped off the TOP of the entry (scrolled past the window top). */
  clipTop: number;
  /** Rows clipped off the BOTTOM (scrolled below the window bottom). */
  clipBottom: number;
}
