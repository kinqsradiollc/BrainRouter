import { describe, expect, it } from "vitest";
import { createEdgePushDelivery } from "./edgePushDelivery.js";
import type { EgressSessionIdentity } from "./egressTicket.js";
import type { EdgeDialPush } from "./relayChannelOpener.js";
import type { EdgeIdentity } from "./egressControlChannel.js";

const identity: EgressSessionIdentity = {
  orgId: "org_1",
  userId: "user_1",
  clientDeviceId: "device_abc",
  upstreamKeyId: "key_1",
};
const push: EdgeDialPush = {
  clientToken: "egt_client_xyz",
  sessionId: "sess_1",
  relayUrl: "ws://127.0.0.1:0/egress-relay",
  expiresAt: "2026-01-01T00:00:20.000Z",
  target: { host: "api.provider.test", port: 443 },
};

describe("createEdgePushDelivery (C4 follow-up)", () => {
  it("addresses the push to the user's enrolled clientDeviceId and resolves when delivered", async () => {
    let seenId: EdgeIdentity | null = null;
    let seenPush: EdgeDialPush | null = null;
    const channel = {
      pushDialToEdge(id: EdgeIdentity, p: EdgeDialPush): boolean {
        seenId = id;
        seenPush = p;
        return true;
      },
    };
    const deliver = createEdgePushDelivery(channel, identity);
    await expect(deliver(push)).resolves.toBeUndefined();
    expect(seenId).toEqual({ orgId: "org_1", userId: "user_1", deviceId: "device_abc" });
    expect(seenPush).toBe(push);
  });

  it("rejects (fast-fail) when the device is offline so the opener can fall back", async () => {
    const channel = {
      pushDialToEdge(): boolean {
        return false;
      },
    };
    const deliver = createEdgePushDelivery(channel, identity);
    await expect(deliver(push)).rejects.toThrow(/offline/i);
  });
});
