import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayEgressChannelOpener } from "./relayChannelOpener.js";
import { createEgressRelayServer } from "./egressRelayServer.js";
import { EgressTicketRegistry, type EgressSessionIdentity } from "./egressTicket.js";
import type { RemoteRelayServer } from "../../remoteRelay/server.js";
import type { EgressChannel } from "./framedTransport.js";

const CLIENT_DEVICE = "device_abc";
const identity = (): EgressSessionIdentity => ({
  orgId: "org_1",
  userId: "user_1",
  clientDeviceId: CLIENT_DEVICE,
  upstreamKeyId: "key_1",
});
const target = { host: "api.provider.test", port: 443 };

let server: RemoteRelayServer | null = null;
const edges: WebSocket[] = [];
afterEach(async () => {
  for (const e of edges.splice(0)) {
    try {
      e.close();
    } catch {
      /* noop */
    }
  }
  await server?.close();
  server = null;
});

/** A stub enrolled edge: attaches its CLIENT half, then does whatever `onBinary` says. */
function spawnStubEdge(push: {
  clientToken: string;
  relayUrl: string;
  onBinary: (frame: Buffer, edge: WebSocket) => void;
}): void {
  const edge = new WebSocket(push.relayUrl);
  edges.push(edge);
  edge.on("open", () => {
    edge.send(JSON.stringify({ kind: "attach", ticket: push.clientToken, deviceId: CLIENT_DEVICE }));
  });
  edge.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) push.onBinary(data, edge);
  });
}

describe("relay-backed EgressChannelOpener (C3)", () => {
  it("opens a live channel over the relay and splices binary frames to/from the edge", async () => {
    const registry = new EgressTicketRegistry();
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");
    const relayUrl = `ws://127.0.0.1:${port}/egress-relay`;

    const opener = createRelayEgressChannelOpener({
      registry,
      identityFor: () => identity(),
      egressRelayUrl: relayUrl,
      wsFactory: (url) => new WebSocket(url),
      // The push spins up a stub edge that echoes any binary frame back verbatim.
      pushDialToEdge: async (p) => {
        expect(p.clientToken).toBeTruthy();
        expect(p.target).toEqual(target);
        spawnStubEdge({
          clientToken: p.clientToken,
          relayUrl: p.relayUrl,
          onBinary: (frame, edge) => edge.send(frame, { binary: true }),
        });
      },
    });

    const channel: EgressChannel = await opener(target);
    const received: string[] = [];
    channel.onMessage((frame) => received.push(Buffer.from(frame).toString("utf8")));

    channel.send(Buffer.from("provider-bytes-1"));
    await new Promise((r) => setTimeout(r, 40));
    expect(received).toEqual(["provider-bytes-1"]);
    channel.close();
  });

  it("demux: a TEXT frame from the peer is never surfaced to onMessage, only binary is", async () => {
    const registry = new EgressTicketRegistry();
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");
    const relayUrl = `ws://127.0.0.1:${port}/egress-relay`;

    const opener = createRelayEgressChannelOpener({
      registry,
      identityFor: () => identity(),
      egressRelayUrl: relayUrl,
      wsFactory: (url) => new WebSocket(url),
      pushDialToEdge: async (p) => {
        spawnStubEdge({
          clientToken: p.clientToken,
          relayUrl: p.relayUrl,
          onBinary: (_frame, edge) => {
            // On the first prod byte, reply with a TEXT frame then a BINARY frame.
            edge.send(JSON.stringify({ kind: "not-a-control-frame" })); // text — must NOT reach onMessage
            edge.send(Buffer.from("real-binary"), { binary: true });
          },
        });
      },
    });

    const channel = await opener(target);
    const received: string[] = [];
    channel.onMessage((frame) => received.push(Buffer.from(frame).toString("utf8")));
    channel.send(Buffer.from("go"));
    await new Promise((r) => setTimeout(r, 60));
    // The stray text frame was demux'd away; only the binary frame surfaced.
    expect(received).toEqual(["real-binary"]);
    channel.close();
  });

  it("opens even when the EDGE wins the attach race (origin attaches second → attached{peerConnected:true})", async () => {
    const registry = new EgressTicketRegistry();
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");
    const relayUrl = `ws://127.0.0.1:${port}/egress-relay`;

    const opener = createRelayEgressChannelOpener({
      registry,
      identityFor: () => identity(),
      egressRelayUrl: relayUrl,
      wsFactory: (url) => new WebSocket(url),
      // Push spins the edge AND waits until it is attached before resolving, so
      // the origin attaches SECOND and receives attached{peerConnected:true},
      // never a later peer-connected. Without the fix, open() would stall.
      pushDialToEdge: async (p) => {
        await new Promise<void>((resolve) => {
          const edge = new WebSocket(p.relayUrl);
          edges.push(edge);
          edge.on("open", () =>
            edge.send(JSON.stringify({ kind: "attach", ticket: p.clientToken, deviceId: CLIENT_DEVICE })),
          );
          edge.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary) {
              resolve(); // the edge's own 'attached' — it is now in the splice
              return;
            }
            edge.send(data, { binary: true }); // echo provider bytes
          });
        });
      },
    });

    const channel = await opener(target); // must resolve, not stall for 8s
    const received: string[] = [];
    channel.onMessage((f) => received.push(Buffer.from(f).toString("utf8")));
    channel.send(Buffer.from("hello"));
    await new Promise((r) => setTimeout(r, 40));
    expect(received).toEqual(["hello"]);
    channel.close();
  });

  it("fails the open when the edge never attaches (bounded, so the ladder can fall back)", async () => {
    const registry = new EgressTicketRegistry();
    server = createEgressRelayServer({ registry, ping: async () => true });
    const port = await server.listen(0, "127.0.0.1");
    const relayUrl = `ws://127.0.0.1:${port}/egress-relay`;

    const opener = createRelayEgressChannelOpener({
      registry,
      identityFor: () => identity(),
      egressRelayUrl: relayUrl,
      wsFactory: (url) => new WebSocket(url),
      peerConnectTimeoutMs: 80,
      pushDialToEdge: async () => {
        /* edge is offline — never attaches */
      },
    });

    await expect(opener(target)).rejects.toThrow(/did not connect/i);
  });
});
