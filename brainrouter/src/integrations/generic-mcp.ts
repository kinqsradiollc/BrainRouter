import { randomUUID } from "node:crypto";

import { redactSensitiveMemoryText } from "../memory/redaction.js";
import { resetWorkingMemory } from "../memory/working/offload.js";
import type { MemoryEngine } from "../memory/engine.js";

export type HostHookSource = "claude-code" | "codex" | "generic-mcp" | string;

export interface HostHookEvent {
  source: HostHookSource;
  event: string;
  userId: string;
  sessionKey: string;
  sessionId?: string;
  workspacePath?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  prompt?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface RegisteredHook {
  id: string;
  userId: string;
  source: HostHookSource;
  events: string[];
  sessionKey?: string;
  workspacePath?: string;
  registeredAt: string;
  lastSeenAt: string | null;
  lastEvent: string | null;
  metadata: Record<string, unknown>;
}

const registeredHooks = new Map<string, RegisteredHook>();
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|password|secret|token)/i;
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 50;
const SESSION_END_EVENTS = new Set(["Stop", "SubagentStop", "session_end"]);

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : value;
}

export function sanitizeHookPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED_DEPTH]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSensitiveMemoryText(truncate(value));
  if (typeof value === "undefined") return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeHookPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeHookPayload(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function registerHostHook(params: {
  userId: string;
  source: HostHookSource;
  events?: string[];
  sessionKey?: string;
  workspacePath?: string;
  metadata?: Record<string, unknown>;
}): RegisteredHook {
  const now = new Date().toISOString();
  const id = `${params.userId}:${params.source}:${params.sessionKey ?? "global"}`;
  const existing = registeredHooks.get(id);
  const hook: RegisteredHook = {
    id,
    userId: params.userId,
    source: params.source,
    events: params.events ?? existing?.events ?? [],
    sessionKey: params.sessionKey ?? existing?.sessionKey,
    workspacePath: params.workspacePath ?? existing?.workspacePath,
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: existing?.lastSeenAt ?? null,
    lastEvent: existing?.lastEvent ?? null,
    metadata: params.metadata ?? existing?.metadata ?? {},
  };
  registeredHooks.set(id, hook);
  return hook;
}

export function listHostHooks(userId: string): RegisteredHook[] {
  return [...registeredHooks.values()]
    .filter((hook) => hook.userId === userId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function touchHook(event: HostHookEvent): RegisteredHook {
  const hook = registerHostHook({
    userId: event.userId,
    source: event.source,
    events: [event.event],
    sessionKey: event.sessionKey,
    workspacePath: event.workspacePath,
  });
  hook.lastSeenAt = new Date().toISOString();
  hook.lastEvent = event.event;
  if (!hook.events.includes(event.event)) {
    hook.events = [...hook.events, event.event];
  }
  registeredHooks.set(hook.id, hook);
  return hook;
}

function buildCaptureContent(event: HostHookEvent): string {
  return JSON.stringify({
    source: event.source,
    event: event.event,
    toolName: event.toolName,
    args: sanitizeHookPayload(event.args),
    result: sanitizeHookPayload(event.result),
    prompt: sanitizeHookPayload(event.prompt),
    content: sanitizeHookPayload(event.content),
    metadata: sanitizeHookPayload(event.metadata ?? {}),
  });
}

export async function processGenericMcpHook(
  engine: Pick<MemoryEngine, "capturePassiveL0">,
  event: HostHookEvent,
) {
  const hook = touchHook(event);

  const capture = engine.capturePassiveL0({
    userId: event.userId,
    sessionKey: event.sessionKey,
    sessionId: event.sessionId,
    role: "tool",
    content: buildCaptureContent(event),
    timestamp: event.timestamp ?? Date.now(),
    skillTag: `host:${event.source}`,
  });

  const workspacePath = event.workspacePath ?? hook.workspacePath;
  const flushedWorkingMemory = SESSION_END_EVENTS.has(event.event) && Boolean(workspacePath);
  if (flushedWorkingMemory && workspacePath) {
    resetWorkingMemory(workspacePath, event.userId, event.sessionKey);
  }

  return {
    hookId: hook.id,
    l0RecordedCount: 1,
    l0RecordId: capture.id,
    flushedWorkingMemory,
  };
}

export function buildHookResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function fallbackSessionKey(source: HostHookSource): string {
  return `${source}-${randomUUID()}`;
}
