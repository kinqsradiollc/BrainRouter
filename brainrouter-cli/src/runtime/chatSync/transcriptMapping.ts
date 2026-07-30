/**
 * K-CLI — pure mapping from a local CLI transcript to the shared chat-threads
 * server shape (`/api/chat/threads`). The server persists a thread as an ordered
 * list of `{ role, content }` messages, so a push flattens the workspace
 * transcript down to just the user + assistant TEXT turns.
 *
 * Deliberately skipped so a CLI conversation reads the same cross-surface as a
 * dashboard/desktop one, without leaking terminal-only noise:
 *   - tool results and tool-call-only turns (role `tool`, or an assistant turn
 *     whose only payload is `tool_calls` with no prose),
 *   - injected system / guard messages (a `user` entry carrying a `name`, the
 *     same signal the session picker uses to find the real first prompt),
 *   - any entry whose content isn't a plain string (multimodal / structured).
 *
 * Pure + fs-free so it is unit-tested without touching disk or the network.
 */
import type { TranscriptEntry } from '@kinqs/brainrouter-core/session';

/** Roles the server accepts; the CLI only ever pushes these two. */
export type ServerChatRole = 'user' | 'assistant';

/** The minimal message shape the server's replace/create endpoints consume. */
export interface ServerChatMessageInput {
  role: ServerChatRole;
  content: string;
}

const MAX_TITLE_CHARS = 120;

function isConversationalRole(role: string): role is ServerChatRole {
  return role === 'user' || role === 'assistant';
}

/**
 * A single transcript entry qualifies as a pushable message when it is a
 * user/assistant turn, carries no `name` (which marks tool/guard entries), and
 * its content is a non-empty string.
 */
function toServerMessage(entry: TranscriptEntry): ServerChatMessageInput | null {
  if (!isConversationalRole(entry.role)) return null;
  if (entry.name) return null; // injected guard/system or a named tool entry
  if (typeof entry.content !== 'string') return null;
  const content = entry.content.trim();
  if (!content) return null;
  return { role: entry.role, content };
}

/**
 * Flatten transcript entries (in order) to the server's user/assistant text
 * messages. Non-conversational entries are dropped, never reordered.
 */
export function transcriptEntriesToServerMessages(entries: TranscriptEntry[]): ServerChatMessageInput[] {
  const messages: ServerChatMessageInput[] = [];
  for (const entry of entries) {
    const message = toServerMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}

/**
 * Derive a human-readable thread title from the conversation's first real user
 * prompt (whitespace-collapsed, capped), falling back to a stable default. The
 * server re-normalizes + caps the title, so this only needs to be reasonable.
 */
export function deriveThreadTitle(entries: TranscriptEntry[], fallback = 'CLI session'): string {
  for (const entry of entries) {
    if (entry.role !== 'user' || entry.name) continue;
    if (typeof entry.content !== 'string') continue;
    const text = entry.content.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, MAX_TITLE_CHARS);
  }
  return fallback;
}
