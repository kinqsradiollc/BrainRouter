import { describe, expect, it } from "vitest";
import { normalizeEgressOptIn, egressOptInKey } from "./egressSettings.js";

describe("egress consent settings (C7 D2)", () => {
  it("coerces only a boolean true to enabled; everything else is off (fail-safe)", () => {
    expect(normalizeEgressOptIn({ enabled: true })).toEqual({ enabled: true });
    expect(normalizeEgressOptIn({ enabled: false })).toEqual({ enabled: false });
    expect(normalizeEgressOptIn({ enabled: "true" })).toEqual({ enabled: false });
    expect(normalizeEgressOptIn({ enabled: 1 })).toEqual({ enabled: false });
    expect(normalizeEgressOptIn({})).toEqual({ enabled: false });
    expect(normalizeEgressOptIn(null)).toEqual({ enabled: false });
    expect(normalizeEgressOptIn(undefined)).toEqual({ enabled: false });
  });

  it("keys the per-org opt-in on the exact string the gateway reads", () => {
    expect(egressOptInKey("org_42")).toBe("egress:clientTunnelOptIn:org_42");
  });
});
