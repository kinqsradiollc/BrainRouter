import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExternalDirMode } from '../exec/execPolicy.js';
import { sanitizeCommandAllowlist } from '../exec/approvalGuard.js';
import { BUILTIN_PROVIDERS } from '../provider/providers/index.js';

// Record + knob type shapes live in ./configTypes.js (split out for readability).
export * from './configTypes.js';
import type {
  Config,
  CliKnobs,
  ResolvedCliKnobs,
  WebSearchCliKnobs,
  ResolvedWebSearchKnobs,
  WebSearchProviderName,
  ProviderWireFormat,
} from './configTypes.js';

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
  // Self-heal structural gaps IN-MEMORY only. Fixes the #59 class of crash
  // (config.servers[activeServer] === undefined when activeServer is '' but
  // profiles exist → reading `.type` throws) for this process, without ever
  // writing to disk as a side effect of a read. An earlier draft persisted the
  // heal here; it mutated the user's real config.json during unrelated
  // commands/tests, and persisting knob defaults also collapses the
  // config > preference > default layering. `/config` is the explicit,
  // user-initiated way to durably repair the file.
  parsed = selfHealConfig(parsed).config;

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
  // Endpoint → env-var map, DERIVED entirely from the provider code modules
  // (BUILTIN_PROVIDERS) so it can never drift from the catalog. OpenRouter,
  // Gemini, Anthropic and Groq now each have a code module, so the old hand-kept
  // OpenRouter/Gemini literals are gone — every cloud provider with a non-empty
  // endpoint + envKey is covered automatically. (Azure's endpoint is per-resource
  // and therefore empty, so it's correctly excluded from endpoint matching.)
  const PROVIDER_ENV_BY_ENDPOINT: Array<{ endpoint: string; envKey: string }> = [
    ...BUILTIN_PROVIDERS.filter((p) => p.endpoint && p.envKey).map((p) => ({ endpoint: p.endpoint, envKey: p.envKey })),
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
 * CONFIG-HYDRATE (0.4.11) — knobs that ALSO live in the per-workspace preference
 * store and layer `config.cli` > preference > default. Writing THEIR default into
 * the file would shadow the preference and silently disable `/theme` · `/effort` ·
 * `/quiet`, so hydration deliberately leaves them out (they stay dynamic).
 */
const PREFERENCE_LAYERED_KNOBS = new Set<string>(['theme', 'effort', 'quiet']);

/**
 * CONFIG-HYDRATE (0.4.11) — fill in every SAFE `cli.*` knob's default the config
 * is missing, so the file is self-documenting + editable. Pure (no I/O). Skips
 * the preference-layered knobs above and any knob whose default is `undefined`
 * (optional / no default). Returns how many keys were added.
 */
export function hydrateCliDefaults(config: Config): { config: Config; added: number } {
  const defaults = resolveCliKnobs(undefined) as unknown as Record<string, unknown>;
  const cli: Record<string, unknown> = { ...(config.cli ?? {}) };
  let added = 0;
  for (const [key, value] of Object.entries(defaults)) {
    if (PREFERENCE_LAYERED_KNOBS.has(key)) continue;
    if (value === undefined) continue;
    if (!(key in cli)) { cli[key] = value; added += 1; }
  }
  if (added > 0) config.cli = cli as Config['cli'];
  return { config, added };
}

/**
 * CONFIG-HYDRATE (0.4.11) — populate the on-disk config.json with any missing
 * safe `cli.*` defaults, then write it back. Operates on the RAW file (NOT the
 * env-backfilled `loadConfig` result, so a shell API key is never persisted) and
 * only writes when something was actually added. Call at a deliberate launch
 * (interactive boot) — NOT inside `loadConfig`, which must stay side-effect-free
 * on reads. Returns the number of knobs added (0 = nothing written).
 */
export function hydrateConfigDefaultsOnDisk(): number {
  if (!fs.existsSync(CONFIG_FILE)) return 0;
  let parsed: Config;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    return 0; // malformed — leave it for loadConfig to surface
  }
  const { config, added } = hydrateCliDefaults(parsed);
  if (added > 0) saveConfig(config);
  return added;
}

/**
 * Self-heal structural gaps in a parsed config. Pure (no I/O — the caller
 * persists when `changed`), so it's unit-testable in isolation. Ensures
 * `servers`/`activeServer` exist, and when `activeServer` is empty or names a
 * deleted profile WHILE profiles exist, picks a sane one — preferring an
 * `identity: 'brainrouter'` profile, then a `brainrouter`-prefixed name, then
 * the first key.
 *
 * This is the root fix for the #59 `/status` crash: a real config had
 * `activeServer: ""` with populated `servers`, so `config.servers[""]` was
 * `undefined` and reading `.type` off it threw
 * "Cannot read properties of undefined (reading 'type')".
 *
 * It deliberately does NOT backfill `cli.*` defaults into the file. Several
 * knobs (`effort`, `theme`, …) layer config > workspace-preference > default,
 * so an ABSENT knob is meaningful — writing its default value would make the
 * `/effort` and `/theme` preferences a silent no-op (and freeze the knob at
 * today's default if we ever change it). Knob discoverability lives in
 * `/debug-config` (effective values), not in a polluted file.
 *
 * Returns `changed: true` iff something was repaired.
 */
export function selfHealConfig(parsed: Config): { config: Config; changed: boolean } {
  let changed = false;
  if (!parsed.servers || typeof parsed.servers !== 'object') {
    parsed.servers = {};
    changed = true;
  }
  if (typeof parsed.activeServer !== 'string') {
    parsed.activeServer = '';
    changed = true;
  }

  // Self-heal a dangling/empty activeServer when profiles exist.
  const serverIds = Object.keys(parsed.servers);
  const activeResolves = parsed.activeServer && parsed.servers[parsed.activeServer];
  if (!activeResolves && serverIds.length > 0) {
    const byIdentity = serverIds.find((id) => parsed.servers[id]?.identity === 'brainrouter');
    const byName = serverIds.find((id) => id.toLowerCase().startsWith('brainrouter'));
    const picked = byIdentity ?? byName ?? serverIds[0];
    if (parsed.activeServer !== picked) {
      parsed.activeServer = picked;
      changed = true;
    }
  }

  return { config: parsed, changed };
}

/**
 * Resolved CLI knobs with all defaults applied — single source of CLI
 * truth as of 0.3.9. Pure function over `Config.cli`; no env reads.
 *
 * For the cached/process-wide getter that callsites should use, see
 * `getCliKnobs()` below. Use `resolveCliKnobs(cfg)` directly only when
 * you're plumbing a config-override path (tests, /config reload).
 */

/** Reduce a raw `toolOverrides` to a validated `{ [tool]: boolean }` map. Non-object
 *  input → empty; non-boolean values dropped; tool-name keys trimmed (case kept —
 *  tool names are case-sensitive, incl. `mcp_<server>_<tool>`). */
function normalizeToolOverrides(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key && typeof rawValue === 'boolean') out[key] = rawValue;
  }
  return out;
}

function unitInterval(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** Reduce a raw `providerRequestFormat` to its validated subset.
 *  - non-object input → empty map (fail-safe)
 *  - values other than the accepted `ProviderWireFormat` literals → dropped
 *  - keys are preserved lowercased so lookups under `provider` ids are stable. */
const PROVIDER_WIRE_FORMATS: readonly ProviderWireFormat[] = ['responses', 'chat-completions', 'anthropic-messages', 'gemini-generate'];
function normalizeProviderRequestFormat(input: unknown): Record<string, ProviderWireFormat> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, ProviderWireFormat> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : '';
    if (!key) continue;
    if (typeof rawValue === 'string' && (PROVIDER_WIRE_FORMATS as readonly string[]).includes(rawValue)) {
      out[key] = rawValue as ProviderWireFormat;
    }
  }
  return out;
}

const WEB_SEARCH_PROVIDER_NAMES: readonly WebSearchProviderName[] = ['duckduckgo', 'serper', 'google_pse', 'brave', 'searxng', 'custom_http'];

function positiveInt(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, n));
}

function resolveWebSearchKnobs(input: WebSearchCliKnobs | undefined): ResolvedWebSearchKnobs {
  const provider = WEB_SEARCH_PROVIDER_NAMES.includes(input?.provider as WebSearchProviderName)
    ? input!.provider!
    : 'duckduckgo';
  return {
    provider,
    maxResults: positiveInt(input?.maxResults, 5, { min: 1, max: 10 }),
    serperApiKey: input?.serperApiKey ?? '',
    google: {
      apiKey: input?.google?.apiKey ?? '',
      cx: input?.google?.cx ?? '',
    },
    braveApiKey: input?.braveApiKey ?? '',
    searxngBaseUrl: input?.searxngBaseUrl ?? '',
    crawler: {
      respectRobots: input?.crawler?.respectRobots ?? true,
      maxContentChars: positiveInt(input?.crawler?.maxContentChars, 15_000, { min: 1 }),
      maxHtmlBytes: positiveInt(input?.crawler?.maxHtmlBytes, 5_242_880, { min: 1 }),
      timeoutMs: positiveInt(input?.crawler?.timeoutMs, 30_000, { min: 1 }),
      ratePerHostMs: positiveInt(input?.crawler?.ratePerHostMs, 1_000, { min: 0 }),
      userAgent: input?.crawler?.userAgent?.trim() || 'BrainRouterCrawler/0.4.16',
    },
  };
}

export function resolveCliKnobs(cfg?: Config): ResolvedCliKnobs {
  const c = cfg?.cli ?? {};
  const automation = c.automation ?? {};
  const requirementsAutomation = automation.requirements ?? {};
  const autoCreateThreshold = unitInterval(requirementsAutomation.autoCreateThreshold, 0.7);
  const lowActThreshold = Math.min(unitInterval(requirementsAutomation.lowActThreshold, 0.4), autoCreateThreshold);
  const sprintAutomation = automation.sprints ?? {};
  return {
    recallMode: c.recallMode ?? 'gated',
    nextActionPlanner: c.nextActionPlanner ?? 'on',
    permissions: { allow: c.permissions?.allow ?? [], deny: c.permissions?.deny ?? [] },
    automation: {
      enabled: automation.enabled ?? false,
      requirements: {
        enabled: requirementsAutomation.enabled ?? false,
        autoCreateThreshold,
        lowActThreshold,
        autopilot: requirementsAutomation.autopilot ?? false,
      },
      sync: { enabled: automation.sync?.enabled ?? false },
      sprints: {
        enabled: sprintAutomation.enabled ?? false,
        minItems: Number.isInteger(sprintAutomation.minItems) && sprintAutomation.minItems! > 0
          ? sprintAutomation.minItems!
          : 3,
        respectCapacity: sprintAutomation.respectCapacity ?? true,
        autopilot: sprintAutomation.autopilot ?? false,
      },
    },
    hooks: {
      enabled: c.hooks?.enabled ?? true,
      enforceWhenSilent: c.hooks?.enforceWhenSilent ?? true,
    },
    prefixMemoryAnchors: c.prefixMemoryAnchors ?? 'on',
    personaAnchor: c.personaAnchor ?? 'on',
    briefingMaxCharsPerSource: c.briefingMaxCharsPerSource ?? 4_000,
    briefingMaxSources: c.briefingMaxSources ?? 6,
    autoCompactTokens: c.autoCompactTokens ?? 80_000,
    turnEndResultCapTokens: c.turnEndResultCapTokens ?? 3_000,
    turnEndShrinkRatio: c.turnEndShrinkRatio ?? 0.4,
    childResultSystemChars: c.childResultSystemChars ?? 12_000,
    maxToolResultChars: c.maxToolResultChars ?? 8_000,
    toolOutputCompressionEnabled: c.toolOutputCompressionEnabled ?? false,
    toolOutputCompressionMinChars: Number.isFinite(c.toolOutputCompressionMinChars) && c.toolOutputCompressionMinChars! > 0
      ? Math.floor(c.toolOutputCompressionMinChars!)
      : 2_000,
    toolOutputCompressionTargetKeep: Number.isFinite(c.toolOutputCompressionTargetKeep)
      && c.toolOutputCompressionTargetKeep! > 0
      && c.toolOutputCompressionTargetKeep! <= 1
      ? c.toolOutputCompressionTargetKeep!
      : 0.2,
    effortRoutingMode: c.effortRoutingMode === 'adaptive' ? 'adaptive' : 'off',
    effortForToolResumeTurns: c.effortForToolResumeTurns === 'medium' ? 'medium' : 'low',
    verbositySteeringLevel: c.verbositySteeringLevel === 1 || c.verbositySteeringLevel === 2 || c.verbositySteeringLevel === 3 || c.verbositySteeringLevel === 4
      ? c.verbositySteeringLevel
      : 0,
    stormWindow: c.stormWindow ?? 6,
    stormThreshold: c.stormThreshold ?? 4,
    maxToolLoops: c.maxToolLoops ?? 250,
    localModelProfile: c.localModelProfile === 'on' || c.localModelProfile === 'off' ? c.localModelProfile : 'auto',
    repeatToolSequenceLimit: c.repeatToolSequenceLimit ?? 12,
    repeatSequenceExemptTools: Array.isArray(c.repeatSequenceExemptTools)
      ? c.repeatSequenceExemptTools
      : ['write_file', 'edit_file', 'apply_patch'],
    repeatLoopLimit: c.repeatLoopLimit ?? 3,
    parallelSafeToolCalls: c.parallelSafeToolCalls ?? true,
    altScreen: c.altScreen ?? false,
    hideCursor: c.hideCursor ?? true,
    quiet: c.quiet ?? false,
    theme: c.theme ?? 'auto',
    llmTimeoutMs: c.llmTimeoutMs ?? 120_000,
    llmMaxReconnects: Math.max(1, Math.floor(c.llmMaxReconnects ?? 5)),
    llmMaxConcurrent: c.llmMaxConcurrent ?? 4,
    disableStream: c.disableStream ?? false,
    confirmRunWorkflow: c.confirmRunWorkflow ?? true,
    effort: c.effort ?? 'medium',
    fallbackModel: c.fallbackModel ?? null,
    mcpTimeoutMs: c.mcpTimeoutMs ?? 60_000,
    brainUrl: c.brainUrl ?? null,
    sandbox: c.sandbox ?? 'off',
    sandboxReadPaths: c.sandboxReadPaths ?? [],
    sandboxWritePaths: c.sandboxWritePaths ?? [],
    sandboxNetwork: c.sandboxNetwork ?? false,
    sandboxUnavailable: c.sandboxUnavailable ?? 'deny',
    sandboxEnforceWhenSilent: c.sandboxEnforceWhenSilent ?? true,
    jobSecretScoping: c.jobSecretScoping !== false,
    jobSecretAllowlist: Array.isArray(c.jobSecretAllowlist) ? c.jobSecretAllowlist : [],
    // CODEX-APPROVAL-GUARD — drop over-broad prefixes (bare `git`/`bash`/`sudo`/…)
    // so a too-permissive config.json entry can never auto-approve everything.
    commandAllowlist: sanitizeCommandAllowlist(c.commandAllowlist ?? []).allowed,
    childWorkspaceIsolation: c.childWorkspaceIsolation ?? 'auto',
    worktreeRoot: c.worktreeRoot ?? '',
    buildLoop: c.buildLoop ?? 'escalate',
    worktreeMergeReview: c.worktreeMergeReview ?? 'off',
    buildLoopMaxRepairs: Math.max(0, Math.floor(c.buildLoopMaxRepairs ?? 0)),
    buildLoopEmitPr: c.buildLoopEmitPr === true,
    buildLoopPrBaseBranch: (c.buildLoopPrBaseBranch ?? '').trim(),
    buildLoopPrDraft: c.buildLoopPrDraft !== false,
    notifyBell: c.notifyBell ?? false,
    childDrainTimeoutMs: c.childDrainTimeoutMs ?? 30_000,
    offloadRetentionMs: c.offloadRetentionMs ?? 1_800_000,
    offloadMaxEntries: c.offloadMaxEntries ?? 64,
    maxSpawnDepth: c.maxSpawnDepth ?? 3,
    maxConcurrentChildren: c.maxConcurrentChildren ?? 8,
    fleetMaxConcurrentJobs: Math.max(0, Math.floor(c.fleetMaxConcurrentJobs ?? 4)),
    autoChainMaxFollowups: c.autoChainMaxFollowups ?? 2,
    agentMcpToolBudget: c.agentMcpToolBudget ?? 16,
    mcpProgressiveDiscovery: c.mcpProgressiveDiscovery ?? false,
    scheduleTickMs: c.scheduleTickMs ?? 30_000,
    traceLog: c.traceLog,
    tracingBackend: c.tracingBackend ?? 'stdout-jsonl',
    tracingEndpoint: c.tracingEndpoint,
    tracingApiKey: c.tracingApiKey,
    webSearchEndpoint: c.webSearchEndpoint,
    webSearch: resolveWebSearchKnobs(c.webSearch),
    computerUse: {
      enabled: c.computerUse?.enabled ?? false,
      mode: c.computerUse?.mode?.trim() || 'smart_approve',
    },
    tierLadder: c.tierLadder,
    contextCompaction: c.contextCompaction ?? true,
    updateCheck: c.updateCheck ?? true,
    externalDirWrites: c.externalDirWrites ?? 'ask',
    egressAllowlist: Array.isArray(c.egressAllowlist) ? c.egressAllowlist : [],
    postEditCheck: c.postEditCheck ?? '',
    autoExtractSkills: c.autoExtractSkills ?? false,
    autoReplayOffline: c.autoReplayOffline ?? true,
    autoReindex: c.autoReindex ?? true,
    browserSmoke: c.browserSmoke ?? '',
    lspServers: (c.lspServers && typeof c.lspServers === 'object') ? c.lspServers : {},
    codePromptPrefix: typeof c.codePromptPrefix === 'string' ? c.codePromptPrefix : '',
    shortcuts: (c.shortcuts && typeof c.shortcuts === 'object') ? (c.shortcuts as Record<string, string>) : {},
    childAgentTimeoutMs: c.childAgentTimeoutMs ?? 0, // 0 = parent waits until child completion
    agentPreviewChars: c.agentPreviewChars ?? 2_500,
    debugExit: c.debugExit ?? false,
    workspaceOverride: c.workspaceOverride,
    maxOutputTokens: c.maxOutputTokens,
    providerRequestFormat: normalizeProviderRequestFormat(c.providerRequestFormat),
    toolOverrides: normalizeToolOverrides(c.toolOverrides),
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
