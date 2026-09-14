/**
 * ADR-045 M3 — per-ORG context-window cap (dashboard → Providers → Advanced).
 *
 * BrainRouter, acting as a PROVIDER to its members, can cap the context window
 * it advertises for every model in an org — the server-side half of "a context
 * window you can size": the CLI knob (`cli.contextWindows`) is the user sizing
 * their own backend; this is the org sizing what its members are allowed to use.
 *
 * Stored as a JSON blob in the `system_settings` KV under
 * `contextSettings:${orgId}` — the same pattern as `recallSettings:${orgId}` and
 * `agentModels:${orgId}`. Every field is OPTIONAL; unset means "no cap", and the
 * gateway advertises each model's own window (byte-neutral for an org that never
 * sets one). This module is PURE (type + metadata + normalize + resolve) — no
 * I/O; the admin route persists the blob and the gateway reads it.
 *
 * The cap only ever TIGHTENS. It is advertised through the gateway's
 * `/v1/models` response as the standard OpenAI `context_window` field, so a
 * well-behaved client sizes its budget to the org ceiling. It never RAISES a
 * window above a model's real maximum — a cap larger than a model's context is a
 * ceiling the model never reaches, not a promise the model cannot keep.
 */

/** All fields optional — an unset field means "no org cap" for that dimension. */
export interface ContextCapSettings {
  /** Ceiling in tokens on the context window advertised for every model in this org. */
  maxContextTokens?: number;
}

type FieldKind = "int";

/** Field metadata — drives validation (min/max) AND the dashboard form. */
export interface ContextSettingField {
  key: keyof ContextCapSettings;
  label: string;
  kind: FieldKind;
  min: number;
  max: number;
  help: string;
}

export const CONTEXT_SETTING_FIELDS: readonly ContextSettingField[] = [
  {
    key: "maxContextTokens",
    label: "Max context window (tokens)",
    kind: "int",
    min: 1_000,
    max: 10_000_000,
    help: "Cap the context window advertised to members for every model in this org. Unset = each model's own window is used.",
  },
] as const;

function clampInt(v: unknown, min: number, max: number): number | undefined {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Validate + clamp an untrusted settings object (from the admin API or the KV
 * store). Unknown keys are dropped; out-of-range numbers are clamped; anything
 * unparseable is OMITTED (so it reads as "no cap"). Returns a clean
 * `ContextCapSettings` with only the fields the caller actually set.
 */
export function normalizeContextSettings(input: unknown): ContextCapSettings {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: ContextCapSettings = {};
  for (const f of CONTEXT_SETTING_FIELDS) {
    const raw = src[f.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = clampInt(raw, f.min, f.max);
    if (n !== undefined) out[f.key] = n;
  }
  return out;
}

/** The org's context cap in tokens, or `undefined` when the org set none. */
export function resolveContextCapTokens(settings: ContextCapSettings | null | undefined): number | undefined {
  const cap = settings?.maxContextTokens;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined;
}

/**
 * The context window to advertise for one model, given the org cap.
 *
 * A cap only tightens: with a known model window it advertises `min(window,
 * cap)`; with no known window (managed models carry none today) it advertises
 * the cap itself as the org ceiling. With no cap it advertises the model's own
 * window (which is `undefined` for a managed model — the client falls back to
 * its own resolution, exactly as before this feature).
 */
export function advertisedContextWindow(
  modelWindowTokens: number | undefined,
  capTokens: number | undefined,
): number | undefined {
  if (capTokens === undefined) return modelWindowTokens;
  if (modelWindowTokens === undefined) return capTokens;
  return Math.min(modelWindowTokens, capTokens);
}
