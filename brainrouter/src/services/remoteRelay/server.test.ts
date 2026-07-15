/**
 * Task 22 acceptance — the opaque outbound-WSS relay: first-frame ticket auth
 * (never URL), single-use consume, opaque bidirectional splice, reconnect epoch,
 * revocation disconnect, and unauthenticated readiness.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RemoteRelayServer, RELAY_CLOSE, RELAY_PATH } from "./server.js";
import type { RemoteRelayTicketRecord } from "../../remote/store.js";

function ticketRecord(over: Partial<RemoteRelayTicketRecord>): RemoteRelayTicketRecord {
  return {
    id: "relay-session-1",
    orgId: "org-a",
    userId: "user-a",
    presentingDeviceId: "mobile-1",
    peerDeviceId: "desktop-1",
    grantId: "grant-1",
    sessionFamilyId: "family-1",
    audience: "remote-relay",
    scopes: ["monitor"],
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    consumedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Single-use in-memory ticket table keyed by the raw ticket string. */
function fakeControlPlane(tickets: Record<string, RemoteRelayTicketRecord>) {
  const consumed = new Set<string>();
  return {
    async consumeRelayTicket(ticket: string, presentingDeviceId: string): Promise<RemoteRelayTicketRecord | null> {
      const record = tickets[ticket];
      if (!record || consumed.has(ticket) || record.presentingDeviceId !== presentingDeviceId) return null;
      consumed.add(ticket);
      return record;
    },
  };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${RELAY_PATH}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(data.toString("utf8"))));
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function attach(socket: WebSocket, ticket: string, deviceId: string): Promise<Record<string, unknown>> {
  const reply = nextMessage(socket);
  socket.send(JSON.stringify({ kind: "attach", ticket, deviceId }));
  return JSON.parse(await reply);
}

let server: RemoteRelayServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe("remote relay server", () => {
  it("readiness responds without auth and reflects the db probe", async () => {
    server = new RemoteRelayServer({ controlPlane: fakeControlPlane({}), ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", service: "remote-relay", db: true });
  });

  it("rejects an invalid or replayed ticket and enforces the attach deadline", async () => {
    const plane = fakeControlPlane({
      rrt_good: ticketRecord({}),
    });
    server = new RemoteRelayServer({ controlPlane: plane, ping: async () => true, attachDeadlineMs: 150 });
    const port = await server.listen(0, "127.0.0.1");

    const bad = await connect(port);
    bad.send(JSON.stringify({ kind: "attach", ticket: "rrt_nope", deviceId: "mobile-1" }));
    expect(await closed(bad)).toBe(RELAY_CLOSE.invalidTicket);

    const first = await connect(port);
    await attach(first, "rrt_good", "mobile-1");
    const replay = await connect(port);
    replay.send(JSON.stringify({ kind: "attach", ticket: "rrt_good", deviceId: "mobile-1" }));
    expect(await closed(replay)).toBe(RELAY_CLOSE.invalidTicket);

    const silent = await connect(port);
    expect(await closed(silent)).toBe(RELAY_CLOSE.attachTimeout);
  });

  it("splices opaque frames both ways between the two devices of one grant", async () => {
    const plane = fakeControlPlane({
      rrt_mobile: ticketRecord({ presentingDeviceId: "mobile-1", peerDeviceId: "desktop-1" }),
      rrt_desktop: ticketRecord({ id: "relay-session-2", presentingDeviceId: "desktop-1", peerDeviceId: "mobile-1" }),
    });
    server = new RemoteRelayServer({ controlPlane: plane, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");

    const mobile = await connect(port);
    const attachedMobile = await attach(mobile, "rrt_mobile", "mobile-1");
    expect(attachedMobile).toMatchObject({ kind: "attached", peerConnected: false });

    const desktop = await connect(port);
    const peerNotice = nextMessage(mobile); // mobile learns its peer arrived
    const attachedDesktop = await attach(desktop, "rrt_desktop", "desktop-1");
    expect(attachedDesktop).toMatchObject({ kind: "attached", peerConnected: true });
    expect(JSON.parse(await peerNotice)).toMatchObject({ kind: "peer-connected" });

    // Opaque ciphertext-style frames pass through unmodified in both directions.
    const toDesktop = nextMessage(desktop);
    mobile.send("opaque-ciphertext-1");
    expect(await toDesktop).toBe("opaque-ciphertext-1");
    const toMobile = nextMessage(mobile);
    desktop.send("opaque-ciphertext-2");
    expect(await toMobile).toBe("opaque-ciphertext-2");
  });

  it("a reconnect replaces the previous connection for the same device", async () => {
    const plane = fakeControlPlane({
      rrt_one: ticketRecord({}),
      rrt_two: ticketRecord({ id: "relay-session-2" }),
    });
    server = new RemoteRelayServer({ controlPlane: plane, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");

    const first = await connect(port);
    await attach(first, "rrt_one", "mobile-1");
    const firstClosed = closed(first);
    const second = await connect(port);
    await attach(second, "rrt_two", "mobile-1");
    expect(await firstClosed).toBe(RELAY_CLOSE.peerReplaced);
  });

  it("revocation disconnects by grant and by device", async () => {
    const plane = fakeControlPlane({
      rrt_mobile: ticketRecord({}),
      rrt_other: ticketRecord({ id: "s2", grantId: "grant-2", sessionFamilyId: "family-2", presentingDeviceId: "mobile-9", peerDeviceId: "desktop-9" }),
    });
    server = new RemoteRelayServer({ controlPlane: plane, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");

    const a = await connect(port);
    await attach(a, "rrt_mobile", "mobile-1");
    const b = await connect(port);
    await attach(b, "rrt_other", "mobile-9");

    const aClosed = closed(a);
    expect(server.revoke({ grantId: "grant-1" })).toBe(1);
    expect(await aClosed).toBe(RELAY_CLOSE.revoked);

    const bClosed = closed(b);
    expect(server.revoke({ deviceId: "desktop-9" })).toBe(1);
    expect(await bClosed).toBe(RELAY_CLOSE.revoked);
  });

  it("fans in revocations from an injected feed (multi-instance seam)", async () => {
    let publish: ((selector: { grantId?: string }) => void) | null = null;
    const plane = fakeControlPlane({ rrt_mobile: ticketRecord({}) });
    server = new RemoteRelayServer({
      controlPlane: plane,
      ping: async () => true,
      revocationFeed: { subscribe(listener) { publish = listener; return () => { publish = null; }; } },
    });
    const port = await server.listen(0, "127.0.0.1");
    const socket = await connect(port);
    await attach(socket, "rrt_mobile", "mobile-1");
    const wasClosed = closed(socket);
    publish!({ grantId: "grant-1" });
    expect(await wasClosed).toBe(RELAY_CLOSE.revoked);
  });
});
