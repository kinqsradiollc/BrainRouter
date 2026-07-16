import { describe, expect, it } from "vitest";
import {
  githubAccountTokenFromResponse,
  githubRepositoryAccessMode,
  githubAccountTokenSettingKey,
  readGithubAccountToken,
  resolveGithubAccountToken,
} from "./githubAccountToken.js";

describe("GitHub account connector token storage", () => {
  it("uses installation repositories only for device-flow GitHub App tokens", () => {
    expect(githubRepositoryAccessMode({ flow: "device" })).toBe("installations");
    expect(githubRepositoryAccessMode({ flow: "web" })).toBe("user");
    expect(githubRepositoryAccessMode({ flow: undefined })).toBe("user");
  });

  it("reads the existing sealed-setting contract without exposing it through config", async () => {
    const getSetting = async <T>(key: string): Promise<T | null> => {
      expect(key).toBe("connectorToken:github:user-1");
      return { sealed: JSON.stringify({ accessToken: "ghu_test", login: "octocat", scope: "repo", connectedAt: "2026-07-14T00:00:00.000Z" }) } as T;
    };

    expect(githubAccountTokenSettingKey("user-1")).toBe("connectorToken:github:user-1");
    await expect(readGithubAccountToken({ getSetting }, "user-1")).resolves.toEqual({
      accessToken: "ghu_test",
      login: "octocat",
      scope: "repo",
      connectedAt: "2026-07-14T00:00:00.000Z",
    });
  });

  it("captures GitHub App expiry and refresh-token metadata without exposing it elsewhere", () => {
    expect(githubAccountTokenFromResponse({
      access_token: "ghu_access",
      expires_in: 28_800,
      refresh_token: "ghr_refresh",
      refresh_token_expires_in: 15_897_600,
      scope: "",
    }, {
      login: "octocat",
      connectedAt: "2026-07-14T00:00:00.000Z",
      flow: "device",
    }, Date.parse("2026-07-14T00:00:00.000Z"))).toEqual({
      accessToken: "ghu_access",
      login: "octocat",
      scope: "",
      connectedAt: "2026-07-14T00:00:00.000Z",
      refreshToken: "ghr_refresh",
      expiresAt: "2026-07-14T08:00:00.000Z",
      refreshTokenExpiresAt: "2027-01-14T00:00:00.000Z",
      flow: "device",
    });
  });

  it("rotates an expiring device-flow token once and persists the replacement sealed", async () => {
    const previousKey = process.env.BRAINROUTER_SECRET_KEY;
    process.env.BRAINROUTER_SECRET_KEY = "11".repeat(32);
    try {
      let stored: { sealed?: string } = { sealed: JSON.stringify({
        accessToken: "ghu_old",
        refreshToken: "ghr_old",
        expiresAt: "2026-07-14T00:01:00.000Z",
        refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
        login: "octocat",
        scope: "",
        connectedAt: "2026-07-13T00:00:00.000Z",
        flow: "device",
      }) };
      const store = {
        getSetting: async <T>(): Promise<T | null> => stored as T,
        setSetting: async <T>(_key: string, value: T): Promise<void> => { stored = value as { sealed?: string }; },
      };
      const calls: Array<{ url: string; body: string }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({
          access_token: "ghu_new",
          expires_in: 28_800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15_897_600,
          scope: "",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      const resolved = await resolveGithubAccountToken(store, "user-1", {
        clientId: "Iv_test",
        fetchImpl,
        nowMs: () => Date.parse("2026-07-14T00:00:00.000Z"),
      });

      expect(resolved).toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new", flow: "device" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
      expect(new URLSearchParams(calls[0]?.body).get("client_id")).toBe("Iv_test");
      expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBe("ghr_old");
      expect(new URLSearchParams(calls[0]?.body).has("client_secret")).toBe(false);
      await expect(readGithubAccountToken(store, "user-1")).resolves.toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
      expect(stored.sealed?.includes("ghu_new")).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.BRAINROUTER_SECRET_KEY;
      else process.env.BRAINROUTER_SECRET_KEY = previousKey;
    }
  });

  it("fails closed for missing users, malformed records, and empty tokens", async () => {
    const missing = { getSetting: async <T>(): Promise<T | null> => null };
    const malformed = { getSetting: async <T>(): Promise<T | null> => ({ sealed: "{" }) as T };
    const empty = { getSetting: async <T>(): Promise<T | null> => ({ sealed: JSON.stringify({ accessToken: "" }) }) as T };

    await expect(readGithubAccountToken(missing, "user-1")).resolves.toBeNull();
    await expect(readGithubAccountToken(malformed, "user-1")).resolves.toBeNull();
    await expect(readGithubAccountToken(empty, "user-1")).resolves.toBeNull();
    await expect(readGithubAccountToken(missing, "")).resolves.toBeNull();
  });
});
