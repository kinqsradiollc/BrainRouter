/**
 * The probe network boundary. Hosted-by-default is the security property; the
 * allowlist is the escape hatch that keeps self-hosted local models working.
 */
import { describe, expect, it } from "vitest";
import { upstreamProbePolicy } from "./upstreamProbePolicy.js";

describe("upstream probe policy", () => {
  it("defaults to hosted when nothing is configured", () => {
    // The safe answer must be the one you get by forgetting to configure it.
    expect(upstreamProbePolicy({})).toEqual({});
    expect(upstreamProbePolicy({ BRAINROUTER_UPSTREAM_ALLOWLIST: "   " })).toEqual({});
  });

  it("opts into self-hosted only when exact origins are named", () => {
    expect(upstreamProbePolicy({
      BRAINROUTER_UPSTREAM_ALLOWLIST: "http://127.0.0.1:11434, http://127.0.0.1:1234",
    })).toEqual({
      mode: "self-hosted",
      allowlist: ["http://127.0.0.1:11434", "http://127.0.0.1:1234"],
    });
  });

  it("ignores empty entries rather than widening the allowlist", () => {
    // A trailing comma must not become an empty allowlist entry; whether the
    // validator would reject it is not the point — we never hand it one.
    expect(upstreamProbePolicy({ BRAINROUTER_UPSTREAM_ALLOWLIST: "http://127.0.0.1:11434,,  ," })).toEqual({
      mode: "self-hosted",
      allowlist: ["http://127.0.0.1:11434"],
    });
  });
});
