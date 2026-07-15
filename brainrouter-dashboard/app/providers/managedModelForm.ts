import {
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
} from "@kinqs/brainrouter-types/models";
import type {
  ManagedModelEffortWireMap,
  ManagedModelInput,
} from "../../lib/adminApi";

export const MANAGED_MODEL_EFFORTS = MODEL_REASONING_EFFORTS;
export type EffortWirePreset = "openai-chat" | "openai-responses" | "anthropic-messages";

const PRESET_PATH: Record<EffortWirePreset, string> = {
  "openai-chat": "reasoning_effort",
  "openai-responses": "reasoning.effort",
  "anthropic-messages": "output_config.effort",
};

/** Build an explicit one-to-one wire map; values such as none/max never collapse. */
export function effortWireMap(
  efforts: readonly ModelReasoningEffort[],
  preset: EffortWirePreset,
): ManagedModelEffortWireMap {
  const path = PRESET_PATH[preset];
  return Object.fromEntries(efforts.map((effort) => [effort, { [path]: effort }]));
}

export function managedModelDraftError(input: ManagedModelInput): string | null {
  if (!input.providerConfigId.trim()) return "Choose an upstream provider.";
  if (!input.publicModelId.trim()) return "Enter a public model ID.";
  if (!input.upstreamModelId.trim()) return "Enter an upstream model ID.";
  if (!input.displayName.trim()) return "Enter a display name.";
  const allowed = new Set(input.allowedEfforts);
  if (allowed.size !== input.allowedEfforts.length) return "Reasoning efforts must be unique.";
  if (input.defaultEffort !== null && !allowed.has(input.defaultEffort)) {
    return "The default effort must be one of the enabled efforts.";
  }
  if (!input.capabilities.reasoning && input.allowedEfforts.length > 0) {
    return "Enable reasoning before adding effort controls.";
  }
  for (const effort of input.allowedEfforts) {
    if (!input.effortWireMap[effort] || Object.keys(input.effortWireMap[effort]!).length === 0) {
      return `Choose an upstream mapping for ${effort}.`;
    }
  }
  if (input.capabilitySource === "verified" && (!input.sourceUrl || !input.verifiedAt)) {
    return "Verified capability data needs a source URL and verification time.";
  }
  return null;
}
