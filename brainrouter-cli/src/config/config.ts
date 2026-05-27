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
  // 0.3.9: the only supported dispatch is OpenAI-compatible
  // `/v1/chat/completions`. The Anthropic native `/v1/messages`
  // adapter (added in 0.3.8-I6) was removed in 0.3.9 — Claude
  // models can still be reached via an OpenAI-compatible gateway
  // (OpenRouter / Together / Fireworks) by pointing `endpoint` at
  // the gateway base URL. `provider` is the catalog id (openai,
  // lmstudio, ollama, deepseek, …) and is used as a label for
  // tier-ladder lookups; the wire format is always OpenAI-compatible.
  provider: string;
  apiKey: string;
  model: string;
  endpoint?: string;
}

/**
 * CLI behaviour knobs. All previously-env-only flags live here so
 * `~/.config/brainrouter/config.json` is the single source of CLI
 * truth — no more `.env` file to chase. Every field is optional;
 * `resolveCliKnobs()` fills in the documented defaults.
 *
 * (Previously: brainrouter-cli/.env.example carried these. That file
 *  was deleted in 0.3.9 to consolidate config in one place.)
 */
/**
 * Single source of truth for CLI behaviour knobs. Edit
 * `~/.config/brainrouter/config.json` under a top-level `cli:` block to
 * adjust any of these. As of 0.3.9 nothing is read from .env — all
 * BRAINROUTER_* env vars were migrated into this struct.
 *
 * (The only env vars the CLI still consults are standard ecosystem
 * credential vars like `OPENAI_API_KEY` for wizard pre-detection;
 * those are documented at their callsites.)
 */
export interface CliKnobs {
  // ---- memory / briefing -------------------------------------------------
  /** Default 'gated'. Recall trigger mode — see briefingTriggers.ts. */
  recallMode?: 'always' | 'gated' | 'off';
  /** Default 'on'. Pin first-turn briefing into the cache-stable prefix. */
  prefixMemoryAnchors?: 'on' | 'off';
  /** Cap on briefing chars per source. Default 4000. */
  briefingMaxCharsPerSource?: number;
  /** Cap on parallel briefing sources. Default 6. */
  briefingMaxSources?: number;

  // ---- compaction + shrink ----------------------------------------------
  /** Cap on chat-history tokens before auto-compact fires. Default 80000. */
  autoCompactTokens?: number;
  /** Cap on tokens kept in a single tool-result message at turn-end. Default 3000. */
  turnEndResultCapTokens?: number;
  /** Proactive shrink ratio (mid-iter trigger). Default 0.4. */
  turnEndShrinkRatio?: number;
  /** Cap on bytes a child agent's transcript can push into the parent system prompt. Default 12000. */
  childResultSystemChars?: number;
  /** Cap on bytes any tool result can contribute to the model-visible context. Default 8000. */
  maxToolResultChars?: number;

  // ---- tool-call repair pipeline ----------------------------------------
  /** Sliding window for the storm-breaker. Default 6. */
  stormWindow?: number;
  /** Storm threshold — Nth identical call inside the window is suppressed. Default 4. */
  stormThreshold?: number;
  /** Hard cap on inner-loop iterations per user turn. Default 60. */
  maxToolLoops?: number;
  /** Threshold for the repeat-sequence guard. Default 8. */
  repeatToolSequenceLimit?: number;
  /** Default true. Set false to force-serialize every tool dispatch. */
  parallelSafeToolCalls?: boolean;

  // ---- Ink rendering -----------------------------------------------------
  /** Alt-screen mode — keeps native scrollback when false. Default false. */
  altScreen?: boolean;
  /** Hide the OS cursor while Ink renders. Default true. */
  hideCursor?: boolean;
  /** Quiet status row + skip idle-hint chrome. Default false. */
  quiet?: boolean;
  /** Theme override ('light' / 'dark' / 'auto'). Default 'auto'. */
  theme?: 'light' | 'dark' | 'auto';

  // ---- LLM call ergonomics ----------------------------------------------
  /** Per-call LLM timeout in ms. Default 120000. */
  llmTimeoutMs?: number;
  /** Max concurrent LLM calls across parent + children. Default 4. */
  llmMaxConcurrent?: number;
  /** Disable streaming (SSE). Default false. */
  disableStream?: boolean;
  /** Reasoning depth preference override (`/effort`). Default 'medium'. */
  effort?: 'low' | 'medium' | 'high';

  // ---- MCP plumbing -----------------------------------------------------
  /** MCP call timeout in ms. Default 60000. */
  mcpTimeoutMs?: number;

  // ---- approval / sandbox / spawn --------------------------------------
  /** Sandbox engine. Default 'off'. */
  sandbox?: 'off' | 'on';
  /** Extra read-only paths granted to sandboxed run_command. */
  sandboxReadPaths?: string[];
  /** Extra write-allowed paths granted to sandboxed run_command. */
  sandboxWritePaths?: string[];
  /** Allow outbound network from the sandbox. Default false. */
  sandboxNetwork?: boolean;
  /** Child-drain timeout in ms. Default 30000. */
  childDrainTimeoutMs?: number;
  /** Maximum spawn depth. Default 3. */
  maxSpawnDepth?: number;

  // ---- scheduling / tracing / search -----------------------------------
  /** Background ticker interval for /schedule jobs in ms. Default 30000. */
  scheduleTickMs?: number;
  /** Path to the OTEL-flavored JSONL trace file. Unset = no tracing. */
  traceLog?: string;
  /** Override the web_search tool's endpoint URL (when not using the brain default). */
  webSearchEndpoint?: string;

  // ---- tier escalation --------------------------------------------------
  /** Tier ladder override — when set, beats the provider built-in. */
  tierLadder?: { flash?: string; standard?: string; pro?: string };

  // ---- tool-output context compaction ----------------------------------
  /** Enable the heuristic tool-output compactor. Default true. */
  contextCompaction?: boolean;

  // ---- orchestration ----------------------------------------------------
  /** Per-child-agent wall-clock timeout in ms. Default 600000 (10 min). */
  childAgentTimeoutMs?: number;
  /** Character budget for the in-REPL child-agent result preview. Default 2500. */
  agentPreviewChars?: number;

  // ---- diagnostics ------------------------------------------------------
  /** Verbose beforeExit/exit tracing — default false. */
  debugExit?: boolean;

  // ---- workspace override (used by --workspace flag) -------------------
  /** Workspace root override (normally set by the --workspace CLI flag). */
  workspaceOverride?: string;
}

export interface Config {
  activeServer: string;
  servers: Record<string, ServerConfig>;
  llm?: LLMConfig;
  /** 0.3.9: all former-env CLI knobs. Optional; defaults apply when missing. */
  cli?: CliKnobs;
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
    // Anthropic native (api.anthropic.com / ANTHROPIC_API_KEY) was
    // removed in 0.3.9 — Claude users now route through OpenRouter.
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

/**
 * Resolved CLI knobs with all defaults applied — single source of CLI
 * truth as of 0.3.9. Pure function over `Config.cli`; no env reads.
 *
 * For the cached/process-wide getter that callsites should use, see
 * `getCliKnobs()` below. Use `resolveCliKnobs(cfg)` directly only when
 * you're plumbing a config-override path (tests, /config reload).
 */
export interface ResolvedCliKnobs {
  recallMode: 'always' | 'gated' | 'off';
  prefixMemoryAnchors: 'on' | 'off';
  briefingMaxCharsPerSource: number;
  briefingMaxSources: number;
  autoCompactTokens: number;
  turnEndResultCapTokens: number;
  turnEndShrinkRatio: number;
  childResultSystemChars: number;
  maxToolResultChars: number;
  stormWindow: number;
  stormThreshold: number;
  maxToolLoops: number;
  repeatToolSequenceLimit: number;
  parallelSafeToolCalls: boolean;
  altScreen: boolean;
  hideCursor: boolean;
  quiet: boolean;
  theme: 'light' | 'dark' | 'auto';
  llmTimeoutMs: number;
  llmMaxConcurrent: number;
  disableStream: boolean;
  effort: 'low' | 'medium' | 'high';
  mcpTimeoutMs: number;
  sandbox: 'off' | 'on';
  sandboxReadPaths: string[];
  sandboxWritePaths: string[];
  sandboxNetwork: boolean;
  childDrainTimeoutMs: number;
  maxSpawnDepth: number;
  scheduleTickMs: number;
  traceLog?: string;
  webSearchEndpoint?: string;
  tierLadder?: { flash?: string; standard?: string; pro?: string };
  contextCompaction: boolean;
  childAgentTimeoutMs: number;
  agentPreviewChars: number;
  debugExit: boolean;
  workspaceOverride?: string;
}

export function resolveCliKnobs(cfg?: Config): ResolvedCliKnobs {
  const c = cfg?.cli ?? {};
  return {
    recallMode: c.recallMode ?? 'gated',
    prefixMemoryAnchors: c.prefixMemoryAnchors ?? 'on',
    briefingMaxCharsPerSource: c.briefingMaxCharsPerSource ?? 4_000,
    briefingMaxSources: c.briefingMaxSources ?? 6,
    autoCompactTokens: c.autoCompactTokens ?? 80_000,
    turnEndResultCapTokens: c.turnEndResultCapTokens ?? 3_000,
    turnEndShrinkRatio: c.turnEndShrinkRatio ?? 0.4,
    childResultSystemChars: c.childResultSystemChars ?? 12_000,
    maxToolResultChars: c.maxToolResultChars ?? 8_000,
    stormWindow: c.stormWindow ?? 6,
    stormThreshold: c.stormThreshold ?? 4,
    maxToolLoops: c.maxToolLoops ?? 60,
    repeatToolSequenceLimit: c.repeatToolSequenceLimit ?? 8,
    parallelSafeToolCalls: c.parallelSafeToolCalls ?? true,
    altScreen: c.altScreen ?? false,
    hideCursor: c.hideCursor ?? true,
    quiet: c.quiet ?? false,
    theme: c.theme ?? 'auto',
    llmTimeoutMs: c.llmTimeoutMs ?? 120_000,
    llmMaxConcurrent: c.llmMaxConcurrent ?? 4,
    disableStream: c.disableStream ?? false,
    effort: c.effort ?? 'medium',
    mcpTimeoutMs: c.mcpTimeoutMs ?? 60_000,
    sandbox: c.sandbox ?? 'off',
    sandboxReadPaths: c.sandboxReadPaths ?? [],
    sandboxWritePaths: c.sandboxWritePaths ?? [],
    sandboxNetwork: c.sandboxNetwork ?? false,
    childDrainTimeoutMs: c.childDrainTimeoutMs ?? 30_000,
    maxSpawnDepth: c.maxSpawnDepth ?? 3,
    scheduleTickMs: c.scheduleTickMs ?? 30_000,
    traceLog: c.traceLog,
    webSearchEndpoint: c.webSearchEndpoint,
    tierLadder: c.tierLadder,
    contextCompaction: c.contextCompaction ?? true,
    childAgentTimeoutMs: c.childAgentTimeoutMs ?? 600_000,
    agentPreviewChars: c.agentPreviewChars ?? 2_500,
    debugExit: c.debugExit ?? false,
    workspaceOverride: c.workspaceOverride,
  };
}

// -------------------------------------------------------------------------
// Process-wide cached getter + override hook.
// -------------------------------------------------------------------------
//
// Most callsites just want "give me the current knob value" without
// re-reading the config file. The cache:
//   - loads on first read
//   - serves all subsequent reads from memory
//   - lets a CLI argv flag (`--workspace`, `--timeout`) override one knob
//     in-process via `setCliKnobOverride(...)` without persisting to disk
//   - exposes `_resetCliKnobsCache()` for tests
//
// This replaces the old `process.env.BRAINROUTER_*` reads sprinkled
// throughout the codebase. The single config.json is now the single
// source of truth.

let cachedKnobs: ResolvedCliKnobs | undefined;
let cachedRawCli: CliKnobs | undefined;
let cachedOverrides: Partial<ResolvedCliKnobs> = {};

function loadCachedConfig(): Config {
  let cfg: Config;
  try {
    cfg = loadOrInitConfig();
  } catch {
    cfg = { activeServer: '', servers: {} };
  }
  return cfg;
}

export function getCliKnobs(): ResolvedCliKnobs {
  if (cachedKnobs === undefined) {
    // Lazy load so tests / one-shot commands don't pay the disk read
    // if they never touch knobs. `loadOrInitConfig` is forgiving when
    // the config file is missing (returns an empty skeleton), which
    // means the defaults apply automatically in fresh installs.
    const cfg = loadCachedConfig();
    cachedKnobs = resolveCliKnobs(cfg);
    cachedRawCli = cfg.cli ?? {};
  }
  return { ...cachedKnobs, ...cachedOverrides };
}

/**
 * Peek at the raw `cli.*` block from `~/.config/brainrouter/config.json`
 * merged with in-process overrides (so `setCliKnobOverride` flows through
 * here too). Use this when a caller needs to distinguish "user explicitly
 * set this knob" from "default-resolved fallback" — `resolveEffort` does
 * so to preserve the historical "env-wins" precedence relative to
 * per-workspace preferences.
 */
export function getRawCliKnobs(): CliKnobs {
  if (cachedRawCli === undefined) {
    const cfg = loadCachedConfig();
    cachedKnobs = resolveCliKnobs(cfg);
    cachedRawCli = cfg.cli ?? {};
  }
  return { ...cachedRawCli, ...cachedOverrides };
}

/**
 * Apply an in-process override for one or more knobs — typically used
 * by argv parsing (`--workspace <path>`, `--timeout <ms>`) which used
 * to mutate `process.env.BRAINROUTER_*` for the same effect.
 */
export function setCliKnobOverride(partial: Partial<ResolvedCliKnobs>): void {
  cachedOverrides = { ...cachedOverrides, ...partial };
}

/** Test hook — drop the cache so the next read re-loads from disk. */
export function _resetCliKnobsCache(): void {
  cachedKnobs = undefined;
  cachedRawCli = undefined;
  cachedOverrides = {};
}



