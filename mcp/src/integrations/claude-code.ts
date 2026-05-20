import {
  fallbackSessionKey,
  processGenericMcpHook,
  type HostHookEvent,
} from "./generic-mcp.js";
import type { MemoryEngine } from "../memory/engine.js";

const CLAUDE_CODE_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"] as const;
export type ClaudeCodeHookEventName = typeof CLAUDE_CODE_EVENTS[number];

function parseEventName(value: unknown): ClaudeCodeHookEventName {
  const eventName = String(value || "");
  return CLAUDE_CODE_EVENTS.includes(eventName as ClaudeCodeHookEventName)
    ? eventName as ClaudeCodeHookEventName
    : "PostToolUse";
}

export function normalizeClaudeCodeHook(raw: Record<string, unknown>, defaultUserId: string): HostHookEvent {
  const event = parseEventName(raw.event ?? raw.hook_event_name ?? raw.hookEventName);
  const sessionKey = String(
    raw.sessionKey
      ?? raw.session_key
      ?? raw.session_id
      ?? raw.transcript_path
      ?? fallbackSessionKey("claude-code"),
  );

  return {
    source: "claude-code",
    event,
    userId: String(raw.userId ?? raw.user_id ?? defaultUserId),
    sessionKey,
    sessionId: raw.sessionId || raw.session_id ? String(raw.sessionId ?? raw.session_id) : undefined,
    workspacePath: raw.workspacePath || raw.cwd ? String(raw.workspacePath ?? raw.cwd) : undefined,
    toolName: raw.toolName || raw.tool_name ? String(raw.toolName ?? raw.tool_name) : undefined,
    args: raw.args ?? raw.tool_input ?? raw.input,
    result: raw.result ?? raw.tool_response ?? raw.output,
    metadata: {
      transcriptPath: raw.transcript_path,
      rawEvent: event,
    },
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
  };
}

export async function processClaudeCodeHook(
  engine: Pick<MemoryEngine, "capturePassiveL0">,
  raw: Record<string, unknown>,
  defaultUserId: string,
) {
  return processGenericMcpHook(engine, normalizeClaudeCodeHook(raw, defaultUserId));
}
