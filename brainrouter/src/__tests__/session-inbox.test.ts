import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      sendSessionMessage: vi.fn(),
      readSessionInbox: vi.fn(),
      ackSessionInbox: vi.fn(),
    },
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleSessionSend,
  handleSessionInboxRead,
  handleSessionInboxAck,
} from "../tools/session_inbox.js";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe("session_send tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.sendSessionMessage).mockReset();
  });

  it("returns delivered count + ids on successful send", async () => {
    vi.mocked(memoryEngine.store.sendSessionMessage).mockReturnValue([
      {
        id: "msg-1",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text",
        payload: { text: "hi" },
        createdAt: "2026-05-28T10:00:00Z",
        deliveredAt: null,
      },
    ]);
    const res = parseToolText<{ delivered: number; ids: string[] }>(
      await handleSessionSend(
        { from: "from", to: "to", kind: "text", payload: { text: "hi" } },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.delivered).toBe(1);
    expect(res.ids).toEqual(["msg-1"]);
  });

  it("rejects when kind is outside the enum", async () => {
    const result: any = await handleSessionSend(
      { from: "from", to: "to", kind: "garbage", payload: {} },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_send failed/);
  });

  it("rejects when `to` or `from` is missing", async () => {
    const r1: any = await handleSessionSend({ kind: "text" }, { defaultUserId: "u1" });
    expect(r1.isError).toBe(true);
  });

  it("returns delivered:0 when broadcast resolves to zero peers", async () => {
    vi.mocked(memoryEngine.store.sendSessionMessage).mockReturnValue([]);
    const res = parseToolText<{ delivered: number; ids: string[] }>(
      await handleSessionSend(
        { from: "from", to: "*", kind: "text", payload: { text: "hi" } },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.delivered).toBe(0);
    expect(res.ids).toEqual([]);
  });

  it("returns isError envelope when the store throws", async () => {
    vi.mocked(memoryEngine.store.sendSessionMessage).mockImplementation(() => {
      throw new Error("disk full");
    });
    const result: any = await handleSessionSend(
      { from: "from", to: "to", kind: "text", payload: { text: "hi" } },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_send failed: disk full/);
  });
});

describe("session_inbox_read tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockReset();
    vi.mocked(memoryEngine.store.ackSessionInbox).mockReset();
  });

  it("auto-acks undelivered messages on non-peek read", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockReturnValue([
      {
        id: "m1",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text",
        payload: { text: "hi" },
        createdAt: "2026-05-28T10:00:00Z",
        deliveredAt: null,
      },
      {
        id: "m2",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text",
        payload: { text: "yo" },
        createdAt: "2026-05-28T10:00:01Z",
        deliveredAt: null,
      },
    ]);
    vi.mocked(memoryEngine.store.ackSessionInbox).mockReturnValue(2);

    const res = parseToolText<{ messages: any[] }>(
      await handleSessionInboxRead({ sessionKey: "to" }, { defaultUserId: "u1" }),
    );
    expect(res.messages).toHaveLength(2);
    expect(memoryEngine.store.ackSessionInbox).toHaveBeenCalledWith(
      "u1",
      "to",
      ["m1", "m2"],
      expect.stringMatching(/^\d{4}-/),
    );
  });

  it("does NOT ack when peek:true", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockReturnValue([
      {
        id: "m1",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text",
        payload: {},
        createdAt: "2026-05-28T10:00:00Z",
        deliveredAt: null,
      },
    ]);
    await handleSessionInboxRead({ sessionKey: "to", peek: true }, { defaultUserId: "u1" });
    expect(memoryEngine.store.ackSessionInbox).not.toHaveBeenCalled();
  });

  it("skips ack when the page contained no undelivered messages", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockReturnValue([
      {
        id: "m1",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text",
        payload: {},
        createdAt: "2026-05-28T10:00:00Z",
        deliveredAt: "2026-05-28T10:00:05Z",
      },
    ]);
    await handleSessionInboxRead(
      { sessionKey: "to", includeDelivered: true },
      { defaultUserId: "u1" },
    );
    expect(memoryEngine.store.ackSessionInbox).not.toHaveBeenCalled();
  });

  it("rejects limit > 200", async () => {
    const result: any = await handleSessionInboxRead(
      { sessionKey: "to", limit: 1000 },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
  });
});

describe("session_inbox_ack tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.ackSessionInbox).mockReset();
  });

  it("returns the count acked", async () => {
    vi.mocked(memoryEngine.store.ackSessionInbox).mockReturnValue(2);
    const res = parseToolText<{ acked: number }>(
      await handleSessionInboxAck(
        { sessionKey: "to", ids: ["m1", "m2"] },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.acked).toBe(2);
  });

  it("accepts an empty ids array and returns acked:0", async () => {
    vi.mocked(memoryEngine.store.ackSessionInbox).mockReturnValue(0);
    const res = parseToolText<{ acked: number }>(
      await handleSessionInboxAck({ sessionKey: "to", ids: [] }, { defaultUserId: "u1" }),
    );
    expect(res.acked).toBe(0);
  });

  it("rejects more than 500 ids in one call", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const result: any = await handleSessionInboxAck(
      { sessionKey: "to", ids },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
  });
});
