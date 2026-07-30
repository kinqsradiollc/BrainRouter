import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyJwt } from "../../api/auth/crypto.js";
import type { ModelPolicyStore, ProviderModelRecord } from "../../providers/modelPolicyStore.js";
import {
  modelGateway,
  resolveScopedModelSelection,
  ScopedModelSelectionError,
} from "./modelGateway.js";

function policy(orgId: string, id: string, isDefault = true): ProviderModelRecord {
  return {
    id: `${orgId}:${id}`,
    orgId,
    providerConfigId: `provider:${orgId}`,
    publicModelId: id,
    upstreamModelId: `private:${id}`,
    displayName: id,
    enabled: true,
    isDefault,
    sortOrder: 0,
    allowedEfforts: ["low", "high"],
    defaultEffort: "low",
    effortWireMap: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "manual",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function storeFor(models: Record<string, ProviderModelRecord[]>): ModelPolicyStore {
  return {
    listProviderModels: vi.fn(async (orgId) => models[orgId] ?? []),
    ensureModelGatewayServicePrincipal: vi.fn(async (orgId) => `brain-worker:${orgId}`),
  } as unknown as ModelPolicyStore;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("tenant-scoped internal model gateway", () => {
  it("selects only enabled models in the requested org and validates effort", async () => {
    const store = storeFor({
      "org-a": [policy("org-a", "a-model")],
      "org-b": [policy("org-b", "b-model")],
    });

    await expect(resolveScopedModelSelection({
      store,
      orgId: "org-a",
      requestedModel: "b-model",
    })).rejects.toMatchObject({ code: "model_not_allowed" });
    await expect(resolveScopedModelSelection({
      store,
      orgId: "org-a",
      requestedModel: "a-model",
      reasoningEffort: "max",
    })).rejects.toMatchObject({ code: "invalid_reasoning_effort" });

    await expect(resolveScopedModelSelection({ store, orgId: "org-b" })).resolves.toEqual({
      orgId: "org-b",
      servicePrincipalId: "brain-worker:org-b",
      publicModelId: "b-model",
      reasoningEffort: "low",
    });
  });

  it("inherits the system org's models when the requested org has none (deployment default)", async () => {
    const prev = process.env.BRAINROUTER_SYSTEM_ORG_ID;
    process.env.BRAINROUTER_SYSTEM_ORG_ID = "org-system";
    try {
      // Requested org has no models; the system org does → dispatch resolves as the
      // model OWNER (org-system) so its service principal is accepted downstream.
      const store = storeFor({ "org-system": [policy("org-system", "default-model")] });
      await expect(resolveScopedModelSelection({ store, orgId: "org-empty" })).resolves.toEqual({
        orgId: "org-system",
        servicePrincipalId: "brain-worker:org-system",
        publicModelId: "default-model",
        reasoningEffort: "low",
      });
    } finally {
      if (prev === undefined) delete process.env.BRAINROUTER_SYSTEM_ORG_ID; else process.env.BRAINROUTER_SYSTEM_ORG_ID = prev;
    }
  });

  it("still throws model_not_configured when neither the org nor the system org has a model", async () => {
    const prev = process.env.BRAINROUTER_SYSTEM_ORG_ID;
    process.env.BRAINROUTER_SYSTEM_ORG_ID = "org-system";
    try {
      await expect(resolveScopedModelSelection({ store: storeFor({}), orgId: "org-empty" }))
        .rejects.toMatchObject({ code: "model_not_configured" });
    } finally {
      if (prev === undefined) delete process.env.BRAINROUTER_SYSTEM_ORG_ID; else process.env.BRAINROUTER_SYSTEM_ORG_ID = prev;
    }
  });

  it("sends public routing state with a short-lived org-bound service JWT and no provider secret", async () => {
    const secret = "unit-test-jwt-secret";
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await modelGateway.dispatchScoped({
      orgId: "org-a",
      servicePrincipalId: "brain-worker:org-a",
      model: "a-model",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "hello" }],
    }, { baseUrl: "http://gateway.internal:3748", jwtSecret: secret });
    await modelGateway.dispatchScoped({
      orgId: "org-b",
      servicePrincipalId: "brain-worker:org-b",
      model: "b-model",
      messages: [{ role: "user", content: "hello" }],
    }, { baseUrl: "http://gateway.internal:3748", jwtSecret: secret });

    expect(seen.map((request) => request.url)).toEqual([
      "http://gateway.internal:3748/v1/chat/completions",
      "http://gateway.internal:3748/v1/chat/completions",
    ]);
    for (const [index, orgId] of ["org-a", "org-b"].entries()) {
      const request = seen[index];
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      expect(request.headers.get("x-brainrouter-org")).toBe(orgId);
      expect(verifyJwt(bearer, secret)).toMatchObject({
        type: "service",
        aud: "brainrouter-model-gateway",
        scope: ["models:invoke"],
        orgId,
        servicePrincipalId: `brain-worker:${orgId}`,
      });
      expect(request.body).not.toHaveProperty("apiKey");
      expect(request.body).not.toHaveProperty("endpoint");
      expect(JSON.stringify(request.body)).not.toContain("private:");
    }
    expect(seen[0].body).toMatchObject({ model: "a-model", reasoning_effort: "high" });
    expect(seen[1].body).toMatchObject({ model: "b-model" });
  });
});
