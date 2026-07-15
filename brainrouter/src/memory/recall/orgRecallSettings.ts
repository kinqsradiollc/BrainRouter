/**
 * Per-ORG recall-quality settings (dashboard → Intelligence → Advanced).
 *
 * A small, safe subset of the recall pipeline's env knobs, made configurable per
 * organization instead of only via `BRAINROUTER_RECALL_*` env. These are read
 * ONCE per recall, so a per-org override is cheap; every field is OPTIONAL and,
 * when unset, falls back to the env/default value (so a fresh org behaves exactly
 * as before). Stored as a JSON blob in the `system_settings` KV under
 * `recallSettings:${orgId}` (same pattern as `agentModels:${orgId}`).
 *
 * This module is PURE (type + metadata + normalize + map-to-overrides) — no I/O.
 * The engine loads/caches the blob and the admin route validates/persists it.
 */
import type { RecallLimits, RecallSelection } from "./config.js";

/** All fields optional — an unset field uses the env/default at read time. */
export interface RecallSettings {
  ftsLimit?: number;         // Stage-1 keyword pool     [1, 200]
  vecLimit?: number;         // Stage-1 vector pool      [1, 200]
  rerankPool?: number;       // merged RRF pool          [1, 200]
  topResults?: number;       // final size (reranker off)[1, 200]
  diversity?: boolean;       // MMR diversity on the no-reranker path
  diversityLambda?: number;  // relevance↔diversity      [0, 1]
  rerankBlendAlpha?: number; // reranker vs retriever    [0, 1]
  queryRouting?: boolean;    // reflective-query routing around the reranker
}

type FieldKind = "int" | "float" | "bool";

/** Field metadata — drives validation (min/max) AND the dashboard form. */
export interface RecallSettingField {
  key: keyof RecallSettings;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  envDefault: number | boolean;
  help: string;
}

export const RECALL_SETTING_FIELDS: readonly RecallSettingField[] = [
  { key: "ftsLimit", label: "Keyword pool (FTS)", kind: "int", min: 1, max: 200, envDefault: 15, help: "Stage-1 keyword candidate pool." },
  { key: "vecLimit", label: "Vector pool", kind: "int", min: 1, max: 200, envDefault: 15, help: "Stage-1 vector candidate pool." },
  { key: "rerankPool", label: "Reranker pool", kind: "int", min: 1, max: 200, envDefault: 20, help: "Merged RRF pool fed to the reranker." },
  { key: "topResults", label: "Final results", kind: "int", min: 1, max: 200, envDefault: 5, help: "Final result count when the reranker is off." },
  { key: "diversity", label: "MMR diversity", kind: "bool", envDefault: true, help: "Demote near-duplicates on the no-reranker path." },
  { key: "diversityLambda", label: "Diversity λ", kind: "float", min: 0, max: 1, envDefault: 0.7, help: "0 = diversity-only, 1 = relevance-only." },
  { key: "rerankBlendAlpha", label: "Reranker blend α", kind: "float", min: 0, max: 1, envDefault: 1.0, help: "1 = trust the reranker, 0 = trust retriever order." },
  { key: "queryRouting", label: "Reflective-query routing", kind: "bool", envDefault: true, help: "Skip the cross-encoder for reflective/analytical queries." },
] as const;

function clampNumber(v: unknown, min: number, max: number, kind: FieldKind): number | undefined {
  const n = kind === "int" ? Number.parseInt(String(v), 10) : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Validate + clamp an untrusted settings object (from the admin API or the KV
 * store). Unknown keys are dropped; out-of-range numbers are clamped; anything
 * unparseable is OMITTED (so it falls back to env/default). Returns a clean
 * `RecallSettings` with only the fields the caller actually set.
 */
export function normalizeRecallSettings(input: unknown): RecallSettings {
  const src = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const out: RecallSettings = {};
  for (const f of RECALL_SETTING_FIELDS) {
    const raw = src[f.key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (f.kind === "bool") {
      if (typeof raw === "boolean") (out[f.key] as boolean) = raw;
      else if (raw === "true" || raw === "false") (out[f.key] as boolean) = raw === "true";
      continue;
    }
    const n = clampNumber(raw, f.min ?? 0, f.max ?? Number.MAX_SAFE_INTEGER, f.kind);
    if (n !== undefined) (out[f.key] as number) = n;
  }
  return out;
}

/** Recall pipeline override params derived from a (normalized) settings blob. */
export interface RecallOverrides {
  limitsOverride?: Partial<RecallLimits>;
  selectionOverride?: Partial<RecallSelection>;
  rerankBlendAlphaOverride?: number;
  queryRoutingOverride?: boolean;
}

/** Map per-org settings onto the recall pipeline's per-call override params. */
export function recallSettingsToOverrides(s: RecallSettings): RecallOverrides {
  const limits: Partial<RecallLimits> = {};
  if (s.ftsLimit !== undefined) limits.ftsLimit = s.ftsLimit;
  if (s.vecLimit !== undefined) limits.vecLimit = s.vecLimit;
  if (s.rerankPool !== undefined) limits.rerankPool = s.rerankPool;
  if (s.topResults !== undefined) limits.topResults = s.topResults;

  const selection: Partial<RecallSelection> = {};
  if (s.diversity !== undefined) selection.diversity = s.diversity;
  if (s.diversityLambda !== undefined) selection.lambda = s.diversityLambda;

  return {
    ...(Object.keys(limits).length ? { limitsOverride: limits } : {}),
    ...(Object.keys(selection).length ? { selectionOverride: selection } : {}),
    ...(s.rerankBlendAlpha !== undefined ? { rerankBlendAlphaOverride: s.rerankBlendAlpha } : {}),
    ...(s.queryRouting !== undefined ? { queryRoutingOverride: s.queryRouting } : {}),
  };
}
