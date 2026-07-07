import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  signState, verifyState, makePkce, buildAuthorizeUrl, exchangeCode,
  isOAuthSource, OAUTH_PROVIDERS, type OAuthState,
} from "../connectors/oauthBroker.js";

const SECRET = "test-broker-secret";
const base: OAuthState = { userId: "u1", orgId: "org_1", source: "github", iat: 1000 };

describe("oauth broker — signed state", () => {
  it("round-trips a valid, in-TTL state", () => {
    const tok = signState(base, SECRET);
    const got = verifyState(tok, SECRET, 600, 1200);
    expect(got?.userId).toBe("u1");
    expect(got?.source).toBe("github");
  });
  it("rejects a tampered signature", () => {
    const tok = signState(base, SECRET);
    const forged = tok.slice(0, -2) + (tok.endsWith("aa") ? "bb" : "aa");
    expect(verifyState(forged, SECRET, 600, 1200)).toBeNull();
  });
  it("rejects a wrong secret", () => {
    expect(verifyState(signState(base, SECRET), "other", 600, 1200)).toBeNull();
  });
  it("rejects an expired state", () => {
    expect(verifyState(signState(base, SECRET), SECRET, 600, 2000)).toBeNull(); // 1000s later > 600 ttl
  });
  it("rejects a future-dated state (clock-skew guard)", () => {
    expect(verifyState(signState({ ...base, iat: 5000 }, SECRET), SECRET, 600, 1000)).toBeNull();
  });
});

describe("oauth broker — PKCE + authorize URL", () => {
  it("PKCE challenge is S256(verifier)", () => {
    const { verifier, challenge, method } = makePkce();
    const expected = crypto.createHash("sha256").update(verifier).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(method).toBe("S256");
    expect(challenge).toBe(expected);
  });
  it("builds an authorize URL with the core params + PKCE for pkce providers", () => {
    const u = new URL(buildAuthorizeUrl("gitlab", "cid", "http://localhost:3747/cb", "STATE", ["read_api"], "CHAL"));
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3747/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("read_api");
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
  it("omits PKCE for non-pkce providers (github)", () => {
    const u = new URL(buildAuthorizeUrl("github", "cid", "http://localhost/cb", "S", [], "CHAL"));
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(u.searchParams.get("scope")).toBe(OAUTH_PROVIDERS.github.scopes.join(" "));
  });
});

describe("oauth broker — source registry + exchange", () => {
  it("isOAuthSource only for registered providers", () => {
    expect(isOAuthSource("github")).toBe(true);
    expect(isOAuthSource("filesystem")).toBe(false);
    expect(isOAuthSource("web")).toBe(false);
  });
  it("exchangeCode parses tokens with an injected fetch", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "repo" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
    const tok = await exchangeCode("github", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "http://localhost/cb" }, { fetchImpl, nowSec: () => 1000 });
    expect(tok.accessToken).toBe("at");
    expect(tok.refreshToken).toBe("rt");
    expect(tok.expiresAt).toBe(new Date((1000 + 3600) * 1000).toISOString());
  });
  it("exchangeCode throws on a provider error body", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: "bad_verification_code", error_description: "expired" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
    await expect(exchangeCode("github", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "http://localhost/cb" }, { fetchImpl })).rejects.toThrow(/expired/);
  });
});
