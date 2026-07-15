import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../memory/store/postgres/queries/executor.js";
import {
  deleteProviderModel,
  getProviderModel,
  getProviderModelByPublicId,
  reorderProviderModels,
} from "../memory/store/postgres/queries/modelPolicyQueries.js";
import {
  modelPolicyInvariantError,
  toModelCatalog,
  type ProviderModelInput,
  type ProviderModelRecord,
} from "./modelPolicyStore.js";

const timestamp = "2026-07-14T01:02:03.000Z";

function input(overrides: Partial<ProviderModelInput> = {}): ProviderModelInput {
  return {
    providerConfigId: "provider-a",
    publicModelId: "gpt-5.6-sol",
    upstreamModelId: "upstream-secret-name",
    displayName: "GPT-5.6 Sol",
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    allowedEfforts: ["none", "high"],
    defaultEffort: "high",
    effortWireMap: {
      none: { "reasoning.effort": "none" },
      high: { "reasoning.effort": "high" },
    },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "verified",
    sourceUrl: "https://provider.example/models",
    verifiedAt: timestamp,
    ...overrides,
  };
}

function record(overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord {
  return {
    id: "model-a",
    orgId: "org-a",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input(),
    ...overrides,
  };
}

describe("model policy contracts", () => {
  it("builds a stable member catalog without upstream custody fields", () => {
    const catalog = toModelCatalog([record()]);

    expect(catalog).toMatchObject({
      revision: expect.stringMatching(/^catalog:/),
      models: [{
        id: "gpt-5.6-sol",
        provider: "brainrouter",
        reasoning: { default: "high", allowed: [{ id: "none" }, { id: "high" }] },
      }],
    });
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("provider-a");
    expect(serialized).not.toContain("upstream-secret-name");
    expect(serialized).not.toContain("providerConfigId");
    expect(toModelCatalog([record()])).toEqual(catalog);
    expect(toModelCatalog([record({ updatedAt: "2026-07-14T01:02:04.000Z" })]).revision)
      .not.toBe(catalog.revision);
  });

  it("rejects defaults and wire mappings outside the exact effort allowlist", () => {
    expect(modelPolicyInvariantError(input({ defaultEffort: "max" })))
      .toBe("defaultEffort must be one of allowedEfforts");
    expect(modelPolicyInvariantError(input({ effortWireMap: { none: { field: "none" } } })))
      .toBe("effortWireMap.high must define at least one upstream field");
    expect(modelPolicyInvariantError(input({
      allowedEfforts: [],
      defaultEffort: null,
      effortWireMap: {},
      capabilities: { streaming: true, tools: true, responses: true, reasoning: false },
    }))).toBeNull();
  });
});

describe("model policy SQL organization scoping", () => {
  it("scopes id and public-id reads to the organization", async () => {
    const one = vi.fn().mockResolvedValue(null);
    const exec = { one } as unknown as Executor;

    await getProviderModel(exec, "org-a", "model-a");
    await getProviderModelByPublicId(exec, "org-a", "public-a", true);

    expect(one.mock.calls[0][0]).toContain("id = $1 AND org_id = $2");
    expect(one.mock.calls[0][1]).toEqual(["model-a", "org-a"]);
    expect(one.mock.calls[1][0]).toContain("org_id = $1 AND public_model_id = $2 AND enabled");
    expect(one.mock.calls[1][1]).toEqual(["org-a", "public-a"]);
  });

  it("scopes deletes to both model id and organization id", async () => {
    const run = vi.fn().mockResolvedValue(0);
    const exec = { run } as unknown as Executor;

    await expect(deleteProviderModel(exec, "org-a", "model-a")).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith(
      "DELETE FROM provider_models WHERE id = $1 AND org_id = $2 AND NOT is_default",
      ["model-a", "org-a"],
    );
  });

  it("rejects an incomplete or cross-org reorder before opening a transaction", async () => {
    const tx = vi.fn();
    const exec = {
      rows: vi.fn().mockResolvedValue([{ id: "model-a" }, { id: "model-b" }]),
      tx,
    } as unknown as Executor;

    await expect(reorderProviderModels(exec, "org-a", ["model-a", "foreign-model"]))
      .rejects.toThrow("every organization model exactly once");
    expect(tx).not.toHaveBeenCalled();
  });
});
