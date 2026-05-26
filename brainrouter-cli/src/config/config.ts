import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  apiKey?: string;
  /**
   * 0.3.6 item 10a: identity tag for distinguishing the BrainRouter cloud
   * brain ("our MCP") from third-party MCPs the user might attach (GitHub,
   * filesystem, Slack, etc.). Drives status surfaces (banner / statusline /
   * `/where`) and the offline-mode prompt swap: when "the brain" is down
   * the user gets a clear signal, not a generic "MCP offline" message.
   *
   * Detection priority when this field is unset:
   *   1. Server profile name starts with `brainrouter` (case-insensitive).
   *   2. URL hostname matches `*.brainrouter.cloud` or `*.brainrouter.dev`.
   *   3. (Run-time fallback) first successful `listTools()` includes
   *      both `memory_recall` AND `list_skills` — the BrainRouter signature
   *      pair. See `detectMcpIdentity` in `runtime/mcpClient.ts`.
   *
   * Explicit values always win — if the user marks a third-party MCP as
   * `identity: 'brainrouter'`, that's their call (e.g. they're running a
   * local fork that exposes the same tool surface).
   */
  identity?: 'brainrouter' | 'third-party';
}

export interface LLMConfig {
  provider: 'openai';
  apiKey: string;
  model: string;
  endpoint?: string;
}

export interface Config {
  activeServer: string;
  servers: Record<string, ServerConfig>;
  llm?: LLMConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'brainrouter');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Read the existing config.json or exit with a clear error. The CLI owns
 * READS of this file — writes are the user's job (via `brainrouter login`,
 * `brainrouter config`, or direct edit). Auto-fabricating a default config
 * was a holdover from the monorepo dev story; it only ever produced a
 * broken stdio profile pointing at a sibling `brainrouter/` package that
 * doesn't exist outside the monorepo, so npm-installed users got a config
 * file they had to fix anyway.
 *
 * Setup commands (login / config) that need to BUILD a fresh config from
 * scratch should call `loadOrInitConfig` instead — it returns an empty
 * skeleton when no file exists rather than exiting.
 */
export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`No BrainRouter config found at ${CONFIG_FILE}.`);
    console.error(`Run \`brainrouter login\` to connect to a hosted MCP server, or \`brainrouter config\` to set one up.`);
    process.exit(1);
  }
  let parsed: Config;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    parsed = JSON.parse(raw) as Config;
  } catch (error) {
    console.error(`Error: Failed to parse config file at ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Fix the file by hand, or delete it and run \`brainrouter config\` to recreate.`);
    process.exit(1);
  }
  if (!parsed.servers) parsed.servers = {};
  if (!parsed.activeServer) parsed.activeServer = '';

  // The default config writes `llm.apiKey: ''` so it never appears as a
  // secret in the committed file. Backfill from the standard env vars at
  // load time so every downstream consumer (callOpenAI, mcpClient env
  // propagation, the cognitive extractor LLM runner) sees a real value
  // instead of the empty string.
  //
  // 0.3.7 — provider-specific fallback. Pre-0.3.7 we only checked
  // OPENAI_API_KEY / BRAINROUTER_LLM_API_KEY, which silently broke
  // users with config.llm.endpoint pointing at DeepSeek / OpenRouter /
  // Gemini / etc. who had the *correct* provider key in their shell
  // (DEEPSEEK_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, …). Now we
  // match the saved endpoint to a provider entry and try ITS envKey
  // FIRST, then fall through to the generic vars.
  if (parsed.llm && !parsed.llm.apiKey.trim()) {
    parsed.llm.apiKey = backfillApiKeyFromEnv(parsed.llm.endpoint) ?? '';
  }

  return parsed;
}

/**
 * Pick the best API key from the environment for a given endpoint.
 * Order: provider-specific envKey (matched against `PROVIDER_CATALOG`
 * by endpoint), then `OPENAI_API_KEY` (most common default), then the
 * generic `BRAINROUTER_LLM_API_KEY`. Returns undefined if nothing is
 * set so the caller can choose how to surface that.
 *
 * Kept here (vs imported from `cli/wizard/providers.ts`) so non-CLI
 * callers — the MCP child env propagation, future SDK clients — can
 * use it without dragging in the wizard surface.
 */
export function backfillApiKeyFromEnv(endpoint: string | undefined): string | undefined {
  // Provider-specific env vars in order of catalog precedence. Hardcoded
  // here so this function stays free of the wizard import (which pulls
  // in chalk, ink picker types, etc.). Keep in lockstep with
  // `cli/wizard/providers.ts → PROVIDER_CATALOG`.
  const PROVIDER_ENV_BY_ENDPOINT: Array<{ endpoint: string; envKey: string }> = [
    { endpoint: 'https://api.openai.com/v1',                        envKey: 'OPENAI_API_KEY' },
    { endpoint: 'https://api.deepseek.com/v1',                      envKey: 'DEEPSEEK_API_KEY' },
    { endpoint: 'https://openrouter.ai/api/v1',                     envKey: 'OPENROUTER_API_KEY' },
    { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
    { endpoint: 'https://api.anthropic.com/v1',                     envKey: 'ANTHROPIC_API_KEY' },
    { endpoint: 'http://localhost:1234/v1',                         envKey: 'LMSTUDIO_API_KEY' },
    { endpoint: 'http://localhost:11434/v1',                        envKey: 'OLLAMA_API_KEY' },
  ];
  if (endpoint) {
    const trimmed = endpoint.replace(/\/$/, '');
    const match = PROVIDER_ENV_BY_ENDPOINT.find((p) => p.endpoint === trimmed);
    if (match) {
      const value = process.env[match.envKey];
      if (value && value.trim()) return value.trim();
    }
  }
  return process.env.OPENAI_API_KEY?.trim() || process.env.BRAINROUTER_LLM_API_KEY?.trim() || undefined;
}

/**
 * Setup-wizard variant of `loadConfig`. Returns the existing config when
 * one is on disk, or an empty skeleton when none exists yet. Used by
 * `brainrouter login` and `brainrouter config` so a first-run user can
 * BUILD their config interactively without hitting the strict
 * "no config — run setup" error from `loadConfig`.
 */
export function loadOrInitConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { activeServer: '', servers: {} };
  }
  return loadConfig();
}

export function saveConfig(config: Config): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error: Failed to save config to ${CONFIG_FILE}:`, error instanceof Error ? error.message : error);
  }
}



