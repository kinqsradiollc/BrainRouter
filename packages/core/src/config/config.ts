import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExternalDirMode } from '../exec/policy/execPolicy.js';
import { sanitizeCommandAllowlist } from '../exec/guard/approvalGuard.js';
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
  MarketplaceSource,
  PluginCapabilityConsent,
  LlmProfileConfig,
  RouterCliKnobs,
  DeclarativeProviderEntry,
  ResolvedHostedAgentConfig,
} from './configTypes.js';
import { normalizeContainerLimits, normalizeRuntimeBackend } from './configTypes.js';
import { stripTrailingSlashes } from '../util/trimEdges.js';

/**
 * Where the config lives.
 *
 * `BRAINROUTER_CONFIG_DIR` exists so this is TESTABLE. Before it, the directory
 * was a module-level const of `os.homedir()`, which meant any test that called
 * `saveConfig` wrote to the developer's real `~/.config/brainrouter/config.json`
 * — the file holding every provider key, PAT and signing secret — with no way to
 * redirect it. That is not a hypothetical: it destroyed a real config during
 * this file's own hardening. A module nobody can point at a temp directory is a
 * module whose write path can only be exercised destructively.
 *
 * Read lazily rather than captured at import, because a test (or a host that
 * sets it after boot) must be able to change it. `BRAINROUTER_HOME` is
 * deliberately NOT consulted: it addresses the storage root, not this file, and
 * conflating them is what made the failure above look sandboxed when it wasn't.
 */
function configDir(): string {
  const override = process.env.BRAINROUTER_CONFIG_DIR?.trim();
  return override || path.join(os.homedir(), '.config', 'brainrouter');
}

function configFile(): string {
  return path.join(configDir(), 'config.json');
}

export function getConfigPath(): string {
  return configFile();
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
  if (!fs.existsSync(configFile())) {
    console.error(`No BrainRouter config found at ${configFile()}.`);
    console.error(`Run \`brainrouter login\` to connect to a hosted MCP server, or \`brainrouter config\` to set one up.`);
    process.exit(1);
  }
  let parsed: Config;
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    parsed = JSON.parse(raw) as Config;
  } catch (error) {
    console.error(`Error: Failed to parse config file at ${configFile()}: ${error instanceof Error ? error.message : String(error)}`);
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
  if (!fs.existsSync(configFile())) {
    return { activeServer: '', servers: {} };
  }
  return loadConfig();
}

/**
 * Persist the config.
 *
 * The modes are explicit because this is the richest secret file the product
 * writes: `llm.apiKey`, every `providers.*.apiKey`, the signed-in account key,
 * per-repo PATs, web-search keys, the trigger signing secrets, an inline GitHub
 * App private key, `cli.router.serveKey`. `scrubCliSecrets` exists purely to keep
 * this content away from the renderer — which is the clearest statement of how
 * sensitive it is.
 *
 * Without a mode, Node applies 0o666 & ~umask, so the file is 0600 under a
 * umask of 077 and 0644 under the far more common 022. Depending on an ambient
 * process setting for whether a credential file is world-readable is not a
 * decision anyone made; it is one nobody made. Every other secret writer here
 * already states it — `secretStore.ts` 0o600, `learning/store.ts` 0o600,
 * `manifestClaim.ts` 0o700/0o600 — and this was the outlier.
 *
 * `writeFileSync` preserves the mode of an EXISTING file, so a file already on
 * disk at 0644 stays 0644 forever without the chmod repair below.
 */
export function saveConfig(config: Config): void {
  try {
    if (!fs.existsSync(configDir())) {
      fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Repair a file created before this rule (or by an older build). Best-effort:
    // chmod is meaningless on Windows and must never fail a save.
    try { fs.chmodSync(configFile(), 0o600); } catch { /* not POSIX — nothing to enforce */ }
  } catch (error) {
    console.error(`Error: Failed to save config to ${configFile()}:`, error instanceof Error ? error.message : error);
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
  if (!fs.existsSync(configFile())) return 0;
  let parsed: Config;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Config;
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

/**
 * PLUGIN-MARKETPLACE P1/P2 — reduce raw `cli.plugins` to a validated view.
 * `enabled` keeps only string→boolean pairs (kebab-case names are trimmed,
 * case preserved); non-object input → `{}`. `registryUrl` trimmed; `''` = unset.
 * `marketplaces` keeps only well-formed sources (a non-empty `name` + `source`
 * + a recognized `sourceType`); malformed entries are dropped fail-safe.
 */
const MARKETPLACE_SOURCE_TYPES: readonly MarketplaceSource['sourceType'][] = ['git', 'local', 'http'];

function resolveMarketplaceSources(input: unknown): MarketplaceSource[] {
  if (!Array.isArray(input)) return [];
  const out: MarketplaceSource[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const source = typeof obj.source === 'string' ? obj.source.trim() : '';
    const sourceType = typeof obj.sourceType === 'string' ? (obj.sourceType.trim() as MarketplaceSource['sourceType']) : undefined;
    if (!name || !source || !sourceType || !MARKETPLACE_SOURCE_TYPES.includes(sourceType)) continue;
    if (seen.has(name)) continue; // first wins on duplicate names
    seen.add(name);
    const entry: MarketplaceSource = { name, sourceType, source };
    if (typeof obj.ref === 'string' && obj.ref.trim()) entry.ref = obj.ref.trim();
    if (Array.isArray(obj.sparsePaths)) {
      const paths = obj.sparsePaths.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim());
      if (paths.length) entry.sparsePaths = paths;
    }
    if (typeof obj.lastRevision === 'string' && obj.lastRevision.trim()) entry.lastRevision = obj.lastRevision.trim();
    if (typeof obj.lastUpdated === 'string' && obj.lastUpdated.trim()) entry.lastUpdated = obj.lastUpdated.trim();
    out.push(entry);
  }
  return out;
}

function resolveStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function resolveApprovedMap(input: unknown): Record<string, PluginCapabilityConsent> {
  const out: Record<string, PluginCapabilityConsent> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || !rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue;
    const v = rawVal as Record<string, unknown>;
    const consent: PluginCapabilityConsent = {};
    if (v.shell === true) consent.shell = true;
    if (v.mcp === true) consent.mcp = true;
    if (consent.shell || consent.mcp) out[key] = consent;
  }
  return out;
}

function resolvePreviewPorts(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawName, rawPort] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const port = typeof rawPort === 'number' && Number.isInteger(rawPort) ? rawPort : NaN;
    if (port >= 1 && port <= 65_535) out[name] = port;
  }
  return out;
}

function resolvePluginsKnobs(input: unknown): ResolvedCliKnobs['plugins'] {
  const enabled: Record<string, boolean> = {};
  let registryUrl = '';
  let marketplaces: MarketplaceSource[] = [];
  let altManifestNames: string[] = [];
  let approved: Record<string, PluginCapabilityConsent> = {};
  let allowedMarketplaces: string[] = [];
  let blockedMarketplaces: string[] = [];
  let allowedPlugins: string[] = [];
  let blockedPlugins: string[] = [];
  let allowManagedHooksOnly = false;
  let orgScope = false;
  let publishRepo = '';
  let autoUpdateCheck = false;
  let advisoryPolicy: 'off' | 'warn' | 'block' = 'off';
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (obj.enabled && typeof obj.enabled === 'object' && !Array.isArray(obj.enabled)) {
      for (const [rawKey, rawValue] of Object.entries(obj.enabled as Record<string, unknown>)) {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (key && typeof rawValue === 'boolean') enabled[key] = rawValue;
      }
    }
    if (typeof obj.registryUrl === 'string') registryUrl = obj.registryUrl.trim();
    marketplaces = resolveMarketplaceSources(obj.marketplaces);
    altManifestNames = resolveStringList(obj.altManifestNames).filter((name) => {
      const trimmed = name.trim();
      return trimmed.endsWith('.json') && !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== 'plugin.json' && trimmed !== 'brainrouter-marketplace.json';
    });
    approved = resolveApprovedMap(obj.approved);
    allowedMarketplaces = resolveStringList(obj.allowedMarketplaces);
    blockedMarketplaces = resolveStringList(obj.blockedMarketplaces);
    allowedPlugins = resolveStringList(obj.allowedPlugins);
    blockedPlugins = resolveStringList(obj.blockedPlugins);
    allowManagedHooksOnly = obj.allowManagedHooksOnly === true;
    orgScope = obj.orgScope === true;
    if (typeof obj.publishRepo === 'string') publishRepo = obj.publishRepo.trim();
    autoUpdateCheck = obj.autoUpdateCheck === true;
    if (obj.advisoryPolicy === 'warn' || obj.advisoryPolicy === 'block') advisoryPolicy = obj.advisoryPolicy;
  }
  return { enabled, registryUrl, marketplaces, altManifestNames, approved, allowedMarketplaces, blockedMarketplaces, allowedPlugins, blockedPlugins, allowManagedHooksOnly, orgScope, publishRepo, autoUpdateCheck, advisoryPolicy };
}

function resolveHostedAgentKnobs(input: unknown): ResolvedCliKnobs['agents'] {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as { hosted?: unknown }).hosted
    : undefined;
  const hosted = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ResolvedCliKnobs['agents']['hosted'] = [];
  for (const entry of hosted) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const command = typeof value.command === 'string' ? value.command.trim() : '';
    if (!name || !command || seen.has(name)) continue;
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const protocol = value.protocol === 'stdio' ? 'stdio' : 'line-json';
    // ADR-050 D5 — per-instance env: keep only string→string pairs (a home path
    // is a string; anything else is dropped rather than coerced).
    const env = resolveInstanceEnv(value.env);
    // ADR-050 D2/P4 — a bring-your-own agent may declare a live session transport.
    const transport = HOSTED_SESSION_TRANSPORTS.includes(value.transport as never)
      ? (value.transport as ResolvedHostedAgentConfig['transport'])
      : undefined;
    const transportArgs = transport && Array.isArray(value.transportArgs)
      ? value.transportArgs.filter((a): a is string => typeof a === 'string')
      : undefined;
    out.push({
      name, command, args, protocol,
      ...(env ? { env } : {}),
      ...(transport ? { transport } : {}),
      ...(transportArgs && transportArgs.length ? { transportArgs } : {}),
    });
    seen.add(name);
  }
  const liveSessions = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as { liveSessions?: unknown }).liveSessions === true
    : false;
  return { hosted: out, liveSessions };
}

/** ADR-050 D2/P4 — the session transports a bring-your-own hosted agent may declare. */
const HOSTED_SESSION_TRANSPORTS: readonly string[] = ['stdio-oneshot', 'claude-stream-json', 'codex-app-server', 'acp-stdio'];

/** ADR-050 D5 — sanitize a hosted instance's `env` to a string→string map; a
 *  non-object, or a map with no string values, yields undefined (inherit only). */
function resolveInstanceEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const k = typeof key === 'string' ? key.trim() : '';
    if (k && typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** ADR-052 D2 — sanitize per-model effort defaults to a model→effort map; a
 *  non-object, or entries with an unrecognized effort, are dropped. */
const VALID_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function resolveEffortByModel(raw: unknown): ResolvedCliKnobs['effortByModel'] {
  const out: ResolvedCliKnobs['effortByModel'] = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const model = typeof key === 'string' ? key.trim() : '';
    if (model && typeof val === 'string' && VALID_EFFORTS.includes(val)) {
      out[model] = val as ResolvedCliKnobs['effort'];
    }
  }
  return out;
}

/** ADR-052 P4.5 — sanitize the curated model-picker overlay: keep entries with a
 *  non-empty string `id`; keep `label` only when a non-empty string; `pinned` is
 *  a boolean. Invalid entries are dropped. */
function resolveModelPicker(raw: unknown): ResolvedCliKnobs['modelPicker'] {
  if (!Array.isArray(raw)) return [];
  const out: ResolvedCliKnobs['modelPicker'] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id) continue;
    const item: { id: string; label?: string; pinned?: boolean } = { id };
    if (typeof e.label === 'string' && e.label.trim()) item.label = e.label.trim();
    if (e.pinned === true) item.pinned = true;
    out.push(item);
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

const WEB_SEARCH_PROVIDER_NAMES: readonly WebSearchProviderName[] = ['serper', 'google_pse', 'brave', 'searxng', 'custom_http'];

function positiveInt(value: unknown, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, n));
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function resolveWebSearchKnobs(input: WebSearchCliKnobs | undefined): ResolvedWebSearchKnobs {
  const configuredProvider = typeof input?.provider === 'string' ? input.provider : '';
  const provider = WEB_SEARCH_PROVIDER_NAMES.includes(input?.provider as WebSearchProviderName)
    ? input!.provider!
    : 'google_pse';
  return {
    provider: provider as WebSearchProviderName,
    ...(configuredProvider === 'duckduckgo'
      ? { configurationError: 'cli.webSearch.provider "duckduckgo" is no longer supported. Choose google_pse for Google search, or configure serper, brave, searxng, or custom_http explicitly.' }
      : {}),
    maxResults: positiveInt(input?.maxResults, 5, { min: 1, max: 10 }),
    serperApiKey: input?.serperApiKey ?? '',
    google: {
      apiKey: input?.google?.apiKey ?? '',
      cx: input?.google?.cx ?? '',
    },
    braveApiKey: input?.braveApiKey ?? '',
    searxngBaseUrl: input?.searxngBaseUrl ?? '',
    persistToMemory: input?.persistToMemory === true,
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

/** Trim + drop empties + dedupe (order-preserving) a raw string list; non-array → []. */
function sanitizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Phase 1 — sanitize the GitHub App bot creds. Returns `undefined` unless an
 * `appId` AND at least one key source (`privateKey` or `privateKeyPath`) are
 * present, so a half-configured App never shadows the PAT fallback. Values are
 * trimmed and passed through verbatim (the PEM/path is read at mint time).
 */
function sanitizeGithubApp(input: unknown): import('./configTypes.js').GithubAppCliKnobs | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const a = input as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const appId = str(a.appId);
  const privateKey = typeof a.privateKey === 'string' && a.privateKey.trim() ? a.privateKey.trim() : undefined;
  const privateKeyPath = str(a.privateKeyPath);
  if (!appId || (!privateKey && !privateKeyPath)) return undefined;
  return {
    appId,
    ...(privateKey ? { privateKey } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(str(a.installationId) ? { installationId: str(a.installationId) } : {}),
    ...(str(a.apiBase) ? { apiBase: str(a.apiBase) } : {}),
  };
}

/**
 * CC-CONFIG-A2 — resolve the ORDERED fallback chain. Sanitizes `fallbackModels`,
 * caps it at 3, then appends the legacy single `fallbackModel` (if any) at the end
 * for back-compat — deduped, so declaring it in both never double-tries. The result
 * is the exact sequence `runTurn` walks on a model-not-found / retryable error.
 */
function resolveFallbackModels(list: unknown, legacy: string | null | undefined): string[] {
  const chain = sanitizeStringList(list).slice(0, 3);
  const legacyTrimmed = (legacy ?? '').trim();
  if (legacyTrimmed && !chain.includes(legacyTrimmed)) chain.push(legacyTrimmed);
  return chain;
}

function sanitizeAliasMap(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!key || key.includes('/') || !value) continue;
    out[key] = value;
  }
  return out;
}

function resolveRouterKnobs(input: RouterCliKnobs | undefined): ResolvedCliKnobs['router'] {
  const strategy = input?.strategy === 'round-robin' || input?.strategy === 'free-first'
    ? input.strategy
    : 'priority';
  const cooldownBaseMs = clampInt(input?.cooldownBaseMs, 500, 60_000, 3_000);
  return {
    // Router-first architecture: routing is ALWAYS on. An unconfigured chain
    // resolves to the base model (callers append `${base}/${model}`), so this is
    // byte-identical to a direct call for users who never set up a chain. The
    // `enabled` config field is retained for back-compat parsing but no longer
    // gates behavior — there is no "off" path.
    enabled: true,
    passThrough: input?.passThrough !== false,
    chain: sanitizeStringList(input?.chain),
    strategy,
    order: sanitizeStringList(input?.order),
    aliases: sanitizeAliasMap(input?.aliases),
    cooldownBaseMs,
    cooldownMaxMs: clampInt(input?.cooldownMaxMs, cooldownBaseMs, 1_800_000, 300_000),
    sessionAffinity: input?.sessionAffinity !== false,
    serve: input?.serve === true,
    serveHost: typeof input?.serveHost === 'string' && input.serveHost.trim()
      ? input.serveHost.trim()
      : '127.0.0.1',
    servePort: clampInt(input?.servePort, 1, 65_535, 8_790),
    serveKey: typeof input?.serveKey === 'string' ? input.serveKey : '',
  };
}

/**
 * Resolve a boolean knob where an environment variable may FORCE it on/off from
 * any shell (troubleshooting toggles the user can flip without editing config.json).
 * The env var wins when set to a recognized truthy/falsy token; otherwise the
 * config value (or `false`) applies.
 */
function resolveBoolWithEnv(configValue: boolean | undefined, envName: string): boolean {
  const raw = process.env[envName];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return configValue === true;
}

/** Coerce a config value to an int in [min,max]; NaN / unset / OOR → fallback. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * MC-D3 — validate the raw `cli.llmProfiles` map: trim names, drop blank names
 * and entries without a usable `model`, normalize the optional fields (endpoint
 * trimmed; reasoningEffort restricted to the documented union; `fast` only kept
 * when explicitly true). Exported so the CLI `/profile` command validates the
 * same way the resolver does.
 */
export function sanitizeLlmProfiles(raw: unknown): Record<string, LlmProfileConfig> {
  const out: Record<string, LlmProfileConfig> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = (name ?? '').trim();
    if (!key || !value || typeof value !== 'object') continue;
    const p = value as Partial<LlmProfileConfig>;
    const model = typeof p.model === 'string' ? p.model.trim() : '';
    if (!model) continue;
    const entry: LlmProfileConfig = { model };
    if (typeof p.endpoint === 'string' && p.endpoint.trim()) entry.endpoint = p.endpoint.trim();
    if (p.reasoningEffort === 'low' || p.reasoningEffort === 'medium' || p.reasoningEffort === 'high' || p.reasoningEffort === 'xhigh') {
      entry.reasoningEffort = p.reasoningEffort;
    }
    if (p.fast === true) entry.fast = true;
    out[key] = entry;
  }
  return out;
}

/**
 * ADR-045 — validate a per-model context-window override map: model id → a
 * positive finite integer token count. Keys are trimmed + lowercased so the
 * lookup matches `contextWindowFor`'s lowercased ids; bad entries are dropped
 * (a misconfigured value never sizes a real budget).
 */
export function sanitizeContextWindows(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = (name ?? '').trim().toLowerCase();
    if (key && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = Math.floor(value);
    }
  }
  return out;
}

/**
 * ADR-045 M5 — retire the legacy `contextWindows.json` override file by folding
 * it into `cli.contextWindows` once, at boot. Reads the sibling file, merges any
 * entries NOT already set in `cli.contextWindows` (an explicit knob value always
 * wins), persists config.json, and renames the file to `.migrated` so it is
 * retired and never re-read. Idempotent — no file (or a renamed one) ⇒ a no-op.
 * Returns how many entries moved so the boot can surface a one-time notice.
 */
export function migrateLegacyContextWindowsFile(): { migrated: number } {
  const legacyPath = path.join(configDir(), 'contextWindows.json');
  if (!fs.existsSync(legacyPath)) return { migrated: 0 };
  let legacy: Record<string, number> = {};
  try {
    legacy = sanitizeContextWindows(JSON.parse(fs.readFileSync(legacyPath, 'utf8')));
  } catch {
    // A corrupt legacy file is retired without touching config.
  }
  let migrated = 0;
  if (Object.keys(legacy).length > 0) {
    const config = loadOrInitConfig();
    const cli = config.cli ?? {};
    const merged = { ...(cli.contextWindows ?? {}) };
    // legacy keys are lowercased by sanitizeContextWindows; compare
    // case-insensitively against the (possibly mixed-case) config keys.
    const existingKeys = new Set(Object.keys(merged).map((k) => k.toLowerCase()));
    for (const [key, value] of Object.entries(legacy)) {
      if (!existingKeys.has(key)) { merged[key] = value; migrated += 1; }
    }
    if (migrated > 0) {
      config.cli = { ...cli, contextWindows: merged };
      saveConfig(config);
    }
  }
  try { fs.renameSync(legacyPath, `${legacyPath}.migrated`); } catch { /* best-effort retirement */ }
  return { migrated };
}

/**
 * ADR-047 D1 — STRUCTURAL sanitize of the declarative-provider list: keep only
 * plain objects carrying a non-empty string `id` and `endpoint`. This is the
 * cheap gate that keeps the resolved knob well-shaped; the LOUD semantic
 * validation (valid URL, id vs built-in collision, enum membership, duplicates)
 * lives in `registerDeclarativeProviders` at boot, where a misdeclaration can be
 * reported with a precise reason rather than silently dropped here.
 */
export function sanitizeCustomProviders(raw: unknown): DeclarativeProviderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DeclarativeProviderEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const e = value as Partial<DeclarativeProviderEntry>;
    if (typeof e.id !== 'string' || !e.id.trim()) continue;
    if (typeof e.endpoint !== 'string' || !e.endpoint.trim()) continue;
    out.push(e as DeclarativeProviderEntry);
  }
  return out;
}

export function resolveCliKnobs(cfg?: Config): ResolvedCliKnobs {
  const c = cfg?.cli ?? {};
  // MC-D3 — validated profiles; the active pointer only survives when it names one.
  const llmProfiles = sanitizeLlmProfiles(c.llmProfiles);
  const activeLlmProfileRaw = typeof c.activeLlmProfile === 'string' ? c.activeLlmProfile.trim() : '';
  const activeLlmProfile = llmProfiles[activeLlmProfileRaw] ? activeLlmProfileRaw : '';
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
    personalityDefault:
      c.personalityDefault === 'concise'
      || c.personalityDefault === 'standard'
      || c.personalityDefault === 'detailed'
      || c.personalityDefault === 'pair-programmer'
        ? c.personalityDefault
        : null,
    briefingMaxCharsPerSource: c.briefingMaxCharsPerSource ?? 4_000,
    briefingMaxSources: c.briefingMaxSources ?? 6,
    autoCompactTokens: c.autoCompactTokens ?? 80_000,
    contextWindows: sanitizeContextWindows(c.contextWindows),
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
    router: resolveRouterKnobs(c.router),
    llmMaxReconnects: Math.max(1, Math.floor(c.llmMaxReconnects ?? 5)),
    llmMaxConcurrent: c.llmMaxConcurrent ?? 4,
    disableStream: c.disableStream ?? false,
    traceTrajectory: c.traceTrajectory === true,
    traceRequests: c.traceRequests ?? false,
    atlas: {
      orient: c.atlas?.orient ?? true,
      retrieval: c.atlas?.retrieval ?? true,
      autoRefresh: c.atlas?.autoRefresh ?? true,
    },
    browser: {
      vision: c.browser?.vision === 'off' ? 'off' : 'auto',
      searchEngine: typeof c.browser?.searchEngine === 'string' ? c.browser.searchEngine.trim() : '',
    },
    confirmRunWorkflow: c.confirmRunWorkflow ?? true,
    effort: c.effort ?? 'medium',
    effortByModel: resolveEffortByModel(c.effortByModel),
    fallbackModel: c.fallbackModel ?? null,
    fallbackModels: resolveFallbackModels(c.fallbackModels, c.fallbackModel),
    availableModels: sanitizeStringList(c.availableModels),
    enforceAvailableModels: c.enforceAvailableModels === true,
    modelPicker: resolveModelPicker(c.modelPicker),
    customProviders: sanitizeCustomProviders(c.customProviders),
    llmProfiles,
    activeLlmProfile,
    requiredMinimumVersion: typeof c.requiredMinimumVersion === 'string' ? c.requiredMinimumVersion.trim() : '',
    requiredMaximumVersion: typeof c.requiredMaximumVersion === 'string' ? c.requiredMaximumVersion.trim() : '',
    enforceVersionRange: c.enforceVersionRange === true,
    // CC-CONFIG-A1 — env override wins (opt-in troubleshooting from any shell).
    safeMode: resolveBoolWithEnv(c.safeMode, 'BRAINROUTER_SAFE_MODE'),
    // ADR-052 D3 — restricted session; config-only (a launch/CI sets cli.restricted).
    restricted: c.restricted === true,
    usageTelemetry: c.usageTelemetry === true,
    // ADR-028 H3 — anything unrecognised falls back to `auto`, so a typo in
    // config cannot silently change how pull requests are opened.
    stackingMode: c.stackingMode === 'always' || c.stackingMode === 'never' ? c.stackingMode : 'auto',
    comprehension: {
      // On by default: it is invoked, never unprompted, so the cost of having
      // it available is a panel nobody opens.
      enabled: c.comprehension?.enabled !== false,
      model: typeof c.comprehension?.model === 'string' ? c.comprehension.model : '',
      // Clamped rather than validated-and-rejected: a config typo should not
      // stop a review, and the ADR's bounds are the point of the number.
      questions: Math.min(7, Math.max(3, Number(c.comprehension?.questions) || 5)),
    },
    // Defaults to 'safe': a feature that shipped and sat unused because an
    // extension was missing is the problem this exists to solve.
    autoInstallTools: c.autoInstallTools === 'off' ? 'off' : 'safe',
    attribution: { sessionUrl: c.attribution?.sessionUrl !== false },
    // CC-CONFIG-A6 — env override wins.
    skillsHideBundled: resolveBoolWithEnv(c.skillsHideBundled, 'BRAINROUTER_HIDE_BUNDLED_SKILLS'),
    // MC-E1 — org convention repositories are opt-in and read-only.
    skills: { orgRepoDiscovery: c.skills?.orgRepoDiscovery === true },
    // CC-SKILLS-D1 — clamp to 1..5; NaN / unset / out-of-range → the default 5.
    skillsStackMax: clampInt(c.skillsStackMax, 1, 5, 5),
    // MC-E2 — keyword-triggered JIT skill injection. Default ON (additive:
    // it is inert unless a SKILL.md declares `triggers:`/`keywords:`).
    skillsKeywordTriggers: c.skillsKeywordTriggers !== false,
    // CC-UX-E2 — GFM task-list checkboxes in the CLI renderer. Default true.
    markdownCheckboxes: c.markdownCheckboxes !== false,
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
    // CC-SAFETY-B1 — classify-all-shell posture. Default 'off' (back-compat).
    autoClassifyShell: c.autoClassifyShell === 'on' || c.autoClassifyShell === 'strict' ? c.autoClassifyShell : 'off',
    autoClassifyShellEnforceWhenSilent: c.autoClassifyShellEnforceWhenSilent !== false,
    childWorkspaceIsolation: c.childWorkspaceIsolation ?? 'auto',
    worktreeRoot: c.worktreeRoot ?? '',
    buildLoop: c.buildLoop ?? 'escalate',
    worktreeMergeReview: c.worktreeMergeReview ?? 'off',
    buildLoopMaxRepairs: Math.max(0, Math.floor(c.buildLoopMaxRepairs ?? 0)),
    buildLoopEmitPr: c.buildLoopEmitPr === true,
    buildLoopPrBaseBranch: (c.buildLoopPrBaseBranch ?? '').trim(),
    buildLoopPrDraft: c.buildLoopPrDraft !== false,
    // MC-D1 — critic gate: OFF by default; threshold validated to [0,1];
    // refinement rounds hard-capped so a misconfig can never loop unbounded.
    critic: {
      enabled: c.critic?.enabled === true,
      threshold: unitInterval(c.critic?.threshold, 0.7),
      maxRefinementIterations: clampInt(c.critic?.maxRefinementIterations, 0, 8, 2),
      model: typeof c.critic?.model === 'string' ? c.critic.model.trim() : '',
    },
    budget: {
      maxPerTaskUSD: nonNegativeNumber(c.budget?.maxPerTaskUSD),
      maxPerTaskTokens: Math.floor(nonNegativeNumber(c.budget?.maxPerTaskTokens)),
    },
    notifyBell: c.notifyBell ?? false,
    childDrainTimeoutMs: c.childDrainTimeoutMs ?? 30_000,
    offloadRetentionMs: c.offloadRetentionMs ?? 1_800_000,
    offloadMaxEntries: c.offloadMaxEntries ?? 64,
    // ADR-041 A41-15 — Code Mode, default OFF; budget overrides pass through and
    // are clamped by resolveCodeModeBudget at use.
    codeMode: { ...(c.codeMode ?? {}), enabled: c.codeMode?.enabled === true },
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
    plugins: resolvePluginsKnobs(c.plugins),
    agents: resolveHostedAgentKnobs(c.agents),
    // MC-A1 — runtime plane. Backend validates to 'process' (today's in-process
    // execution) so a typo can never silently opt into an isolated backend;
    // maxLive 0 = no live-instance cap (LRU parking arrives with MC-A4).
    // MC-A6 — archive knobs: archiveOnDispose defaults ON (anything but an
    // explicit `false` keeps the safety net); archiveMaxMB caps the tarball
    // payload (disk is constrained); archiveKeep bounds pruneArchives().
    // MC-A5 — jitSecrets requires an explicit `true` (default false = children
    // keep receiving raw env values); jitSecretTtlMs is the lease lifetime.
    // MC-A3 — the container backend stays strictly opt-in even when
    // `backend: 'container'` validates: containerImage has NO default (the
    // backend errors until the user names an image) and nothing is ever
    // pulled automatically. `container` holds validated docker resource
    // limits (0/'' = unlimited).
    runtime: {
      backend: normalizeRuntimeBackend(c.runtime?.backend),
      maxLive: clampInt(c.runtime?.maxLive, 0, 256, 0),
      archiveOnDispose: c.runtime?.archiveOnDispose !== false,
      archiveMaxMB: clampInt(c.runtime?.archiveMaxMB, 1, 1024, 64),
      archiveKeep: clampInt(c.runtime?.archiveKeep, 0, 500, 20),
      jitSecrets: c.runtime?.jitSecrets === true,
      jitSecretTtlMs: clampInt(c.runtime?.jitSecretTtlMs, 1_000, 3_600_000, 60_000),
      containerImage: typeof c.runtime?.containerImage === 'string' ? c.runtime.containerImage.trim() : '',
      container: normalizeContainerLimits(c.runtime?.container),
      serve: c.runtime?.serve === true,
      serveHost: typeof c.runtime?.serveHost === 'string' && c.runtime.serveHost.trim()
        ? c.runtime.serveHost.trim()
        : '127.0.0.1',
      servePort: clampInt(c.runtime?.servePort, 0, 65_535, 8791),
      remoteUrl: typeof c.runtime?.remoteUrl === 'string' ? stripTrailingSlashes(c.runtime.remoteUrl.trim()) : '',
      previewPorts: resolvePreviewPorts(c.runtime?.previewPorts),
    },
    // MC-B1 — trigger ingress: DEFAULT-DENY across the board. `enabled`
    // requires an explicit `true` (nothing ever listens by accident), the
    // bind host defaults to loopback, and an empty `allowedRepos` list means
    // every verified event is accepted-but-dropped. `githubSecret` empty =
    // resolve from the GitHub connector config, else reject deliveries —
    // a missing secret is never treated as "skip verification".
    triggers: {
      enabled: c.triggers?.enabled === true,
      port: clampInt(c.triggers?.port, 1, 65_535, 8787),
      host: typeof c.triggers?.host === 'string' && c.triggers.host.trim() ? c.triggers.host.trim() : '127.0.0.1',
      // Phase 1 — GitHub App bot creds, only surfaced when appId + a key source
      // are both present (otherwise the PAT path applies). The private key is
      // passed through verbatim; loadGithubAppCredentials reads privateKeyPath.
      githubApp: sanitizeGithubApp(c.triggers?.githubApp),
      githubSecret: typeof c.triggers?.githubSecret === 'string' ? c.triggers.githubSecret.trim() : '',
      slackSigningSecret: typeof c.triggers?.slackSigningSecret === 'string' ? c.triggers.slackSigningSecret.trim() : '',
      gitlabSecret: typeof c.triggers?.gitlabSecret === 'string' ? c.triggers.gitlabSecret.trim() : '',
      jiraSecret: typeof c.triggers?.jiraSecret === 'string' ? c.triggers.jiraSecret.trim() : '',
      allowedRepos: sanitizeStringList(c.triggers?.allowedRepos),
      // MC-B2 — resolver @mention handle; junk/empty falls back to the default.
      mentionHandle:
        (typeof c.triggers?.mentionHandle === 'string' && c.triggers.mentionHandle.trim().replace(/^@/, '')) ||
        'brainrouter',
      // MC-B4 — CI-failure nudge: explicit true only, junk stays off.
      ciNudge: c.triggers?.ciNudge === true,
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

/**
 * Is the configured `brainUrl` a *genuinely remote* brain?
 *
 * `brainUrl` (ADR-005) points the memory brain at an HTTP endpoint. The
 * local-desktop control gates (`browser_*`, `computer_use`) block "remote-brain"
 * sessions so a brain running elsewhere cannot puppet the operator's machine.
 * But a LOOPBACK brain runs on the *same host* as the desktop — the same trust
 * boundary as the embedded brain — so it must NOT count as remote. Otherwise the
 * standard local-dev setup (the dockerized brain served at
 * `http://localhost:3747/mcp`) silently loses every browser and computer tool,
 * even though the in-app browser is right there.
 *
 * Unset/empty = embedded = local (false). Unparseable = treat as remote (true):
 * never grant local desktop control on a URL we cannot vet.
 */
export function isRemoteBrainUrl(brainUrl: string | null | undefined): boolean {
  const raw = (brainUrl ?? '').trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false;
  // 127.0.0.0/8 loopback (127.x.x.x).
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return false;
  return true;
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
