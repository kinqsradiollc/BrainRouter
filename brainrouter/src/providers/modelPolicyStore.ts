import { createHash } from "node:crypto";
import { systemProviderOrgId } from "./runtime.js";
import {
  MODEL_REASONING_EFFORTS,
  type ManualBudgetTokensSupport,
  type ModelCapabilities,
  type ModelCapabilityProvenanceSource,
  type ModelCatalogEnvelope,
  type ModelPolicy,
  type ModelReasoningEffort,
  type ModelReasoningMode,
} from "@kinqs/brainrouter-types";

export type StoredCapabilitySource = Exclude<ModelCapabilityProvenanceSource, "inferred">;

/** One canonical effort can target multiple upstream request paths. */
export type ModelEffortWireMap = Partial<
  Record<ModelReasoningEffort, Readonly<Record<string, string>>>
>;

export interface StoredModelCapabilities extends ModelCapabilities {
  reasoningMode?: ModelReasoningMode;
  manualBudgetTokens?: ManualBudgetTokensSupport;
}

/** Admin-visible model policy. It contains routing ids, but never credentials/endpoints. */
export interface ProviderModelRecord {
  id: string;
  orgId: string;
  providerConfigId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  allowedEfforts: ModelReasoningEffort[];
  defaultEffort: ModelReasoningEffort | null;
  effortWireMap: ModelEffortWireMap;
  capabilities: StoredModelCapabilities;
  capabilitySource: StoredCapabilitySource;
  sourceUrl?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelInput {
  providerConfigId: string;
  publicModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  allowedEfforts: ModelReasoningEffort[];
  defaultEffort: ModelReasoningEffort | null;
  effortWireMap: ModelEffortWireMap;
  capabilities: StoredModelCapabilities;
  capabilitySource: StoredCapabilitySource;
  sourceUrl?: string;
  verifiedAt?: string;
}

export type ProviderModelPatch = Partial<Omit<ProviderModelInput, "sourceUrl" | "verifiedAt">> & {
  sourceUrl?: string | null;
  verifiedAt?: string | null;
};

export interface ModelPolicyStore {
  listProviderModels(orgId: string, enabledOnly?: boolean): Promise<ProviderModelRecord[]>;
  getProviderModel(orgId: string, id: string): Promise<ProviderModelRecord | null>;
  getProviderModelByPublicId(
    orgId: string,
    publicModelId: string,
    enabledOnly?: boolean,
  ): Promise<ProviderModelRecord | null>;
  createProviderModel(orgId: string, input: ProviderModelInput): Promise<ProviderModelRecord>;
  updateProviderModel(
    orgId: string,
    id: string,
    patch: ProviderModelPatch,
  ): Promise<ProviderModelRecord | null>;
  deleteProviderModel(orgId: string, id: string): Promise<boolean>;
  setDefaultProviderModel(orgId: string, id: string): Promise<boolean>;
  reorderProviderModels(orgId: string, ids: readonly string[]): Promise<void>;
  /** Provision the revocable, org-bound identity used by internal workers. */
  ensureModelGatewayServicePrincipal(orgId: string): Promise<string>;
}

/**
 * Canonical managed-model inheritance — the SINGLE definition of the rule the
 * member catalog (`/api/models/catalog`) and the gateway's
 * `resolveScopedModelSelection` both apply: an org with ZERO enabled models of
 * its own inherits the system/deployment org's enabled models WHOLESALE
 * (all-or-nothing, never a per-model union). Returns which org's models
 * actually apply and whether they were inherited, so admin reads can flag
 * inherited rows read-only instead of showing an empty table on org switch.
 */
export async function resolveEffectiveModelOrg(
  store: Pick<ModelPolicyStore, "listProviderModels">,
  orgId: string,
): Promise<{ effectiveOrgId: string; models: ProviderModelRecord[]; inherited: boolean }> {
  const own = await store.listProviderModels(orgId, true);
  if (own.length > 0) return { effectiveOrgId: orgId, models: own, inherited: false };
  const systemOrg = systemProviderOrgId();
  if (systemOrg && systemOrg !== orgId) {
    const inheritedModels = await store.listProviderModels(systemOrg, true);
    if (inheritedModels.length > 0) return { effectiveOrgId: systemOrg, models: inheritedModels, inherited: true };
  }
  return { effectiveOrgId: orgId, models: [], inherited: false };
}

const EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string"
    && (MODEL_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Validate invariants shared by create and merged-update paths. */
export function modelPolicyInvariantError(input: ProviderModelInput): string | null {
  const allowed = new Set(input.allowedEfforts);
  if (allowed.size !== input.allowedEfforts.length) return "allowedEfforts must not contain duplicates";
  if (input.defaultEffort !== null && !allowed.has(input.defaultEffort)) {
    return "defaultEffort must be one of allowedEfforts";
  }
  if (input.isDefault && !input.enabled) return "The default model must be enabled";
  if (!input.capabilities.reasoning && (allowed.size > 0 || input.defaultEffort !== null)) {
    return "A non-reasoning model cannot declare reasoning efforts";
  }
  const wireEfforts = Object.keys(input.effortWireMap);
  if (wireEfforts.some((effort) => !allowed.has(effort as ModelReasoningEffort))) {
    return "effortWireMap cannot contain efforts outside allowedEfforts";
  }
  for (const effort of input.allowedEfforts) {
    const targets = input.effortWireMap[effort];
    if (!targets || Object.keys(targets).length === 0) {
      return `effortWireMap.${effort} must define at least one upstream field`;
    }
  }
  if (input.capabilitySource === "verified" && (!input.sourceUrl || !input.verifiedAt)) {
    return "Verified model capabilities require sourceUrl and verifiedAt";
  }
  return null;
}

/** Convert an admin record to the deliberately narrow member-safe contract. */
export function toModelPolicy(record: ProviderModelRecord): ModelPolicy {
  const reasoning = record.capabilities.reasoning && record.allowedEfforts.length > 0
    ? {
        default: record.defaultEffort,
        allowed: record.allowedEfforts.map((id) => ({ id, label: EFFORT_LABELS[id] })),
        source: record.capabilitySource,
        mode: record.capabilities.reasoningMode ?? "selectable" as const,
        ...(record.capabilities.manualBudgetTokens
          ? { manualBudgetTokens: record.capabilities.manualBudgetTokens }
          : {}),
      }
    : null;

  return {
    id: record.publicModelId,
    label: record.displayName,
    provider: "brainrouter",
    enabled: record.enabled,
    capabilities: {
      streaming: record.capabilities.streaming,
      tools: record.capabilities.tools,
      responses: record.capabilities.responses,
      reasoning: record.capabilities.reasoning,
      // ADR-027 D4.1 — members need this to decide whether an attachment can be
      // sent. Omitted when the model is unclassified, which reads as `unknown`
      // downstream rather than as "text only": the composer must be able to
      // tell "we know it can't" from "nobody told us".
      ...(record.capabilities.input ? { input: record.capabilities.input } : {}),
    },
    reasoning,
    provenance: {
      source: record.capabilitySource,
      ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
      ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    },
    revision: `model:${record.id}:${record.updatedAt}`,
  };
}

export function toModelCatalog(records: readonly ProviderModelRecord[]): ModelCatalogEnvelope {
  const models = records.filter((record) => record.enabled).map(toModelPolicy);
  const digest = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("hex")
    .slice(0, 24);
  return { revision: `catalog:${digest}`, models };
}
