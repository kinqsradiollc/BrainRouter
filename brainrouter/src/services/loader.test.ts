// ADR-041 A41-12 — the generic service loader boots a service from its profile.
import { describe, it, expect, vi } from "vitest";
import { bootService } from "./loader.js";
import type { ServiceEntrypoint, ServiceHandle } from "./serviceEntrypoints.js";

const handle: ServiceHandle = { stop: async () => {} };

describe("bootService", () => {
  it("boots the registered entrypoint with the profile's default port", () => {
    const spy: ServiceEntrypoint = vi.fn(() => handle);
    const got = bootService("provider-gateway", {}, { "provider-gateway": spy });
    expect(spy).toHaveBeenCalledWith(3748); // provider-gateway defaultPort
    expect(got).toBe(handle);
  });

  it("prefers an explicit GATEWAY_PORT over the profile default", () => {
    const spy: ServiceEntrypoint = vi.fn(() => handle);
    bootService("provider-gateway", { GATEWAY_PORT: "9999" }, { "provider-gateway": spy });
    expect(spy).toHaveBeenCalledWith(9999);
  });

  it("ignores a non-numeric GATEWAY_PORT and falls back to the default", () => {
    const spy: ServiceEntrypoint = vi.fn(() => handle);
    bootService("provider-gateway", { GATEWAY_PORT: "nonsense" }, { "provider-gateway": spy });
    expect(spy).toHaveBeenCalledWith(3748);
  });

  it("fails loud on an unknown service id (never boots a dark container)", () => {
    expect(() => bootService("nope", {}, {})).toThrow(/Unknown service profile "nope"/);
  });

  it("fails loud when a profile has no registered entrypoint", () => {
    // provider-gateway HAS a profile; pass an empty entrypoint map to hit the branch.
    expect(() => bootService("provider-gateway", {}, {})).toThrow(/no registered entrypoint/);
  });
});
