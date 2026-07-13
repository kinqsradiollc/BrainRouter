import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderStore } from "./store.js";
import type { ProviderConfigRecord, ProviderKind, ResolvedProviderConfig } from "./types.js";
import { seedProvidersFromEnv } from "./seed.js";
import { resolveProviderConfig } from "./resolver.js";

/** Minimal in-memory ProviderStore for the cutover tests. */
function fakeStore(): ProviderStore & { rows: Map<string, ResolvedProviderConfig> } {
  const rows = new Map<string, ResolvedProviderConfig>(); // key: `${org}:${kind}`
  let n = 0;
  return {
    rows,
    async getDefaultResolvedProvider(orgId, kind) { return rows.get(`${orgId}:${kind}`) ?? null; },
    async getResolvedProvider() { return null; },
    async createProviderConfig(orgId, input) {
      const rec: ProviderConfigRecord = {
        id: `p${++n}`, orgId, kind: input.kind, label: input.label ?? "", baseUrl: input.baseUrl ?? "",
        model: input.model ?? "", models: input.models ?? [], extra: input.extra ?? {},
        isDefault: !!input.isDefault, hasKey: !!input.apiKey, createdAt: "", updatedAt: "",
      } as unknown as ProviderConfigRecord;
      rows.set(`${orgId}:${input.kind}`, {
        kind: input.kind, endpoint: input.baseUrl ?? "", apiKey: input.apiKey ?? "", model: input.model ?? "",
        models: input.models ?? [], extra: input.extra ?? {}, source: "db",
      });
      return rec;
    },
    async setDefaultProvider() { /* fake: createProviderConfig already stored the default */ },
    async listProviderConfigs() { return []; },
    async getProviderConfig() { return null; },
    async updateProviderConfig() { return null; },
    async deleteProviderConfig() { /* noop */ },
  };
}

const ORG = "org_system";

describe("ADR-012 — provider cutover (DB-only + env seed)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("resolveProviderConfig is DB-only: env is NOT a fallback", async () => {
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "env-key");
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://env.test/v1/chat/completions");
    const store = fakeStore();
    // No DB row → null, even though env is set.
    expect(await resolveProviderConfig(store, ORG, "llm")).toBeNull();
  });

  it("seedProvidersFromEnv migrates a legacy env provider into the DB once", async () => {
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "env-key");
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://env.test/v1/chat/completions");
    vi.stubEnv("BRAINROUTER_LLM_MODEL", "gpt-4o-mini");
    const store = fakeStore();

    const seeded = await seedProvidersFromEnv(store, ORG);
    expect(seeded).toContain("llm");

    // After seeding, the resolver returns the DB config (source db).
    const resolved = await resolveProviderConfig(store, ORG, "llm");
    expect(resolved?.source).toBe("db");
    expect(resolved?.apiKey).toBe("env-key");
    expect(resolved?.endpoint).toBe("https://env.test/v1/chat/completions");
  });

  it("seed is idempotent — never overwrites an existing DB provider", async () => {
    const store = fakeStore();
    // Pre-existing dashboard-configured provider.
    store.rows.set(`${ORG}:llm`, { kind: "llm", endpoint: "https://db.test", apiKey: "db-key", model: "m", models: [], extra: {}, source: "db" });
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "env-key");
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://env.test");

    const seeded = await seedProvidersFromEnv(store, ORG);
    expect(seeded).not.toContain("llm");
    expect((await resolveProviderConfig(store, ORG, "llm"))?.apiKey).toBe("db-key"); // unchanged
  });

  it("no env → nothing seeded", async () => {
    const store = fakeStore();
    expect(await seedProvidersFromEnv(store, ORG)).toEqual([]);
  });
});
