/**
 * 0.3.7 wizard — curated provider catalogue.
 *
 * One source of truth for "which LLM providers do we present in the
 * onboarding picker?" — keeps the wizard step and the `/config` provider
 * picker in sync. Each entry carries the canonical endpoint, the env-var
 * name the user is most likely to have set (so we can pre-detect), a
 * short hint line for the picker, and a curated model short-list.
 *
 * Lineage:
 *   - The "env-var-name as a hint" pattern is borrowed from
 *     `openSrc/codex/codex-rs/tui/src/onboarding/auth.rs`
 *     (`ApiKeyInputState.prepopulated_from_env`).
 *   - The "configured / needs-key / optional-key" row tag is from
 *     `openSrc/DeepSeek-TUI/crates/tui/src/tui/provider_picker.rs`.
 *
 * Adding a provider here makes it appear in the wizard AND the
 * `/config` panel — no other registration needed.
 */

export interface ProviderEntry {
  /** Stable id used in config.json + tests. */
  id: string;
  /** Human-readable picker label. */
  label: string;
  /** One-line picker hint shown after the em-dash. */
  hint: string;
  /** OpenAI-compatible /v1/chat/completions endpoint. */
  endpoint: string;
  /** Env var the wizard checks to pre-detect a usable key. */
  envKey: string;
  /** True when the provider runs locally and a blank API key is fine. */
  local: boolean;
  /** Curated short-list of model names for the picker (plus "Other"). */
  models: string[];
  /** Default model selected by the wizard when none was previously set. */
  defaultModel: string;
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'cloud · gpt-4o / gpt-5 / o-series',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    local: false,
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-5', 'o3-mini', 'gpt-5-mini'],
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'cloud · deepseek-chat / deepseek-reasoner',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    local: false,
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-r1'],
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'cloud gateway · any vendor through one key',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
    local: false,
    models: [
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat',
      'qwen/qwen3-coder',
    ],
    defaultModel: 'anthropic/claude-sonnet-4',
  },
  {
    id: 'anthropic-via-gateway',
    label: 'Anthropic (via OpenRouter)',
    hint: 'cloud · claude-* models through OpenRouter (no native /v1/chat/completions)',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
    local: false,
    models: [
      'anthropic/claude-sonnet-4',
      'anthropic/claude-opus-4',
      'anthropic/claude-haiku-4',
    ],
    defaultModel: 'anthropic/claude-sonnet-4',
  },
  {
    id: 'gemini',
    label: 'Gemini (OpenAI-compat)',
    hint: 'cloud · Google\'s OpenAI-compat endpoint',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    envKey: 'GEMINI_API_KEY',
    local: false,
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    hint: 'local · http://localhost:1234 · blank API key OK',
    endpoint: 'http://localhost:1234/v1/chat/completions',
    envKey: 'LMSTUDIO_API_KEY',
    local: true,
    models: ['qwen2.5-coder', 'gpt-oss-20b', 'deepseek-r1-distill-qwen-32b'],
    defaultModel: 'qwen2.5-coder',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    hint: 'local · http://localhost:11434 · blank API key OK',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    envKey: 'OLLAMA_API_KEY',
    local: true,
    models: ['qwen2.5-coder:7b', 'llama3.1:8b', 'deepseek-r1:14b'],
    defaultModel: 'qwen2.5-coder:7b',
  },
];

/**
 * Look up a provider entry by stable id. Returns undefined when the id
 * isn't in the catalog — caller decides whether that's an error
 * (`/config` reject) or a fallback (custom-endpoint flow).
 */
export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * Pre-detect which providers already have a usable key in the shell
 * environment. Used by the wizard's Provider step to pre-select the
 * row most likely to "just work". Returns the FIRST hit so first-time
 * users with multiple keys set don't get a random pick — order in
 * PROVIDER_CATALOG is the precedence.
 */
export function detectProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEntry | undefined {
  for (const provider of PROVIDER_CATALOG) {
    const value = env[provider.envKey];
    if (value && value.trim().length > 0) return provider;
  }
  return undefined;
}

/**
 * 0.3.7 wizard API-key validation tier.
 *
 * `Accept` — the key is plausibly fine; persist it as-is.
 *   - `warning` carries a non-blocking hint (e.g. "unusual prefix —
 *     check your provider's dashboard if calls fail").
 * `Reject` — the input is structurally invalid; refuse to persist and
 *   ask the user to re-enter.
 *
 * Pattern lifted from
 * `openSrc/DeepSeek-TUI/crates/tui/src/tui/onboarding/mod.rs:172`
 * (`enum ApiKeyValidation { Accept{warning}, Reject(String) }`). The
 * idea is to warn-not-block on unrecognised key shapes because every
 * vendor invents new prefixes (`sk-`, `sk-or-v1-`, `dsk-`, `pk-`, …)
 * and rejecting on shape alone locks users out of legitimate setups.
 */
export type ApiKeyValidation =
  | { kind: 'accept'; warning?: string }
  | { kind: 'reject'; reason: string };

const KNOWN_PREFIXES = [
  'sk-',          // OpenAI
  'sk-or-v1-',    // OpenRouter
  'sk-proj-',     // OpenAI scoped
  'dsk-',         // DeepSeek
  'sk-ant-',      // Anthropic
];

export function validateApiKey(
  raw: string,
  provider: ProviderEntry,
): ApiKeyValidation {
  const key = raw.trim();
  // Local endpoints (LM Studio, Ollama, custom) accept blank keys —
  // they often want a literal "lm-studio" / "ollama" / "local" string
  // because the server checks for non-empty Bearer presence.
  if (provider.local) {
    return { kind: 'accept' };
  }
  if (key.length === 0) {
    return { kind: 'reject', reason: 'API key is required for cloud providers.' };
  }
  // Suspiciously short for a real provider key — almost always a paste
  // error (the user copied a tag, not the full secret).
  if (key.length < 16) {
    return { kind: 'reject', reason: `Key is ${key.length} characters — that looks like a paste error (real provider keys are 32+ chars).` };
  }
  const hasKnownPrefix = KNOWN_PREFIXES.some((p) => key.startsWith(p));
  if (!hasKnownPrefix) {
    return {
      kind: 'accept',
      warning: `Unfamiliar key prefix (expected one of ${KNOWN_PREFIXES.slice(0, 3).join(', ')}…). Saved as-is — if calls fail, double-check the value from your provider's dashboard.`,
    };
  }
  return { kind: 'accept' };
}

/**
 * Last-four masking for API keys. Visible everywhere the key is
 * displayed (Done step summary, `/config` panel, `/where` workspace
 * block). Always keeps a fixed-width tail so two keys with different
 * lengths align in the panel.
 *
 * Borrowed from `openSrc/DeepSeek-TUI/crates/tui/src/tui/onboarding/api_key.rs:77`
 * (`mask_key()`).
 */
export function maskApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length === 0) return '(none)';
  if (key.length <= 4) return '·'.repeat(key.length);
  return '·'.repeat(8) + key.slice(-4);
}
