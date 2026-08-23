import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  EgressControlChannel,
  EGRESS_CONTROL_PATH,
  type EdgeIdentity,
} from "./egressControlChannel.js";

const DEVICE: EdgeIdentity = { orgId: "org_1", userId: "user_1", deviceId: "device_abc" };
const push = {
  clientToken: "egt_client_xyz",
  sessionId: "sess_1",
  relayUrl: "ws://127.0.0.1:0/egress-relay",
  expiresAt: "2026-01-01T00:00:20.000Z",
  target: { host: "api.provider.test", port: 443 },
};

// Authenticator: a hello carrying token "good" is our device; anything else is rejected.
const authenticate = async (hello: Record<string, unknown>): Promise<EdgeIdentity | null> =>
  hello.token === "good" ? DEVICE : null;

let channel: EgressControlChannel | null = null;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      c.close();
    } catch {
      /* noop */
    }
  }
  await channel?.close();
  channel = null;
});

function connect(port: number): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${EGRESS_CONTROL_PATH}`);
  clients.push(socket);
  return socket;
}
function nextText(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8")))),
  );
}
function closedCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

describe("EgressControlChannel (C4)", () => {
  it("authenticates a hello, registers the device online, and pushes a dial to it", async () => {
    channel = new EgressControlChannel({ authenticate });
    const port = await channel.listen(0, "127.0.0.1");

    const device = connect(port);
    await new Promise<void>((r) => device.once("open", () => r()));
    const ready = nextText(device);
    device.send(JSON.stringify({ kind: "hello", token: "good" }));
    expect(await ready).toMatchObject({ kind: "ready" });
    expect(channel.isOnline(DEVICE)).toBe(true);

    const gotDial = nextText(device);
    expect(channel.pushDialToEdge(DEVICE, push)).toBe(true);
    expect(await gotDial).toMatchObject({
      kind: "dial",
      clientToken: "egt_client_xyz",
      sessionId: "sess_1",
      host: "api.provider.test",
      port: 443,
    });
  });

  it("closes a connection whose hello is rejected, and never registers it", async () => {
    channel = new EgressControlChannel({ authenticate });
    const port = await channel.listen(0, "127.0.0.1");

    const bad = connect(port);
    await new Promise<void>((r) => bad.once("open", () => r()));
    const closed = closedCode(bad);
    bad.send(JSON.stringify({ kind: "hello", token: "wrong" }));
    expect(await closed).toBe(4001);
    expect(channel.isOnline(DEVICE)).toBe(false);
  });

  it("supersedes a prior connection for the same device (one live socket)", async () => {
    channel = new EgressControlChannel({ authenticate });
    const port = await channel.listen(0, "127.0.0.1");

    const first = connect(port);
    await new Promise<void>((r) => first.once("open", () => r()));
    const firstReady = nextText(first);
    first.send(JSON.stringify({ kind: "hello", token: "good" }));
    await firstReady;

    const firstClosed = closedCode(first);
    const second = connect(port);
    await new Promise<void>((r) => second.once("open", () => r()));
    const secondReady = nextText(second);
    second.send(JSON.stringify({ kind: "hello", token: "good" }));
    await secondReady;

    expect(await firstClosed).toBe(4002); // the older socket is superseded
    // Pushes now reach the second socket.
    const got = nextText(second);
    expect(channel.pushDialToEdge(DEVICE, push)).toBe(true);
    expect(await got).toMatchObject({ kind: "dial" });
  });

  it("returns false when pushing to a device that is not online", async () => {
    channel = new EgressControlChannel({ authenticate });
    await channel.listen(0, "127.0.0.1");
    expect(channel.pushDialToEdge(DEVICE, push)).toBe(false);
  });

  it("onlineDevicesFor lists only the given account's online devices", async () => {
    // Authenticator maps token → whichever identity the token names, so the test
    // can bring several distinct devices/accounts online at once.
    const multiAuth = async (hello: Record<string, unknown>): Promise<EdgeIdentity | null> => {
      const t = hello.token;
      if (t === "a1") return { orgId: "org_1", userId: "user_1", deviceId: "dev_a1" };
      if (t === "a2") return { orgId: "org_1", userId: "user_1", deviceId: "dev_a2" };
      if (t === "other") return { orgId: "org_2", userId: "user_9", deviceId: "dev_x" };
      return null;
    };
    channel = new EgressControlChannel({ authenticate: multiAuth });
    const port = await channel.listen(0, "127.0.0.1");
    const bring = async (token: string): Promise<void> => {
      const s = connect(port);
      await new Promise<void>((r) => s.once("open", () => r()));
      const ready = nextText(s);
      s.send(JSON.stringify({ kind: "hello", token }));
      await ready;
    };
    await bring("a1");
    await bring("a2");
    await bring("other");

    expect(channel.onlineDevicesFor("org_1", "user_1").sort()).toEqual(["dev_a1", "dev_a2"]);
    expect(channel.onlineDevicesFor("org_2", "user_9")).toEqual(["dev_x"]);
    expect(channel.onlineDevicesFor("org_1", "nobody")).toEqual([]);
  });

  // Finding #1 — a burst of hellos in one tick must not amplify authenticate()
  // calls or double-register the socket (the `authed` guard flips only inside the
  // async .then; the synchronous one-shot latch is what makes this safe).
  it("processes at most one hello per socket under a burst (no amplification, single registration)", async () => {
    let authCalls = 0;
    const countingAuth = async (hello: Record<string, unknown>): Promise<EdgeIdentity | null> => {
      authCalls += 1;
      return hello.token === "good" ? DEVICE : null;
    };
    channel = new EgressControlChannel({ authenticate: countingAuth });
    const port = await channel.listen(0, "127.0.0.1");

    const device = connect(port);
    await new Promise<void>((r) => device.once("open", () => r()));
    const ready = nextText(device);
    for (let i = 0; i < 25; i += 1) {
      device.send(JSON.stringify({ kind: "hello", token: "good" }));
    }
    expect(await ready).toMatchObject({ kind: "ready" });
    await new Promise((r) => setTimeout(r, 50)); // let any stray authenticate calls run
    expect(authCalls).toBe(1);
    expect(channel.isOnline(DEVICE)).toBe(true);

    const gotDial = nextText(device);
    expect(channel.pushDialToEdge(DEVICE, push)).toBe(true);
    expect(await gotDial).toMatchObject({ kind: "dial" });
  });

  // Finding #2 — the routing key must be injective. These two identities would
  // collide onto "a:b:c:d" under a naive colon-join; they must stay isolated.
  it("keys devices injectively: colon-bearing identities do not collide or misroute", async () => {
    const A: EdgeIdentity = { orgId: "a:b", userId: "c", deviceId: "d" };
    const B: EdgeIdentity = { orgId: "a", userId: "b:c", deviceId: "d" };
    const auth = async (hello: Record<string, unknown>): Promise<EdgeIdentity | null> =>
      hello.token === "A" ? A : hello.token === "B" ? B : null;
    channel = new EgressControlChannel({ authenticate: auth });
    const port = await channel.listen(0, "127.0.0.1");

    const sa = connect(port);
    await new Promise<void>((r) => sa.once("open", () => r()));
    const aReady = nextText(sa);
    sa.send(JSON.stringify({ kind: "hello", token: "A" }));
    await aReady;
    let aClosed = -1;
    sa.once("close", (code) => {
      aClosed = code;
    });

    const sb = connect(port);
    await new Promise<void>((r) => sb.once("open", () => r()));
    const bReady = nextText(sb);
    sb.send(JSON.stringify({ kind: "hello", token: "B" }));
    await bReady;

    await new Promise((r) => setTimeout(r, 40));
    expect(aClosed).toBe(-1); // B did NOT supersede A — no collision
    expect(channel.isOnline(A)).toBe(true);
    expect(channel.isOnline(B)).toBe(true);

    const aDial = nextText(sa);
    const bDial = nextText(sb);
    expect(channel.pushDialToEdge(A, { ...push, sessionId: "sA" })).toBe(true);
    expect(channel.pushDialToEdge(B, { ...push, sessionId: "sB" })).toBe(true);
    expect(await aDial).toMatchObject({ sessionId: "sA" });
    expect(await bDial).toMatchObject({ sessionId: "sB" });
  });

  // Finding #3a — an oversized frame is rejected by ws (maxPayload), never buffered
  // toward the 100 MiB default, and the connection is not registered.
  it("rejects an oversized hello and never registers it (maxHelloBytes)", async () => {
    channel = new EgressControlChannel({ authenticate, maxHelloBytes: 64 });
    const port = await channel.listen(0, "127.0.0.1");
    const device = connect(port);
    await new Promise<void>((r) => device.once("open", () => r()));
    const closed = closedCode(device);
    device.send(JSON.stringify({ kind: "hello", token: "good", pad: "x".repeat(400) }));
    await closed; // ws enforces maxPayload and closes the connection
    expect(channel.isOnline(DEVICE)).toBe(false);
  });

  // Finding #3b — concurrent sockets are bounded so anonymous peers cannot exhaust
  // fds/heap by opening connections in a loop.
  it("bounds concurrent connections (maxConnections)", async () => {
    channel = new EgressControlChannel({ authenticate, maxConnections: 1 });
    const port = await channel.listen(0, "127.0.0.1");

    const first = connect(port);
    await new Promise<void>((r) => first.once("open", () => r()));
    const firstReady = nextText(first);
    first.send(JSON.stringify({ kind: "hello", token: "good" }));
    await firstReady;

    const second = connect(port);
    const secondClosed = closedCode(second);
    expect(await secondClosed).toBe(1013); // overloaded — slot is full
  });

  // Finding #4 — an authenticate that resolves AFTER close() must not resurrect a
  // dead socket back into the online map.
  it("does not register a socket whose hello resolves after close() (no resurrection)", async () => {
    let release!: (v: EdgeIdentity | null) => void;
    const gated = new Promise<EdgeIdentity | null>((r) => {
      release = r;
    });
    channel = new EgressControlChannel({ authenticate: async () => gated });
    const port = await channel.listen(0, "127.0.0.1");
    const ch = channel;

    const device = connect(port);
    await new Promise<void>((r) => device.once("open", () => r()));
    device.send(JSON.stringify({ kind: "hello", token: "good" }));
    await new Promise((r) => setTimeout(r, 20)); // authenticate is now pending

    await ch.close(); // shut down while the hello is in flight
    release(DEVICE); // authenticator resolves AFTER close
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.isOnline(DEVICE)).toBe(false);
  });

  // Finding #5 — /health must not disclose the enrolled-device count.
  it("does not expose the online-device count on /health", async () => {
    channel = new EgressControlChannel({ authenticate });
    const port = await channel.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true });
    expect(body).not.toHaveProperty("online");
  });
});
