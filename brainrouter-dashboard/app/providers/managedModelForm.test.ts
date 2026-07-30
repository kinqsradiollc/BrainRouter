import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedModelInput } from "../../lib/adminApi";
import {
  MANAGED_MODEL_EFFORTS,
  effortWireMap,
  managedModelDraftError,
} from "./managedModelForm";

function input(overrides: Partial<ManagedModelInput> = {}): ManagedModelInput {
  return {
    providerConfigId: "provider-1",
    publicModelId: "gpt-5.6-sol",
    upstreamModelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    enabled: true,
    isDefault: false,
    sortOrder: 0,
    allowedEfforts: ["none", "max"],
    defaultEffort: "none",
    effortWireMap: effortWireMap(["none", "max"], "openai-responses"),
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "manual",
    ...overrides,
  };
}

test("managed effort options come from the shared contract and exclude ultracode", () => {
  assert.deepEqual(MANAGED_MODEL_EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal((MANAGED_MODEL_EFFORTS as readonly string[]).includes("ultracode"), false);
});

test("wire presets preserve none and max exactly", () => {
  assert.deepEqual(effortWireMap(["none", "max"], "openai-chat"), {
    none: { reasoning_effort: "none" },
    max: { reasoning_effort: "max" },
  });
  assert.deepEqual(effortWireMap(["high"], "anthropic-messages"), {
    high: { "output_config.effort": "high" },
  });
});

test("draft validation requires exact default and verified provenance", () => {
  assert.equal(managedModelDraftError(input()), null);
  assert.equal(
    managedModelDraftError(input({ defaultEffort: "high" })),
    "The default effort must be one of the enabled efforts.",
  );
  assert.equal(
    managedModelDraftError(input({ capabilitySource: "verified" })),
    "Verified capability data needs a source URL and verification time.",
  );
});
