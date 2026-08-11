/**
 * Durable session-inbox tool contract regressions.
 *
 * Tests keep exact identity validation, tenant-safe persistence, and truthful
 * lifecycle transitions aligned before any invalid request can reach storage.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      routeSessionMessage: vi.fn(),
      readSessionInbox: vi.fn(),
      ackSessionInbox: vi.fn(),
      transitionSessionMessages: vi.fn(),
      readSessionMessageReceipts: vi.fn(),
      ackSessionMessageReceipts: vi.fn(),
    },
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleSessionSend,
  handleSessionInboxRead,
  handleSessionInboxAck,
  handleSessionReceipts,
  handleSessionReceiptsAck,
} from "../tools/sessions/session_inbox.js";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

describe("exact session address validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects control, whitespace, and oversized exact keys before storage", async () => {
    const controlKey = "peer\u001b]52;c;clipboard\u0007";
    const results = await Promise.all([
      handleSessionSend(
        { from: "line\nbreak", to: "to", kind: "text", payload: { text: "hi" } },
        { defaultUserId: "u1" },
      ),
      handleSessionSend(
        { from: "from", to: controlKey, kind: "text", payload: { text: "hi" } },
        { defaultUserId: "u1" },
      ),
      handleSessionInboxRead({ sessionKey: " leading" }, { defaultUserId: "u1" }),
      handleSessionInboxAck({ sessionKey: "peer\n", ids: ["m1"] }, { defaultUserId: "u1" }),
      handleSessionReceipts({ sessionKey: controlKey }, { defaultUserId: "u1" }),
      handleSessionReceiptsAck(
        { sessionKey: "x".repeat(513), ids: ["m1"] },
        { defaultUserId: "u1" },
      ),
    ]);

    expect(results.every((result: any) => result.isError === true)).toBe(true);
    expect(memoryEngine.store.routeSessionMessage).not.toHaveBeenCalled();
    expect(memoryEngine.store.readSessionInbox).not.toHaveBeenCalled();
    expect(memoryEngine.store.transitionSessionMessages).not.toHaveBeenCalled();
    expect(memoryEngine.store.readSessionMessageReceipts).not.toHaveBeenCalled();
    expect(memoryEngine.store.ackSessionMessageReceipts).not.toHaveBeenCalled();
  });

  it("preserves the two bounded broadcast address forms", async () => {
    vi.mocked(memoryEngine.store.routeSessionMessage).mockResolvedValue({
      messageId: "broadcast-1",
      state: "not-queued",
      deliveries: [],
      receipts: [],
      accepted: 0,
      rejected: 0,
      idempotentReplay: false,
    });

    await handleSessionSend(
      { messageId: "broadcast-1", from: "from", to: "*", kind: "text", payload: { text: "hi" } },
      { defaultUserId: "u1" },
    );
    await handleSessionSend(
      { messageId: "broadcast-2", from: "from", to: "brainrouter-cli:*", kind: "text", payload: { text: "hi" } },
      { defaultUserId: "u1" },
    );

    expect(memoryEngine.store.routeSessionMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toSessionKey: "*" }),
    );
    expect(memoryEngine.store.routeSessionMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toSessionKey: "brainrouter-cli:*" }),
    );
  });
});

describe("session_send tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.routeSessionMessage).mockReset();
  });

  it("returns the durable pending state and recipient receipt on successful send", async () => {
    const delivery = {
        id: "msg-1",
        messageId: "logical-1",
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "to",
        kind: "text" as const,
        payload: { text: "hi" },
        createdAt: "2026-05-28T10:00:00Z",
        deliveredAt: null,
        status: "pending" as const,
      };
    vi.mocked(memoryEngine.store.routeSessionMessage).mockResolvedValue({
      messageId: "logical-1",
      state: "persisted-unseen",
      deliveries: [delivery],
      receipts: [delivery],
      accepted: 1,
      rejected: 0,
      idempotentReplay: false,
    });
    const res = parseToolText<{
      state: string;
      accepted: number;
      recipients: Array<{ inboxId: string; status: string }>;
    }>(
      await handleSessionSend(
        { messageId: "logical-1", from: "from", to: "to", kind: "text", payload: { text: "hi" } },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.state).toBe("persisted-unseen");
    expect(res.accepted).toBe(1);
    expect(res.recipients).toEqual([{ sessionKey: "to", inboxId: "msg-1", status: "pending", wake: "poll-fallback" }]);
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

  it("returns a structured error when a broadcast resolves to zero peers", async () => {
    const receipt = {
      id: "msg-rejected", messageId: "logical-empty", userId: "u1",
      fromSessionKey: "from", toSessionKey: "*", kind: "text" as const,
      payload: { text: "hi" }, status: "rejected" as const,
      statusReason: "no_active_recipient", createdAt: "2026-05-28T10:00:00Z", deliveredAt: null,
    };
    vi.mocked(memoryEngine.store.routeSessionMessage).mockResolvedValue({
      messageId: "logical-empty", state: "not-queued", deliveries: [], receipts: [receipt],
      accepted: 0, rejected: 1, idempotentReplay: false, rejectionReason: "no_active_recipient",
    });
    const result: any = await handleSessionSend(
      { messageId: "logical-empty", from: "from", to: "*", kind: "text", payload: { text: "hi" } },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
    expect(parseToolText<{ state: string; rejectionReason: string }>(result)).toMatchObject({
      state: "not-queued",
      rejectionReason: "no_active_recipient",
    });
  });

  it("returns isError envelope when the store throws", async () => {
    vi.mocked(memoryEngine.store.routeSessionMessage).mockImplementation(() => {
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

  it("auto-acks undelivered messages only on an explicit non-peek read", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockResolvedValue([
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
    vi.mocked(memoryEngine.store.ackSessionInbox).mockResolvedValue(2);

    const res = parseToolText<{ messages: any[] }>(
      await handleSessionInboxRead({ sessionKey: "to", peek: false }, { defaultUserId: "u1" }),
    );
    expect(res.messages).toHaveLength(2);
    expect(memoryEngine.store.ackSessionInbox).toHaveBeenCalledWith(
      "u1",
      "to",
      ["m1", "m2"],
      expect.stringMatching(/^\d{4}-/),
      null,
    );
  });

  it("does not claim application on a default read", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockResolvedValue([
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
    ]);

    await handleSessionInboxRead({ sessionKey: "to" }, { defaultUserId: "u1" });

    expect(memoryEngine.store.ackSessionInbox).not.toHaveBeenCalled();
  });

  it("does NOT ack when peek:true", async () => {
    vi.mocked(memoryEngine.store.readSessionInbox).mockResolvedValue([
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
    vi.mocked(memoryEngine.store.readSessionInbox).mockResolvedValue([
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
    vi.mocked(memoryEngine.store.transitionSessionMessages).mockReset();
  });

  it("returns the transitioned rows", async () => {
    vi.mocked(memoryEngine.store.transitionSessionMessages).mockResolvedValue([
      { id: "m1" },
      { id: "m2" },
    ] as any);
    const res = parseToolText<{ updated: number; status: string }>(
      await handleSessionInboxAck(
        { sessionKey: "to", ids: ["m1", "m2"] },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.updated).toBe(2);
    expect(res.status).toBe("applied");
  });

  it("preserves a typed queue_full terminal outcome", async () => {
    vi.mocked(memoryEngine.store.transitionSessionMessages).mockResolvedValue([{ id: "m1" }] as any);
    const res = parseToolText<{ updated: number; status: string }>(
      await handleSessionInboxAck(
        { sessionKey: "to", ids: ["m1"], status: "queue_full", reason: "recipient queue is full" },
        { defaultUserId: "u1" },
      ),
    );
    expect(res).toEqual({ updated: 1, status: "queue_full", messages: [{ id: "m1" }] });
    expect(memoryEngine.store.transitionSessionMessages).toHaveBeenCalledWith(expect.objectContaining({
      toSessionKey: "to",
      ids: ["m1"],
      toStatus: "queue_full",
      reason: "recipient queue is full",
    }));
  });

  it("accepts an empty ids array and returns updated:0", async () => {
    vi.mocked(memoryEngine.store.transitionSessionMessages).mockResolvedValue([]);
    const res = parseToolText<{ updated: number }>(
      await handleSessionInboxAck({ sessionKey: "to", ids: [] }, { defaultUserId: "u1" }),
    );
    expect(res.updated).toBe(0);
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
