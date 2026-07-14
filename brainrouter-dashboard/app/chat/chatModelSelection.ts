import type { ModelPolicy, ModelReasoningEffort } from "@kinqs/brainrouter-types";

export interface ChatModelSelection {
  model: string;
  reasoningEffort: ModelReasoningEffort | "";
}

export function normalizeChatModelSelection(
  models: readonly ModelPolicy[],
  requested: Partial<ChatModelSelection>,
): ChatModelSelection {
  const enabled = models.filter((model) => model.enabled);
  const model = enabled.find((item) => item.id === requested.model) ?? enabled[0];
  if (!model) return { model: "", reasoningEffort: "" };
  const allowed = model.reasoning?.mode === "selectable" ? model.reasoning.allowed : [];
  const requestedEffort = requested.reasoningEffort;
  const reasoningEffort = requestedEffort && allowed.some((item) => item.id === requestedEffort)
    ? requestedEffort
    : model.reasoning?.default && allowed.some((item) => item.id === model.reasoning?.default)
      ? model.reasoning.default
      : "";
  return { model: model.id, reasoningEffort };
}

