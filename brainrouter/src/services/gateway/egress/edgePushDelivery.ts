import type { EgressSessionIdentity } from "./egressTicket.js";
import type { EdgeDialPush } from "./relayChannelOpener.js";
import type { EdgeIdentity, EgressControlChannel } from "./egressControlChannel.js";

/**
 * ADR-043 S3b (C4 follow-up) — bridge the relay opener's fire-and-forget
 * `pushDialToEdge(push)` to the control channel's device-addressed
 * `pushDialToEdge(id, push)`. The requesting user's {@link EgressSessionIdentity}
 * is known when the opener is constructed (per dial), so the edge is bound here:
 * it is that user's enrolled `clientDeviceId`.
 *
 * If the device is offline the control channel returns false; we REJECT rather
 * than resolve so the opener fails fast and the S4a fallback ladder drops to
 * direct server egress — instead of minting a pair, attaching the origin seat,
 * and stalling for the full peer-connect timeout against a device that will
 * never join.
 */
export function createEdgePushDelivery(
  channel: Pick<EgressControlChannel, "pushDialToEdge">,
  identity: EgressSessionIdentity,
): (push: EdgeDialPush) => Promise<void> {
  const edge: EdgeIdentity = {
    orgId: identity.orgId,
    userId: identity.userId,
    deviceId: identity.clientDeviceId,
  };
  return async (push: EdgeDialPush): Promise<void> => {
    const delivered = channel.pushDialToEdge(edge, push);
    if (!delivered) throw new Error("egress edge device is offline");
  };
}
