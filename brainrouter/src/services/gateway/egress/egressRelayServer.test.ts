import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createEgressRelayServer, EGRESS_RELAY_PATH } from "./egressRelayServer.js";
import { EgressTicketRegistry, type EgressSessionIdentity } from "./egressTicket.js";
import type { RemoteRelayServer } from "../../remoteRelay/server.js";

const identity = (): EgressSessionIdentity => ({
  orgId: "org_1",
  userId: "user_1",
  clientDeviceId: "device_abc",
  upstreamKeyId: "key_1",
});
const target = { host: "api.provider.test", port: 443 };

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${EGRESS_RELAY_PATH}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (data) => resolve((data as Buffer).toString("utf8"))));
}
function nextBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(data as Buffer)));
}
async function attach(socket: WebSocket, ticket: string, deviceId: string): Promise<Record<string, unknown>> {
  const reply = nextMessage(socket);
  socket.send(JSON.stringify({ kind: "attach", ticket, deviceId }));
  return JSON.parse(await reply);
}

let server: RemoteRelayServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("egress relay endpoint (C2)", () => {
  it("pairs a minted origin+client on /egress-relay and splices opaque frames both ways", async () => {
    const registry = new EgressTicketRegistry();
    const pair = registry.issue(target, identity());
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");

    // Gateway (origin) seat attaches first — no peer yet.
    const origin = await connect(port);
    const originAttached = await attach(origin, pair.origin.token, pair.origin.presentingDeviceId);
    expect(originAttached).toMatchObject({ kind: "attached", peerConnected: false });

    // Client seat attaches — both sides learn they are paired.
    const client = await connect(port);
    const originPeerNotice = nextMessage(origin);
    const clientAttached = await attach(client, pair.client.token, pair.client.presentingDeviceId);
    expect(clientAttached).toMatchObject({ kind: "attached", peerConnected: true });
    expect(JSON.parse(await originPeerNotice)).toMatchObject({ kind: "peer-connected" });

    // Opaque bytes splice verbatim gateway->client and client->gateway.
    const toClient = nextBinary(client);
    origin.send(Buffer.from("ciphertext-down"));
    expect((await toClient).toString("utf8")).toBe("ciphertext-down");

    const toOrigin = nextBinary(origin);
    client.send(Buffer.from("ciphertext-up"));
    expect((await toOrigin).toString("utf8")).toBe("ciphertext-up");

    origin.close();
    client.close();
  });

  it("closes an attach whose ticket was never issued (fail-closed)", async () => {
    const registry = new EgressTicketRegistry();
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");

    const bad = await connect(port);
    const closedCode = new Promise<number>((resolve) => bad.once("close", (code) => resolve(code)));
    bad.send(JSON.stringify({ kind: "attach", ticket: "egt_never-issued", deviceId: "device_abc" }));
    expect(await closedCode).toBeGreaterThan(0);
  });
});
