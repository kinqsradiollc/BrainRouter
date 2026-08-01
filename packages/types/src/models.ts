/** Canonical reasoning efforts accepted by BrainRouter API contracts. */
export const MODEL_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export type ModelCapabilityProvenanceSource =
  | 'verified'
  | 'discovered'
  | 'manual'
  | 'inferred';

/** Audit metadata for model capabilities. No provider credentials belong here. */
export interface ModelCapabilityProvenance {
  source: ModelCapabilityProvenanceSource;
  sourceUrl?: string;
  verifiedAt?: string;
}

/**
 * ADR-027 D4.1 — non-text inputs a model can accept on the wire.
 *
 * A SET rather than a `vision: boolean`, because native document input raises
 * exactly the same question and would otherwise force a breaking change one
 * release later: some providers accept a PDF directly, which lets us skip
 * extraction entirely for those models.
 */
export const MODEL_INPUT_MODALITIES = ['image', 'pdf', 'audio'] as const;

export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/**
 * What non-text input a model accepts.
 *
 * `unknown` is deliberately DISTINCT from "accepts nothing". A BYOK model whose
 * operator never annotated it is unknown, not text-only — silently disabling
 * image input on a perfectly capable model is its own bug. Callers must decide
 * what to do about uncertainty rather than having it decided for them.
 */
export type ModelInputModalitySupport =
  | { status: 'unknown' }
  | { status: 'known'; accepts: readonly ModelInputModality[] };

/** Whether a specific input may be sent to a model. */
export type ModalityVerdict = 'accepted' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  responses: boolean;
  reasoning: boolean;
  /**
   * ADR-027 D4.1. Optional so existing catalog records stay valid; an absent
   * value reads as `unknown`, never as "text only" — see
   * {@link modelAcceptsModality}.
   */
  input?: ModelInputModalitySupport;
}

/**
 * The single place that answers "can I send this to that model?".
 *
 * Every surface — composer, router, agent tools — must go through here rather
 * than reading the field directly, so the unknown-vs-unsupported distinction
 * cannot be flattened by accident at one call site.
 */
export function modelAcceptsModality(
  capabilities: Pick<ModelCapabilities, 'input'> | null | undefined,
  modality: ModelInputModality,
): ModalityVerdict {
  const input = capabilities?.input;
  if (!input || input.status === 'unknown') return 'unknown';
  return input.accepts.includes(modality) ? 'accepted' : 'unsupported';
}

/** Narrow an unknown value to a {@link ModelInputModality}. */
export function isModelInputModality(value: unknown): value is ModelInputModality {
  return typeof value === 'string'
    && (MODEL_INPUT_MODALITIES as readonly string[]).includes(value);
}

/**
 * Parse a stored/wire capability blob into {@link ModelInputModalitySupport}.
 *
 * Anything malformed degrades to `unknown` rather than to an empty accept-list:
 * a parse failure is an absence of information, and treating it as "supports
 * nothing" would silently disable a capable model.
 */
export function parseModelInputModalities(value: unknown): ModelInputModalitySupport {
  if (!value || typeof value !== 'object') return { status: 'unknown' };
  const raw = (value as { accepts?: unknown }).accepts;
  if (!Array.isArray(raw)) return { status: 'unknown' };
  const accepts = raw.filter(isModelInputModality);
  // An explicitly empty list is meaningful — "we checked, it takes text only".
  return { status: 'known', accepts: [...new Set(accepts)] };
}

export interface ModelReasoningEffortOption {
  id: ModelReasoningEffort;
  label: string;
}

export type ModelReasoningMode = 'selectable' | 'adaptive';
export type ManualBudgetTokensSupport = 'supported' | 'unsupported';

export interface ModelReasoningPolicy {
  /** `null` delegates the default to the upstream provider. */
  default: ModelReasoningEffort | null;
  allowed: readonly ModelReasoningEffortOption[];
  source: ModelCapabilityProvenanceSource;
  mode: ModelReasoningMode;
  manualBudgetTokens?: ManualBudgetTokensSupport;
}

/** Member-safe policy returned for a server-managed BrainRouter model. */
export interface ModelPolicy {
  id: string;
  label: string;
  provider: 'brainrouter';
  enabled: boolean;
  capabilities: ModelCapabilities;
  reasoning: ModelReasoningPolicy | null;
  provenance: ModelCapabilityProvenance;
  revision: string;
}

/** Revisioned response body for the authenticated member model catalog. */
export interface ModelCatalogEnvelope {
  revision: string;
  models: readonly ModelPolicy[];
  /** True when these models are the deployment default inherited by an org that
   *  has none of its own (the org's own set is empty). Optional/additive. */
  inherited?: boolean;
}

export interface UnknownCustomModelCapabilityProfile {
  status: 'unknown';
}

export interface InferredCustomModelReasoningProfile {
  default?: ModelReasoningEffort | null;
  allowed: readonly ModelReasoningEffort[];
}

/**
 * Optional hints for a custom/BYOK model. These hints never mutate or broaden
 * the server-managed model policy returned in a ModelCatalogEnvelope.
 */
export interface InferredCustomModelCapabilityProfile {
  status: 'inferred';
  provenance: ModelCapabilityProvenance & { source: 'inferred' };
  capabilities: Partial<ModelCapabilities>;
  reasoning?: InferredCustomModelReasoningProfile;
}

export type CustomModelCapabilityProfile =
  | UnknownCustomModelCapabilityProfile
  | InferredCustomModelCapabilityProfile;

const VERIFIED_AT = '2026-07-14';
const SEED_REVISION = `seed:${VERIFIED_AT}`;

const EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function effortOptions(
  efforts: readonly ModelReasoningEffort[],
): readonly ModelReasoningEffortOption[] {
  return efforts.map((id) => ({ id, label: EFFORT_LABELS[id] }));
}

const OPENAI_56_EFFORT_OPTIONS = effortOptions([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const FABLE_5_EFFORT_OPTIONS = effortOptions([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const HOSTED_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  responses: true,
  reasoning: true,
};

function openAi56Policy(id: string, label: string): ModelPolicy {
  return {
    id,
    label,
    provider: 'brainrouter',
    enabled: true,
    capabilities: { ...HOSTED_CAPABILITIES },
    reasoning: {
      default: null,
      allowed: OPENAI_56_EFFORT_OPTIONS,
      source: 'verified',
      mode: 'selectable',
    },
    provenance: {
      source: 'verified',
      sourceUrl: 'https://developers.openai.com/api/docs/models',
      verifiedAt: VERIFIED_AT,
    },
    revision: SEED_REVISION,
  };
}

/** Verified seed policies; organization policy may clone and narrow these. */
export const HOSTED_MODEL_POLICY_FIXTURES: readonly ModelPolicy[] = [
  openAi56Policy('gpt-5.6-sol', 'GPT-5.6 Sol'),
  openAi56Policy('gpt-5.6-terra', 'GPT-5.6 Terra'),
  openAi56Policy('gpt-5.6-luna', 'GPT-5.6 Luna'),
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'brainrouter',
    enabled: true,
    capabilities: { ...HOSTED_CAPABILITIES },
    reasoning: {
      default: 'high',
      allowed: FABLE_5_EFFORT_OPTIONS,
      source: 'verified',
      mode: 'adaptive',
      manualBudgetTokens: 'unsupported',
    },
    provenance: {
      source: 'verified',
      sourceUrl: 'https://platform.claude.com/docs/en/build-with-claude/effort',
      verifiedAt: VERIFIED_AT,
    },
    revision: SEED_REVISION,
  },
];
