import assert from "node:assert/strict";
import test from "node:test";
import type { ModelPolicy } from "@kinqs/brainrouter-types";
import { normalizeChatModelSelection } from "./chatModelSelection";

function policy(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    id: "model-one",
    label: "Model one",
    provider: "brainrouter",
    enabled: true,
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    reasoning: {
      default: "medium",
      allowed: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      source: "verified",
      mode: "selectable",
    },
    provenance: { source: "verified" },
    revision: "model:one",
    ...overrides,
  };
}

test("chat model selection rejects stale model and effort ids", () => {
  const selected = normalizeChatModelSelection(
    [policy(), policy({ id: "disabled", enabled: false })],
    { model: "disabled", reasoningEffort: "max" },
  );
  assert.deepEqual(selected, { model: "model-one", reasoningEffort: "medium" });
});

test("chat model selection preserves exact supported effort vocabulary", () => {
  assert.deepEqual(
    normalizeChatModelSelection([policy()], { model: "model-one", reasoningEffort: "high" }),
    { model: "model-one", reasoningEffort: "high" },
  );
});

test("adaptive and non-reasoning models do not send a made-up effort", () => {
  assert.equal(normalizeChatModelSelection([
    policy({ reasoning: { ...policy().reasoning!, mode: "adaptive" } }),
  ], { reasoningEffort: "high" }).reasoningEffort, "");
  assert.equal(normalizeChatModelSelection([
    policy({ reasoning: null, capabilities: { streaming: true, tools: true, responses: true, reasoning: false } }),
  ], { reasoningEffort: "high" }).reasoningEffort, "");
});

