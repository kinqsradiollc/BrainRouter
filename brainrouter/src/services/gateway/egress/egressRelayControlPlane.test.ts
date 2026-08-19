import { describe, expect, it } from "vitest";
import { EgressRelayControlPlane } from "./egressRelayControlPlane.js";
import {
  EgressTicketRegistry,
  ORIGIN_DEVICE_PREFIX,
  type EgressSessionIdentity,
} from "./egressTicket.js";

const identity = (): EgressSessionIdentity => ({
  orgId: "org_1",
  userId: "user_1",
  clientDeviceId: "device_abc",
  upstreamKeyId: "key_1",
});
const target = { host: "api.provider.test", port: 443 };

describe("EgressRelayControlPlane", () => {
  it("redeems the ORIGIN seat: role derived from the origin: deviceId, mapped to a relay record", async () => {
    const registry = new EgressTicketRegistry();
    const cp = new EgressRelayControlPlane(registry, { now: () => 1_700_000_000_000 });
    const pair = registry.issue(target, identity());

    const rec = await cp.consumeRelayTicket(pair.origin.token, pair.origin.presentingDeviceId);
    expect(rec).not.toBeNull();
    expect(rec!.presentingDeviceId).toBe(pair.origin.presentingDeviceId);
    expect(rec!.presentingDeviceId.startsWith(ORIGIN_DEVICE_PREFIX)).toBe(true);
    expect(rec!.peerDeviceId).toBe("device_abc"); // the client seat
    expect(rec!.grantId).toBe(pair.sessionId); // pair key = sessionId (one-user isolation)
    expect(rec!.id).toBe(pair.sessionId);
    expect(rec!.orgId).toBe("org_1");
    expect(rec!.userId).toBe("user_1");
    expect(rec!.audience).toBe("remote-relay");
    expect(rec!.scopes).toEqual([]);
  });

  it("redeems the CLIENT seat and pairs with the origin under the same grantId", async () => {
    const registry = new EgressTicketRegistry();
    const cp = new EgressRelayControlPlane(registry);
    const pair = registry.issue(target, identity());

    const origin = await cp.consumeRelayTicket(pair.origin.token, pair.origin.presentingDeviceId);
    const client = await cp.consumeRelayTicket(pair.client.token, pair.client.presentingDeviceId);
    expect(client).not.toBeNull();
    expect(client!.presentingDeviceId).toBe("device_abc");
    expect(client!.peerDeviceId).toBe(pair.origin.presentingDeviceId);
    // The two seats share the grantId, so the relay splices exactly them as one pair.
    expect(client!.grantId).toBe(origin!.grantId);
  });

  it("fails closed on a garbage token, a replay, and a client token presented under an origin: id", async () => {
    const registry = new EgressTicketRegistry();
    const cp = new EgressRelayControlPlane(registry);
    const pair = registry.issue(target, identity());

    // A token that was never issued.
    expect(await cp.consumeRelayTicket("egt_not-a-real-token", pair.client.presentingDeviceId)).toBeNull();

    // Single-use: the origin token redeems once, then never again.
    expect(await cp.consumeRelayTicket(pair.origin.token, pair.origin.presentingDeviceId)).not.toBeNull();
    expect(await cp.consumeRelayTicket(pair.origin.token, pair.origin.presentingDeviceId)).toBeNull();

    // A CLIENT token presented under an origin: deviceId derives role 'origin',
    // which mismatches the grant's 'client' role → the client cannot take the
    // gateway seat.
    const pair2 = registry.issue(target, identity());
    expect(await cp.consumeRelayTicket(pair2.client.token, pair2.origin.presentingDeviceId)).toBeNull();
  });

  it("keeps sessions isolated: two independent pairs never share a grantId (no cross-splice)", async () => {
    const registry = new EgressTicketRegistry();
    const cp = new EgressRelayControlPlane(registry);
    const a = registry.issue(target, identity());
    const b = registry.issue(target, identity());

    const aOrigin = await cp.consumeRelayTicket(a.origin.token, a.origin.presentingDeviceId);
    const bClient = await cp.consumeRelayTicket(b.client.token, b.client.presentingDeviceId);
    // Distinct sessions → distinct grantIds → the relay places them in separate
    // pairs, so session A's gateway seat can never be spliced to session B's
    // client (the one-user-isolation invariant, even for the same org).
    expect(aOrigin!.grantId).not.toBe(bClient!.grantId);
    // And a's origin peers only with a's client id, never b's.
    expect(aOrigin!.peerDeviceId).toBe("device_abc");
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});
