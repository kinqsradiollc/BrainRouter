/**
 * Pure labels + option sets for the composer's session controls (Model / Mode /
 * Effort). The host models "mode" as executionMode + reviewPolicy and effort as a
 * level; this mirrors the desktop's labels so the mobile pills read the same.
 *   - set model:  command  { kind: 'set-model', model, persist }
 *   - set mode/effort:  query 'action:set-session-mode' { executionMode?, reviewPolicy?, effort? }
 *   - read all:  query 'config-snapshot' → { model, prefs: { executionMode, reviewPolicy, effort } }
 */
export type ExecutionMode = 'planning' | 'fast';
export type ReviewPolicy = 'request' | 'proceed';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ModeOption {
  key: 'plan' | 'auto' | 'accept';
  label: string;
  executionMode: ExecutionMode;
  reviewPolicy: ReviewPolicy;
}

/** The three real session modes (executionMode + reviewPolicy), matching the desktop. */
export const MODE_OPTIONS: ModeOption[] = [
  { key: 'plan', label: 'Plan', executionMode: 'planning', reviewPolicy: 'request' },
  { key: 'auto', label: 'Auto', executionMode: 'fast', reviewPolicy: 'proceed' },
  { key: 'accept', label: 'Accept edits', executionMode: 'fast', reviewPolicy: 'request' },
];

export interface EffortOption {
  key: Effort;
  label: string;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'X-High' },
];

/** Composer "Mode" label from the session's executionMode + reviewPolicy. */
export function modeLabel(executionMode?: string, reviewPolicy?: string): string {
  if (executionMode === 'planning' && reviewPolicy === 'request') return 'Plan';
  if (executionMode === 'fast' && reviewPolicy === 'proceed') return 'Auto';
  return 'Accept edits';
}

export interface ModelInfo {
  id: string;
  label: string;
}

/** The host returns `list-models.models` as a STRING[] of ids (local llama.cpp /
 *  LM Studio) OR as {id,label}[] (other providers / the mock). Normalize both to
 *  {id, label} so the picker can render them. */
export function normalizeModels(models?: Array<string | { id: string; label?: string }>): ModelInfo[] {
  return (models ?? []).map((m) =>
    typeof m === 'string' ? { id: m, label: modelLabel(m) } : { id: m.id, label: m.label ?? modelLabel(m.id) },
  );
}

/** Ensure the ACTIVE model is selectable in the picker even when `list-models`
 *  omits it — local servers (llama.cpp / LM Studio / Ollama) serve a single model
 *  and report an empty list, so the current id (e.g. Qwen) would otherwise never
 *  appear. Prepends it (labelled) when missing; otherwise returns the list as-is. */
export function modelOptions(models: ModelInfo[], current?: string): ModelInfo[] {
  if (!current || models.some((m) => m.id === current)) return models;
  return [{ id: current, label: modelLabel(current) }, ...models];
}

/** Short, readable model label: drop a `.gguf` suffix + quant tag; prettify claude ids. */
export function modelLabel(id?: string): string {
  if (!id) return '—';
  const base = id.replace(/\.gguf$/i, '').replace(/-Q\d[\w_]*$/i, '');
  if (!base) return '—';
  if (base.startsWith('claude-')) {
    return base
      .replace(/^claude-/, '')
      .replace(/(\d)-(\d)/g, '$1.$2')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return base;
}
