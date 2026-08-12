/**
 * Dashboard chat-session persistence and title-policy regressions. Exact keys
 * remain stable across labels, malformed storage fails safely, and shared title
 * precedence cannot silently reopen or reroute a conversation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_SESSIONS_STORAGE_KEY,
  loadChatSessions,
  sameChatScope,
  saveChatSessions,
  sessionTitle,
  upsertChatSession,
  type ChatSessionStorage,
  type StoredChatSession,
} from "./chatSessions";

function memoryStorage(initial = ""): ChatSessionStorage & { value: string } {
  return {
    value: initial,
    getItem(key) { return key === CHAT_SESSIONS_STORAGE_KEY ? this.value || null : null; },
    setItem(key, value) { if (key === CHAT_SESSIONS_STORAGE_KEY) this.value = value; },
  };
}

function session(id: string, updatedAt: string, content = id): StoredChatSession {
  return {
    id,
    title: content,
    category: "General",
    scope: { orgId: "org-1", projectId: "", workspaceTag: "" },
    messages: [{ id: `${id}-message`, role: "user", content }],
    updatedAt,
  };
}

test("chat sessions survive reload in newest-first order", () => {
  const storage = memoryStorage();
  saveChatSessions(storage, [
    session("older", "2026-07-14T00:00:00.000Z"),
    session("newer", "2026-07-14T01:00:00.000Z"),
  ]);
  assert.deepEqual(loadChatSessions(storage).map(({ id }) => id), ["newer", "older"]);
});

test("chat sessions preserve their public model and exact effort selection", () => {
  const storage = memoryStorage();
  saveChatSessions(storage, [{
    ...session("managed", "2026-07-14T01:00:00.000Z"),
    model: "gpt-5.6",
    reasoningEffort: "xhigh",
  }]);
  const [loaded] = loadChatSessions(storage);
  assert.equal(loaded?.model, "gpt-5.6");
  assert.equal(loaded?.reasoningEffort, "xhigh");
});

test("invalid persisted data fails closed and overlong content is bounded", () => {
  assert.deepEqual(loadChatSessions(memoryStorage("not-json")), []);
  const storage = memoryStorage(JSON.stringify([
    session("bounded", "2026-07-14T00:00:00.000Z", "x".repeat(20_000)),
    { unsafe: true },
  ]));
  const loaded = loadChatSessions(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.messages[0]?.content.length, 12_000);
});

test("upsert replaces one session and scope/title helpers stay deterministic", () => {
  const updated = upsertChatSession(
    [session("one", "2026-07-14T00:00:00.000Z")],
    session("one", "2026-07-14T02:00:00.000Z", "Ship the managed model gateway safely"),
  );
  assert.equal(updated.length, 1);
  assert.equal(sessionTitle(updated[0]!.messages), "Ship the managed model gateway safely");
  assert.equal(sameChatScope(updated[0]!.scope, { ...updated[0]!.scope }), true);
  assert.equal(sameChatScope(updated[0]!.scope, { ...updated[0]!.scope, projectId: "project-2" }), false);
});

test("dashboard titles use the shared session fallback and word boundary", () => {
  assert.equal(sessionTitle([]), "Untitled session");
  assert.equal(
    sessionTitle([{ id: "m1", role: "user", content: "Investigate the failing release workflow after the dependency update introduced a regression" }]),
    "Investigate the failing release workflow after the…",
  );
});
