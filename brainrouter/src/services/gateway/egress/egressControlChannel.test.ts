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
});
