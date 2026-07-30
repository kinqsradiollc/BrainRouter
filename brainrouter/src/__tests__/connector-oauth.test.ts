import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  signState, verifyState, makePkce, buildAuthorizeUrl, exchangeCode, refreshToken,
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
  it("uses provider-specific comma-delimited scopes", () => {
    const slack = new URL(buildAuthorizeUrl("slack", "cid", "http://localhost/cb", "S", ["channels:read", "files:read"]));
    const linear = new URL(buildAuthorizeUrl("linear", "cid", "http://localhost/cb", "S", ["read", "write"], "CHAL"));
    expect(slack.searchParams.get("scope")).toBe("channels:read,files:read");
    expect(linear.searchParams.get("scope")).toBe("read,write");
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
  it("uses Notion's Basic-auth JSON exchange contract", async () => {
    let request: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ access_token: "notion-token" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(exchangeCode("notion", { clientId: "id", clientSecret: "secret", code: "code", redirectUri: "http://localhost/cb" }, { fetchImpl })).resolves.toMatchObject({ accessToken: "notion-token" });
    expect(request?.headers).toMatchObject({ "Content-Type": "application/json", Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}` });
    expect(JSON.parse(String(request?.body))).toMatchObject({ grant_type: "authorization_code", code: "code" });
  });
  it("rejects Slack's ok:false token response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    await expect(exchangeCode("slack", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "http://localhost/cb" }, { fetchImpl })).rejects.toThrow(/invalid_auth/);
  });
  it("accepts Slack's nested authed_user token shape", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, authed_user: { access_token: "user-token", refresh_token: "user-refresh", expires_in: 3600, scope: "channels:read" } }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    await expect(exchangeCode("slack", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "http://localhost/cb" }, { fetchImpl, nowSec: () => 100 })).resolves.toMatchObject({ accessToken: "user-token", refreshToken: "user-refresh", expiresAt: new Date(3700 * 1000).toISOString(), scope: "channels:read" });
  });
  for (const source of ["gitlab", "google-drive", "gmail", "linear"] as const) {
    it(`${source} supports a public PKCE exchange without client_secret`, async () => {
      let body = "";
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ access_token: `${source}-token`, refresh_token: "refresh", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;
      const token = await exchangeCode(source, { clientId: "public-client", clientSecret: "", code: "code", redirectUri: "http://localhost/cb", codeVerifier: "verifier" }, { fetchImpl });
      expect(token.accessToken).toBe(`${source}-token`);
      expect(body).toContain("code_verifier=verifier");
      expect(body).not.toContain("client_secret=");
    });
  }
  it("refreshes expiring OAuth tokens", async () => {
    let body = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 60 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const token = await refreshToken("google-drive", { clientId: "c", clientSecret: "s", refreshToken: "old", redirectUri: "http://localhost/cb" }, { fetchImpl, nowSec: () => 100 });
    expect(token).toMatchObject({ accessToken: "fresh", refreshToken: "new-refresh" });
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old");
    expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%2Fcb");
  });
});
