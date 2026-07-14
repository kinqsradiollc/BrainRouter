import type { ModelReasoningEffort } from "@kinqs/brainrouter-types";

import {
  isModelReasoningEffort,
  type ProviderModelRecord,
} from "../../providers/modelPolicyStore.js";
import type { ResolvedProviderConfig } from "../../providers/types.js";
import type { GatewayAuthContext } from "./auth.js";

/** Persistence boundary used by the gateway policy resolver. */
export interface GatewayModelPolicyStore {
  getProviderModelByPublicId(
    orgId: string,
    publicModelId: string,
    enabledOnly?: boolean,
  ): Promise<ProviderModelRecord | null>;
  getResolvedProvider(id: string): Promise<ResolvedProviderConfig | null>;
}

/** Internal-only resolution. The provider may contain a decrypted credential. */
export interface GatewayResolvedModel {
  auth: GatewayAuthContext;
  model: ProviderModelRecord;
  provider: ResolvedProviderConfig;
  selectedEffort: ModelReasoningEffort | null;
}

export class GatewayModelPolicyError extends Error {
  constructor(
    public readonly status: 400 | 404 | 503,
    public readonly code:
      | "model_not_found"
      | "model_disabled"
      | "invalid_reasoning_effort"
      | "provider_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GatewayModelPolicyError";
  }
}

function requestedEffort(value: unknown): ModelReasoningEffort | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isModelReasoningEffort(value)) {
    throw new GatewayModelPolicyError(
      400,
      "invalid_reasoning_effort",
      "The requested reasoning effort is not supported by BrainRouter.",
    );
  }
  return value;
}

/**
 * Resolve one public model inside the authenticated tenant and validate its
 * exact effort policy before decrypting provider custody. This value must stay
 * inside the gateway process and must never be serialized by an HTTP route.
 */
export async function resolveGatewayModel(input: {
  auth: GatewayAuthContext;
  publicModelId: string;
  reasoningEffort?: unknown;
  store: GatewayModelPolicyStore;
}): Promise<GatewayResolvedModel> {
  const publicModelId = input.publicModelId.trim();
  if (!publicModelId) {
    throw new GatewayModelPolicyError(404, "model_not_found", "The requested model does not exist.");
  }

  // Deliberately load the tenant-scoped policy before touching provider
  // custody so unknown/cross-tenant/disabled requests never decrypt a secret.
  const model = await input.store.getProviderModelByPublicId(
    input.auth.orgId,
    publicModelId,
    false,
  );
  if (!model) {
    throw new GatewayModelPolicyError(404, "model_not_found", "The requested model does not exist.");
  }
  if (!model.enabled) {
    throw new GatewayModelPolicyError(404, "model_disabled", "The requested model is disabled.");
  }

  const explicitEffort = requestedEffort(input.reasoningEffort);
  const selectedEffort = explicitEffort === undefined ? model.defaultEffort : explicitEffort;
  if (selectedEffort !== null) {
    if (
      !model.capabilities.reasoning
      || !model.allowedEfforts.includes(selectedEffort)
      || !model.effortWireMap[selectedEffort]
      || Object.keys(model.effortWireMap[selectedEffort] ?? {}).length === 0
    ) {
      throw new GatewayModelPolicyError(
        400,
        "invalid_reasoning_effort",
        `Reasoning effort ${selectedEffort} is not enabled for ${model.publicModelId}.`,
      );
    }
  }

  const provider = await input.store.getResolvedProvider(model.providerConfigId);
  if (!provider || provider.kind !== "llm" || !provider.endpoint.trim()) {
    throw new GatewayModelPolicyError(
      503,
      "provider_unavailable",
      "The model provider is not available.",
    );
  }

  return { auth: input.auth, model, provider, selectedEffort };
}
