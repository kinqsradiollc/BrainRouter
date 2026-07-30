import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeServerThreads,
  serverMessageToStored,
  toServerMessages,
  type ChatThreadMessage,
  type ChatThreadSummary,
} from "./chatThreads";
import type { StoredChatScope, StoredChatSession } from "../app/chat/chatSessions";

const scope: StoredChatScope = { orgId: "org-1", projectId: "", workspaceTag: "" };

function localSession(
  id: string,
  updatedAt: string,
  overrides: Partial<StoredChatSession> = {},
): StoredChatSession {
  return {
    id,
    title: id,
    category: "General",
    scope: { ...scope },
    messages: [{ id: `${id}-m`, role: "user", content: id }],
    updatedAt,
    ...overrides,
  };
}

function summary(id: string, updatedAt: string, over: Partial<ChatThreadSummary> = {}): ChatThreadSummary {
  return { id, title: `srv ${id}`, model: null, createdAt: updatedAt, updatedAt, ...over };
}

test("toServerMessages keeps user/assistant text and drops empty/other roles", () => {
  const out = toServerMessages([
    { id: "1", role: "user", content: "hi" },
    { id: "2", role: "assistant", content: "  " },
    { id: "3", role: "assistant", content: "there" },
    { id: "4", role: "system" as never, content: "ignored" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "there" },
  ]);
});

test("serverMessageToStored maps renderable turns and rejects the rest", () => {
  const base: ChatThreadMessage = { id: "cm_1", ordinal: 0, role: "user", content: "hello", createdAt: "" };
  assert.deepEqual(serverMessageToStored(base), { id: "cm_1", role: "user", content: "hello" });
  assert.equal(serverMessageToStored({ ...base, role: "tool" }), null);
  assert.equal(serverMessageToStored({ ...base, content: "   " }), null);
  // A missing id falls back to an ordinal-derived stable id.
  assert.equal(serverMessageToStored({ ...base, id: "", ordinal: 4 })?.id, "srv_4");
});

test("mergeServerThreads keeps cached bodies, skeletons remote-only threads, and reports local-only for migration", () => {
  const local = [
    localSession("cached", "2026-07-14T00:00:00.000Z", { messages: [{ id: "c", role: "user", content: "keep me" }] }),
    localSession("local-only", "2026-07-14T05:00:00.000Z"),
    localSession("other-org", "2026-07-14T06:00:00.000Z", { scope: { orgId: "org-2", projectId: "", workspaceTag: "" } }),
  ];
  const remote = [
    summary("cached", "2026-07-14T02:00:00.000Z", { title: "renamed on server", model: "gpt-x" }),
    summary("remote-only", "2026-07-14T03:00:00.000Z"),
  ];

  const { sessions, unsynced } = mergeServerThreads(local, remote, scope);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Cached thread keeps its local messages but adopts the server title/model + newer time.
  assert.equal(byId.get("cached")?.messages[0]?.content, "keep me");
  assert.equal(byId.get("cached")?.title, "renamed on server");
  assert.equal(byId.get("cached")?.model, "gpt-x");
  assert.equal(byId.get("cached")?.updatedAt, "2026-07-14T02:00:00.000Z");

  // Remote-only thread becomes an empty skeleton scoped to the current org.
  assert.equal(byId.get("remote-only")?.messages.length, 0);
  assert.deepEqual(byId.get("remote-only")?.scope, scope);

  // Local-only threads stay visible; only the current-org one is queued to migrate.
  assert.ok(byId.has("local-only"));
  assert.ok(byId.has("other-org"));
  assert.deepEqual(unsynced.map((s) => s.id), ["local-only"]);

  // Newest-first ordering across the merged set.
  assert.deepEqual(sessions.map((s) => s.id), ["other-org", "local-only", "remote-only", "cached"]);
});
