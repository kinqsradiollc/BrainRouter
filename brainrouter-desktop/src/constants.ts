/**
 * Renderer-wide constants extracted from App.tsx: the reasoning-effort levels,
 * the non-chat model filter, the side-panel view catalog, the valid panel-id
 * set, and the foreground-only event-kind set.
 */
import { PANEL_DEFS, type PanelId } from './panels/index.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/**
 * DESK-5l — endpoints (LM Studio/Ollama/OpenAI) list EVERY model they serve,
 * including embedding/audio/rerank models that cannot hold a chat. Picking
 * one breaks the session ("model returned an empty response"), so the chat
 * picker hides them; Settings → Custom model… remains the escape hatch.
 */
export const NON_CHAT_MODEL = /embed|whisper|tts|rerank|moderation|audio|clip/i;

/**
 * DESK-5f — view catalog for the tabbed side panel + bottom dock "+" menus.
 * One view = one tab; both surfaces switch tabs instead of opening windows.
 */
export const VIEW_MENU: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'plan', title: 'Plan', icon: 'review' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'diff', title: 'Changes', icon: 'diff' },
  { id: 'tasks', title: 'Background tasks', icon: 'tasks' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt' },
  { id: 'search', title: 'Search session', icon: 'search' },
  { id: 'schedule', title: 'Schedules', icon: 'clock' },
  { id: 'requirements', title: 'Requirements', icon: 'tasks' },
  { id: 'context', title: 'Context', icon: 'layout-right' },
];

export const VALID_PANEL_IDS = new Set<PanelId>(PANEL_DEFS.map((p) => p.id));

// DESK-5v — CONCURRENT SESSIONS: events that only make sense for the chat ON
// SCREEN. When one arrives tagged with a BACKGROUND session (a turn still
// running in a chat you switched away from), it's dropped so it can't pollute
// the viewed chat. The turn lifecycle + session-changed + query-result +
// approval events are NOT in here — they're handled session-aware so a
// background turn still updates its spinner and lands its result/error.
export const FOREGROUND_ONLY_KINDS = new Set<string>([
  'status', 'reasoning-delta', 'assistant-turn-start', 'assistant-delta',
  'assistant-turn-end', 'tool-end', 'child-tool-start', 'child-tool-end',
  'child-complete', 'plan-update', 'compaction', 'memory', 'tokens-updated',
]);
