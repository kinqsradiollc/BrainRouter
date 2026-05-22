import {
  fallbackSessionKey,
  processGenericMcpHook,
  type HostHookEvent,
} from "./generic-mcp.js";
import type { MemoryEngine } from "../memory/engine.js";

const CODEX_EVENTS = ["session_start", "session_end", "prompt_submit", "compact"] as const;
export type CodexHookEventName = typeof CODEX_EVENTS[number];

function parseEventName(value: unknown): CodexHookEventName {
  const eventName = String(value || "");
  return CODEX_EVENTS.includes(eventName as CodexHookEventName)
    ? eventName as CodexHookEventName
    : "prompt_submit";
}

export function normalizeCodexHook(raw: Record<string, unknown>, defaultUserId: string): HostHookEvent {
  const event = parseEventName(raw.event ?? raw.hookEventName ?? raw.hook_event_name);
  const sessionKey = String(
    raw.sessionKey
      ?? raw.session_key
      ?? raw.conversationId
      ?? raw.conversation_id
      ?? fallbackSessionKey("codex"),
  );

  return {
    source: "codex",
    event,
    userId: String(raw.userId ?? raw.user_id ?? defaultUserId),
    sessionKey,
    sessionId: raw.sessionId || raw.session_id ? String(raw.sessionId ?? raw.session_id) : undefined,
    workspacePath: raw.workspacePath || raw.cwd ? String(raw.workspacePath ?? raw.cwd) : undefined,
    prompt: raw.prompt ? String(raw.prompt) : undefined,
    content: raw.content ? String(raw.content) : undefined,
    metadata: {
      compactReason: raw.compactReason ?? raw.compact_reason,
      rawEvent: event,
    },
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
  };
}

export async function processCodexHook(
  engine: Pick<MemoryEngine, "capturePassiveL0">,
  raw: Record<string, unknown>,
  defaultUserId: string,
) {
  return processGenericMcpHook(engine, normalizeCodexHook(raw, defaultUserId));
}
