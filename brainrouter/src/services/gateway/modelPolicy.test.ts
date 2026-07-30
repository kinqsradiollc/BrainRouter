import { describe, expect, it, vi } from "vitest";

import type { ProviderModelRecord } from "../../providers/modelPolicyStore.js";
import type { GatewayAuthContext } from "./auth.js";
import {
  resolveGatewayModel,
  type GatewayModelPolicyStore,
} from "./modelPolicy.js";

const auth: GatewayAuthContext = {
  credentialType: "jwt",
  principalType: "user",
  userId: "user-1",
  orgId: "org-1",
  role: "developer",
  scopes: ["models:invoke"],
};

function model(overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord {
  return {
    id: "pm-1",
    orgId: "org-1",
    providerConfigId: "pc-1",
    publicModelId: "gpt-5.6-sol",
    upstreamModelId: "gpt-5.6",
    displayName: "GPT-5.6 Sol",
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    allowedEfforts: ["none", "high", "max"],
    defaultEffort: "high",
    effortWireMap: {
      none: { reasoning_effort: "none" },
      high: { reasoning_effort: "high" },
      max: { reasoning_effort: "max" },
    },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "verified",
    sourceUrl: "https://provider.example/models/gpt-5.6-sol",
    verifiedAt: "2026-07-14T00:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function store(record: ProviderModelRecord | null): GatewayModelPolicyStore {
  return {
    getProviderModelByPublicId: vi.fn(async () => record),
    getResolvedProvider: vi.fn(async (_id: string) => ({
      kind: "llm" as const,
      endpoint: "https://api.provider.example/v1",
      apiKey: "upstream-secret",
      model: "ignored-provider-default",
      models: [],
      extra: {},
      source: "db" as const,
    })),
  };
}

describe("gateway model policy resolution", () => {
  it("resolves the authenticated tenant and applies the configured default effort", async () => {
    const persistence = store(model());
    const resolved = await resolveGatewayModel({
      auth,
      publicModelId: "gpt-5.6-sol",
      store: persistence,
    });

    expect(persistence.getProviderModelByPublicId).toHaveBeenCalledWith(
      "org-1",
      "gpt-5.6-sol",
      false,
    );
    expect(resolved.selectedEffort).toBe("high");
    expect(resolved.model.upstreamModelId).toBe("gpt-5.6");
  });

  it.each(["none", "max"] as const)("preserves the exact %s effort", async (effort) => {
    const resolved = await resolveGatewayModel({
      auth,
      publicModelId: "gpt-5.6-sol",
      reasoningEffort: effort,
      store: store(model()),
    });
    expect(resolved.selectedEffort).toBe(effort);
    expect(resolved.model.effortWireMap[effort]).toEqual({ reasoning_effort: effort });
  });

  it("fails unknown, cross-tenant, disabled, and invalid-effort requests before provider custody", async () => {
    const cases = [
      { record: null, effort: undefined, code: "model_not_found" },
      { record: model({ orgId: "org-2", enabled: false }), effort: undefined, code: "model_disabled" },
      { record: model(), effort: "ultracode", code: "invalid_reasoning_effort" },
      { record: model(), effort: "low", code: "invalid_reasoning_effort" },
    ] as const;

    for (const testCase of cases) {
      const persistence = store(testCase.record);
      await expect(resolveGatewayModel({
        auth,
        publicModelId: "gpt-5.6-sol",
        reasoningEffort: testCase.effort,
        store: persistence,
      })).rejects.toMatchObject({ code: testCase.code });
      expect(persistence.getResolvedProvider).not.toHaveBeenCalled();
    }
  });

  it("fails closed when persisted effort mapping or the provider is unavailable", async () => {
    const brokenMap = store(model({ effortWireMap: {} }));
    await expect(resolveGatewayModel({
      auth,
      publicModelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      store: brokenMap,
    })).rejects.toMatchObject({ code: "invalid_reasoning_effort" });
    expect(brokenMap.getResolvedProvider).not.toHaveBeenCalled();

    const unavailable = store(model());
    vi.mocked(unavailable.getResolvedProvider).mockResolvedValue(null);
    await expect(resolveGatewayModel({
      auth,
      publicModelId: "gpt-5.6-sol",
      store: unavailable,
    })).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
