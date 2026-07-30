import { describe, expect, it } from "vitest";
import { emailDomain, normalizeDomains, domainAllowed } from "../tenancy/emailDomain.js";

describe("EMAIL-DOMAIN allowlist helpers", () => {
  it("emailDomain extracts the lowercased domain", () => {
    expect(emailDomain("Alice@Brainrouter.DEV")).toBe("brainrouter.dev");
    expect(emailDomain("a@b@corp.com")).toBe("corp.com"); // last @ wins
    expect(emailDomain("no-at-sign")).toBe("");
  });

  it("normalizeDomains lowercases, strips '@', dedupes, drops blanks", () => {
    expect(normalizeDomains(["@Acme.com", "acme.com", " ", "Beta.io"])).toEqual(["acme.com", "beta.io"]);
  });

  it("an empty allowlist allows everyone", () => {
    expect(domainAllowed("anyone@anywhere.com", [])).toBe(true);
  });

  it("a non-empty allowlist requires an exact domain match", () => {
    expect(domainAllowed("dev@brainrouter.dev", ["brainrouter.dev"])).toBe(true);
    expect(domainAllowed("dev@brainrouter.dev", ["@BrainRouter.dev"])).toBe(true); // normalized
    expect(domainAllowed("dev@evil.com", ["brainrouter.dev"])).toBe(false);
    expect(domainAllowed("dev@sub.brainrouter.dev", ["brainrouter.dev"])).toBe(false); // subdomains not implied
    expect(domainAllowed("malformed", ["brainrouter.dev"])).toBe(false);
  });
});
