/**
 * CONFIG — record + knob type shapes.
 *
 * The persisted config record (Config/ServerConfig/LLMConfig) plus every CLI-knob
 * shape (raw CliKnobs + the Resolved* views). Pure types — no runtime behavior —
 * split out of config.ts so the loader/resolver logic reads cleanly. Re-exported
 * from ../config/config.js, so every importer of these types is unchanged.
 */
import type { ExternalDirMode } from '../exec/policy/execPolicy.js';
import type {
  HostedAgentConfig,
  ResolvedHostedAgentConfig,
  RuntimeBackendKind,
  RuntimeCliKnobs,
} from './runtimeConfig.js';

export * from './runtimeConfig.js';

export interface ServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  apiKey?: string;
  /** Extra HTTP headers for hosted MCP transports (one-off vendor tokens,
   * workspace/project selectors, beta flags, etc.). `apiKey` still maps to
   * Authorization unless this object already provides one. */
  headers?: Record<string, string>;
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
  // Provider catalog id (openai, lmstudio, ollama, deepseek, ...). The
  // request can be sent as either OpenAI Responses API or Chat Completions,
  // selected by provider defaults plus `cli.providerRequestFormat`. Models for
  // external gateways still use OpenAI-compatible adapters.
  provider: string;
  apiKey: string;
  model: string;
  endpoint?: string;
  // 0.4.17 — Onyx-parity multi-select: the set of models this provider key
  // unlocks (from its live GET /models). `model` above stays the single
  // required default and MUST be a member when this is non-empty. Omitted/empty
  // ⇒ legacy single-default behavior, unchanged (no migration needed). The
  // Desktop composer narrows its picker to this allowlist when present.
  models?: string[];
  // 0.4.17 — optional Azure-style `api-version`. When set it is appended as an
  // `?api-version=` query param to the chat/completions (and /models) URL; the
  // OpenAI-compatible providers that don't need it simply leave it unset.
  apiVersion?: string;
  /** Provider-router v2: prefer this provider in the `free-first` strategy. */
  free?: boolean;
  /** Provider-router v2: route unknown model ids here when it is the only catch-all gateway. */
  passthroughUnknown?: boolean;
  /** Provider-router v2: last live `/models` result, used as the offline catalog. */
  cachedModels?: string[];
  /** ISO timestamp for `cachedModels`. */
  cachedAt?: string;
}

/**
 * MC-D3 — one named LLM profile (`cli.llmProfiles.<name>`). Only `model` is
 * required; the other fields overlay the base `llm` config / session stance
 * when the profile is activated. The base provider + API key always carry
 * over — a profile is a preset, not a credential store.
 */
export interface LlmProfileConfig {
  /** Model id the profile switches to (required — a profile without one is dropped). */
  model: string;
  /** Optional endpoint override (e.g. a different OpenAI-compatible gateway). */
  endpoint?: string;
  /** Optional reasoning depth applied to the session on activation. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Optional Fast-mode preference. Only honored by the user-driven `/profile use`
   *  (never by the agent's `switch_model` — an agent must not loosen approvals). */
  fast?: boolean;
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
export interface AutomationKnobs {
  enabled?: boolean;
  requirements?: {
    enabled?: boolean;
    autoCreateThreshold?: number;
    lowActThreshold?: number;
    /**
     * Tiered autonomy. Default false ("propose"): an auto-detected requirement
     * is captured as `draft` and the agent surfaces a one-click promote — the
     * plan/Track cascade only fires once the requirement is `ready`. When true
     * ("autopilot"): a confident detection with concrete acceptance criteria is
     * created `ready` directly, so the full cascade runs unattended.
     */
    autopilot?: boolean;
  };
  sync?: { enabled?: boolean };
  sprints?: {
    enabled?: boolean;
    minItems?: number;
    respectCapacity?: boolean;
    /**
     * Default false ("propose"): sprint automation only SUGGESTS (create /
     * complete) — a human makes the irreversible org commitment. When true
     * ("autopilot"): it auto-creates a future sprint, assigns ready items, and
     * auto-completes a done sprint (it still never auto-STARTS a sprint).
     */
    autopilot?: boolean;
  };
}

export interface ResolvedAutomationKnobs {
  enabled: boolean;
  requirements: {
    enabled: boolean;
    autoCreateThreshold: number;
    lowActThreshold: number;
    autopilot: boolean;
  };
  sync: { enabled: boolean };
  sprints: {
    enabled: boolean;
    minItems: number;
    respectCapacity: boolean;
    autopilot: boolean;
  };
}

export type WebSearchProviderName = 'serper' | 'google_pse' | 'brave' | 'searxng' | 'custom_http';
export type LegacyWebSearchProviderName = 'duckduckgo';

export interface WebSearchCliKnobs {
  /** `duckduckgo` remains parseable only so legacy config gets a migration error. */
  provider?: WebSearchProviderName | LegacyWebSearchProviderName;
  maxResults?: number;
  serperApiKey?: string;
  google?: { apiKey?: string; cx?: string };
  braveApiKey?: string;
  searxngBaseUrl?: string;
  crawler?: {
    respectRobots?: boolean;
    maxContentChars?: number;
    maxHtmlBytes?: number;
    timeoutMs?: number;
    ratePerHostMs?: number;
    userAgent?: string;
  };
}

export interface ResolvedWebSearchKnobs {
  provider: WebSearchProviderName;
  configurationError?: string;
  maxResults: number;
  serperApiKey: string;
  google: { apiKey: string; cx: string };
  braveApiKey: string;
  searxngBaseUrl: string;
  crawler: {
    respectRobots: boolean;
    maxContentChars: number;
    maxHtmlBytes: number;
    timeoutMs: number;
    ratePerHostMs: number;
    userAgent: string;
  };
}

export interface ComputerUseCliKnobs {
  enabled?: boolean;
  mode?: string;
}

export interface RouterCliKnobs {
  /** Master switch. Default false keeps legacy direct-model behavior. */
  enabled?: boolean;
  /** Default true: use provider cachedModels as the pass-through catalog. */
  passThrough?: boolean;
  /** Ordered ModelRequests. Entry 0 is the Primary route. */
  chain?: string[];
  strategy?: 'priority' | 'round-robin' | 'free-first';
  /** Provider order for ambiguous bare-model resolution. */
  order?: string[];
  /** Virtual model names, including reserved tier aliases such as `tier:pro`. */
  aliases?: Record<string, string>;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  sessionAffinity?: boolean;
  serve?: boolean;
  serveHost?: string;
  servePort?: number;
  /** Write-only gateway bearer secret. Scrubbed before renderer snapshots. */
  serveKey?: string;
}

export interface ResolvedRouterCliKnobs {
  enabled: boolean;
  passThrough: boolean;
  chain: string[];
  strategy: 'priority' | 'round-robin' | 'free-first';
  order: string[];
  aliases: Record<string, string>;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  sessionAffinity: boolean;
  serve: boolean;
  serveHost: string;
  servePort: number;
  serveKey: string;
}

/**
 * PLUGIN-MARKETPLACE P2 — a marketplace source recorded in
 * `cli.plugins.marketplaces[]`. A marketplace is a repo/dir/tarball whose root
 * holds a `brainrouter-marketplace.json` indexing one or many plugins. Install-
 * by-name resolves a plugin across every configured marketplace.
 *
 * `sourceType` — `git` (clone/pull), `local` (a directory on disk), or `http`
 *   (a downloadable tarball, Phase 3+).
 * `source` — the git url / local path / http url.
 * `ref` — pinned git ref (branch/tag/commit).
 * `sparsePaths` — git sub-paths to check out (monorepo marketplaces).
 * `lastRevision` / `lastUpdated` — recorded by `marketplace update`.
 */
export interface MarketplaceSource {
  name: string;
  sourceType: 'git' | 'local' | 'http';
  source: string;
  ref?: string;
  sparsePaths?: string[];
  lastRevision?: string;
  lastUpdated?: string;
}

/**
 * PLUGIN-MARKETPLACE P1 — plugin subsystem knobs. A plugin is a thin
 * packaging + distribution wrapper that FEEDS the existing subsystems
 * (skills / agents / commands / hooks / mcp / connectors / workflows); no
 * parallel runtime. Everything here defaults OFF/inert so the feature is
 * additive + back-compat.
 *
 * `enabled` — per-plugin-name enable map (default `{}` = every installed
 *   plugin stays disabled until explicitly enabled). Resolved through both
 *   the USER scope (`~/.brainrouter/plugins/<name>/`) and the WORKSPACE scope
 *   (`<ws>/.brainrouter/plugins/<name>/`).
 * `registryUrl` — override the hosted registry index location (Phase 3).
 *   Empty/unset → the built-in BrainRouter-owned default. Also accepts a local
 *   file path (tests / air-gapped mirrors).
 * `marketplaces` — configured marketplace sources (P2). Empty (default) = no
 *   marketplaces; install-by-name has nothing to resolve against.
 *
 * PLUGIN-MARKETPLACE P3 — trust / consent / managed gating:
 * `approved` — per-plugin-name map of which risky capabilities the user has
 *   explicitly consented to. A plugin's hooks (`type: command`) and MCP
 *   command-servers stay DISABLED until `approved[name].shell` /
 *   `approved[name].mcp` is true. A skills/commands/agents-only plugin needs
 *   no elevated trust and loads on `enabled` alone. Default `{}` = nothing
 *   consented.
 * `allowedMarketplaces` — managed allowlist of marketplace names. Non-empty ⇒
 *   only these marketplaces may be added / resolved through. Empty = no allow
 *   restriction (mirrors `availableModels`).
 * `blockedMarketplaces` — managed denylist of marketplace names; any listed
 *   marketplace is refused regardless of the allowlist.
 * `allowManagedHooksOnly` — when true, a plugin's hook contributions are
 *   refused (never registered) — the managed-environment kill-switch for
 *   third-party hooks (mirrors CC's `allowManagedHooksOnly`).
 * Loading is SKIPPED entirely when `cli.safeMode` is on.
 */
export interface PluginCapabilityConsent {
  /** User consented to this plugin's command-type hooks (shell). */
  shell?: boolean;
  /** User consented to this plugin's MCP command-servers. */
  mcp?: boolean;
}

export interface PluginsCliKnobs {
  enabled?: Record<string, boolean>;
  registryUrl?: string;
  marketplaces?: MarketplaceSource[];
  /**
   * MC-E3 — extra JSON manifest filenames accepted while importing external
   * marketplaces/plugins. BrainRouter still writes only its canonical names.
   * Default [].
   */
  altManifestNames?: string[];
  approved?: Record<string, PluginCapabilityConsent>;
  allowedMarketplaces?: string[];
  blockedMarketplaces?: string[];
  allowManagedHooksOnly?: boolean;
  /** MC-E4 — surface org convention repositories as a read-only plugin/skill scope. Default false. */
  orgScope?: boolean;
  /**
   * PLUGIN-MARKETPLACE P5 — the community registry repo `brainrouter plugin
   * publish` opens a PR against (`owner/repo` or a git url). Empty/unset ⇒
   * `publish` writes the registry-entry JSON to stdout + a local file and prints
   * `gh` instructions instead of hard-requiring a repo.
   */
  publishRepo?: string;
  /**
   * PLUGIN-MARKETPLACE P5 — when true, a SESSION-START check compares installed
   * plugin versions against the hosted registry's `version`/`lastUpdated` and
   * surfaces an "updates available" notice. It NEVER auto-installs. Default
   * false (off) — additive + inert.
   */
  autoUpdateCheck?: boolean;
}

export interface SkillsCliKnobs {
  /**
   * MC-E1 — discover read-only convention repositories named `.brainrouter`
   * for the signed-in GitHub user and orgs, then load their skills/agents
   * through the existing contribution pipeline. Default false.
   */
  orgRepoDiscovery?: boolean;
}

/** Per-provider generation wire format. The two OpenAI shapes plus the native
 *  (non-OpenAI-compatible) Anthropic Messages and Gemini generateContent APIs.
 *  Native formats are opt-in via `cli.providerRequestFormat`. */
export type ProviderWireFormat = 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-generate';

export interface BudgetCliKnobs {
  /** Per-agent-task USD cap. 0 or absent means uncapped. */
  maxPerTaskUSD?: number;
  /** Per-agent-task token cap. 0 or absent means uncapped. */
  maxPerTaskTokens?: number;
}

/**
 * MC-B1 — `cli.triggers` block: the opt-in inbound webhook ingress
 * (`brainrouter serve --triggers`). Everything here is DEFAULT-DENY: the
 * listener never starts unless `enabled` is explicitly `true`, it binds
 * loopback unless the user names another host, unknown providers 404, and an
 * empty `allowedRepos` list means every event is accepted-but-dropped.
 * Signature verification is mandatory per provider — a missing secret means
 * every delivery for that provider is rejected (401), never "let through".
 */
/**
 * GitHub App credentials for the trigger bot (Phase 1 of the centralized-ingress
 * plan). When set, the trigger post-back authenticates as a single GitHub App
 * (`brainrouter[bot]`) using short-lived per-installation tokens instead of a
 * long-lived per-workspace PAT — one synced bot identity across repos. Absent =
 * the existing PAT path (`cli.track.githubToken` / `GITHUB_TOKEN`) still applies
 * (local-first default). The private key is sensitive: prefer `privateKeyPath`
 * (a file the process reads) over inlining the PEM, and in a hosted deployment
 * keep it in backend secret custody, never shipped to a desktop.
 */
export interface GithubAppCliKnobs {
  /** Numeric GitHub App ID (the JWT `iss`). */
  appId?: string;
  /** RSA private-key PEM, inline. Prefer `privateKeyPath` for real deployments. */
  privateKey?: string;
  /** Path to the RSA private-key PEM (read at token-mint time). */
  privateKeyPath?: string;
  /** Optional fixed installation id; when omitted it is resolved per owner/repo. */
  installationId?: string;
  /** GitHub Enterprise API base (default `https://api.github.com`). */
  apiBase?: string;
}

export interface TriggersCliKnobs {
  /** Master switch for the trigger ingress listener. Default false —
   *  nothing listens until the user opts in explicitly. */
  enabled?: boolean;
  /** Phase 1 — single GitHub App bot for the trigger post-back (installation
   *  tokens); falls back to the PAT path when unset. See {@link GithubAppCliKnobs}. */
  githubApp?: GithubAppCliKnobs;
  /** TCP port the ingress binds. Default 8787, clamped 1..65535. */
  port?: number;
  /** Interface the ingress binds. Default '127.0.0.1' (loopback) — exposing
   *  the listener beyond localhost is the user's explicit choice. */
  host?: string;
  /** GitHub webhook secret used to verify `X-Hub-Signature-256`. When empty,
   *  the secret is resolved from the workspace's GitHub connector config
   *  (`webhookSecret`); if neither is set, GitHub deliveries are rejected. */
  githubSecret?: string;
  /** Slack signing secret used to verify `X-Slack-Signature`. When empty,
   *  the secret is resolved from the workspace's Slack connector config
   *  (`signingSecret`); if neither is set, Slack deliveries are rejected. */
  slackSigningSecret?: string;
  /** GitLab webhook token used to verify `X-Gitlab-Token`. Empty rejects
   *  deliveries unless a GitLab connector supplies `webhookSecret`. */
  gitlabSecret?: string;
  /** Jira webhook signing secret used to verify webhook HMAC headers. Empty
   *  rejects deliveries unless a Jira connector supplies `webhookSecret`. */
  jiraSecret?: string;
  /** Glob allowlist of `owner/name` repos whose events are processed.
   *  Default [] = nothing allowed (events verify, then drop with a 202 that
   *  never leaks which repos exist). */
  allowedRepos?: string[];
  /** MC-B2 — the @mention handle the GitHub resolver reacts to in issue/PR/
   *  review comments. Default 'brainrouter'; a leading '@' is stripped. */
  mentionHandle?: string;
  /** MC-B4 — proactive CI-failure nudge. When true, a failed
   *  `workflow_run.completed` for an OPEN PR in an allowlisted repo gets ONE
   *  offer-to-fix comment (idempotent per head sha + workflow). Default
   *  false — the nudge never posts unless explicitly enabled. */
  ciNudge?: boolean;
}

/**
 * The signed-in BrainRouter account as it is stored under `cli.account`. Typed
 * here because core now READS it: ADR-032 D8 keys the learned store on
 * `(org_id, user_id)`, and this is the only place either id exists on a client.
 *
 * Who actually writes it, because the partition is only as good as its writer:
 *
 * - **`userId`** (with `url`/`displayName`/`email`) — the DESKTOP sign-in, at its
 *   credential commit point.
 * - **`orgId`** — the desktop workspace switcher, on the settled selection. It is
 *   deliberately not captured at sign-in: the active org is a later choice the
 *   user can change, and a value frozen at sign-in would be wrong from the first
 *   switch onward.
 * - **The CLI writes NEITHER.** `brainrouter login` saves a server profile and an
 *   API key; the brain resolves the user from that key server-side, so the CLI
 *   never learns its own ids. A CLI-only install therefore learns into the
 *   personal partition — which is the safe direction, not an accident, but it is
 *   the reason this comment does not say "both surfaces write it".
 *
 * Deliberately excludes the credential fields the desktop also stores under this
 * block — secrets are write-only (`scrubCliSecrets`), and a type that names them
 * invites a reader.
 */
export interface CliAccountIdentity {
  /** Account API base the profile was issued by. */
  url?: string;
  /** Stable account id. Absent on a personal install that never signed in. */
  userId?: string;
  /** Active organization. Absent means personal, never "any org". */
  orgId?: string;
  displayName?: string;
  email?: string;
}

export interface CliKnobs {
  /** Who is signed in. See `CliAccountIdentity`. */
  account?: CliAccountIdentity;
  // ---- planning / orchestration -----------------------------------------
  /**
   * NEXT-ACTION PLANNER (0.4.7). Default 'on'. A focused pre-flight reasoning
   * call that decides the turn's strategy (answer-direct / investigate /
   * fan-out / workflow) and concrete subtasks, then injects a decisive
   * directive — replacing the keyword-only breadth hint. 'off' falls back to
   * the breadthHint heuristic. Skipped for trivial prompts regardless.
   */
  nextActionPlanner?: 'on' | 'off';
  /**
   * CC-P3.2 (0.4.15). Declarative tool-permission rules. Patterns are
   * `tool` or `tool(glob)` matched against the call's primary argument
   * (run_command→command, file tools→path, fetch_url→url). A deny match
   * blocks the call outright; an allow match downgrades an `ask` to
   * `allow` (never overrides a mode-based deny).
   */
  permissions?: { allow?: string[]; deny?: string[] };
  /** Default-off Requirement → Plan → Track automation controls. */
  automation?: AutomationKnobs;
  /** User-declared external CLI agents. Empty by default; no bundled binaries. */
  agents?: { hosted?: HostedAgentConfig[] };
  // ---- memory / briefing -------------------------------------------------
  /** Default 'gated'. Recall trigger mode — see briefingTriggers.ts. */
  recallMode?: 'always' | 'gated' | 'off';
  /** Default 'on'. Pin first-turn briefing into the cache-stable prefix. */
  prefixMemoryAnchors?: 'on' | 'off';
  /**
   * Default 'on'. Pin the brain's distilled Core Identity
   * (`memory_persona`) into the cache-stable briefing prefix. Set
   * 'off' to suppress persona injection without deleting the
   * underlying `core_identity` row. The `/persona on|off` runtime
   * toggle is a per-workspace preference layered on top of this.
   */
  personaAnchor?: 'on' | 'off';
  /**
   * Optional user-wide communication-style default. Workspace and chat
   * overrides remain higher precedence; omitted lets the workspace profile
   * recommend a style.
   */
  personalityDefault?: 'concise' | 'standard' | 'detailed' | 'pair-programmer' | null;
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
  /** Enable reversible statistical compression for large tool outputs. Default false. */
  toolOutputCompressionEnabled?: boolean;
  /** Minimum tool-output size eligible for reversible compression. Default 2000. */
  toolOutputCompressionMinChars?: number;
  /** Fraction of JSON-array entries retained by reversible compression. Default 0.2. */
  toolOutputCompressionTargetKeep?: number;
  /** Lower high effort for non-error tool-result continuation turns. Default off. */
  effortRoutingMode?: 'adaptive' | 'off';
  /** Effort selected for adaptive mechanical continuation turns. Default low. */
  effortForToolResumeTurns?: 'low' | 'medium';
  /** Tail prompt steering level for concise output. 0 disables it. */
  verbositySteeringLevel?: 0 | 1 | 2 | 3 | 4;

  // ---- tool-call repair pipeline ----------------------------------------
  /** Sliding window for the storm-breaker. Default 6. */
  stormWindow?: number;
  /** Storm threshold — Nth identical call inside the window is suppressed. Default 4. */
  stormThreshold?: number;
  /** Hard cap on inner-loop iterations per user turn. Default 60. */
  maxToolLoops?: number;
  /**
   * HONK-L1/L7 — the local-model bounded-harness profile. `'auto'` (default)
   * clamps the turn-loop caps (maxToolLoops, repeat/storm guards, MCP-tool budget,
   * spawn depth) only for positively-identified small/local model families;
   * `'on'` always clamps; `'off'` never does. A tight bounded harness is what makes
   * weak local models reliable — strong/unknown models are passed through untouched.
   */
  localModelProfile?: 'auto' | 'on' | 'off';
  /** Threshold for the repeat-SEQUENCE guard (tool-name pattern repeats,
   *  ignoring args). Default 12. */
  repeatToolSequenceLimit?: number;
  /**
   * Tools EXEMPT from the repeat-sequence guard — repeating these with DIFFERENT
   * args is productive work, not a loop (writing 10 different files). The
   * identical-args loop guard (`repeatLoopLimit`) + storm breaker still catch
   * the pathological same-args case. Default: the mutation tools.
   */
  repeatSequenceExemptTools?: string[];
  /** Threshold for the identical-(name,args) repeat-LOOP guard — the real
   *  doom-loop catcher. Default 3. */
  repeatLoopLimit?: number;
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
  /** Per-call LLM timeout in ms. Default 120000. A timeout is treated as a
   *  RECONNECT signal (not a hard failure) — see `llmMaxReconnects`. */
  llmTimeoutMs?: number;
  /** Provider-router v2. Default-inert; absent/disabled preserves legacy behavior. */
  router?: RouterCliKnobs;
  /**
   * RECONNECT (0.4.12) — max reconnect attempts for a transient LLM failure
   * (timeout / disconnect / 5xx / 429) before giving up, with exponential backoff
   * that honors `Retry-After`. Default 5. While the machine is genuinely OFFLINE
   * the loop keeps waiting for the link WITHOUT spending this budget, so a dropped
   * connection auto-resumes when the network returns rather than failing the turn.
   */
  llmMaxReconnects?: number;
  /** Max concurrent LLM calls across parent + children. Default 4. */
  llmMaxConcurrent?: number;
  /** Disable streaming (SSE). Default false. */
  disableStream?: boolean;
  /**
   * WF-COST-GATE — confirm before any agent runs a WORKFLOW (`run_workflow`).
   * Workflows fan out many child agents and cost far more tokens than a plain
   * spawn, so this gate is ALWAYS-ON by default (independent of /mode, /yolo,
   * and /delegation-policy) for parents AND silent children/workers. Set to
   * `false` to let autonomous / headless runs launch workflows without asking.
   * Default true.
   */
  confirmRunWorkflow?: boolean;
  /** Reasoning depth preference override (`/effort`). Default 'medium'. */
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** PARITY-E3 — model to fall back to when the primary model is unavailable. */
  fallbackModel?: string | null;
  /**
   * CC-CONFIG-A2 — ORDERED fallback chain (up to 3) tried in sequence when the
   * primary model is unavailable (model-not-found / retryable provider error).
   * Supersedes the single `fallbackModel` (which stays honored, appended last for
   * back-compat). Empty/absent (default) = no chain; only `fallbackModel` applies.
   */
  fallbackModels?: string[];
  /**
   * CC-CONFIG-A3 — the set of models this install may use. Empty/absent (default)
   * = no restriction. When `enforceAvailableModels` is true a model outside this
   * list is rejected at agent init AND Fast-mode refuses to switch to it.
   */
  availableModels?: string[];
  /** CC-CONFIG-A3 — when true, reject any model not in `availableModels`. Default false. */
  enforceAvailableModels?: boolean;
  /**
   * MC-D3 — NAMED LLM PROFILES: reusable model presets layered over the base
   * `llm` config. A profile carries a model (required) plus an optional
   * endpoint / reasoning depth / Fast-mode preference. `/profile use <name>`
   * (or `cli.activeLlmProfile`) overlays one onto the base LLM at boot, and —
   * when 2+ profiles exist — the agent is offered a `switch_model` tool so it
   * can move itself to a stronger/cheaper preset mid-task (the explicit
   * sibling of the first-line tier self-escalation marker). Empty/absent
   * (default) = feature inert: no overlay, no tool.
   */
  llmProfiles?: Record<string, LlmProfileConfig>;
  /**
   * MC-D3 — name of the profile overlaid on the base `llm` config at startup.
   * Must name an entry in `llmProfiles`; unknown/blank (default) = no overlay.
   */
  activeLlmProfile?: string;
  /**
   * CC-CONFIG-A4 — semver range gate against the running BrainRouter version
   * (`packages/core/src/version`). When the current version is BELOW
   * `requiredMinimumVersion` or ABOVE `requiredMaximumVersion` a warning is
   * surfaced at startup; when `enforceVersionRange` is true it refuses to run.
   * Empty/absent (default) = no version gate.
   */
  requiredMinimumVersion?: string;
  requiredMaximumVersion?: string;
  /** CC-CONFIG-A4 — refuse (vs warn) when outside the required version range. Default false. */
  enforceVersionRange?: boolean;
  /**
   * CC-CONFIG-A1 — SAFE MODE (troubleshooting). When true, the agent boots WITHOUT
   * memory briefing, skills, lifecycle hooks, and custom (non-brain) MCP servers —
   * a minimal harness to isolate a misbehaving briefing/skill/hook/MCP. Also
   * settable per-launch via `--safe-mode` / `BRAINROUTER_SAFE_MODE`. Default false.
   */
  safeMode?: boolean;
  /**
   * ADR-027 D2 — which execution engine drives a turn.
   *
   * `loop` (default) is the established turn loop. `graph` runs the typed
   * graph executor: conditional routing, checkpoints folded after each node,
   * and human-in-the-loop interrupts that resume at the SUCCESSOR of the
   * interrupting node.
   *
   * Both ship, and the choice is a setting rather than a migration, because
   * the two are good at different things. The loop is better for open-ended
   * conversational work where the next step genuinely depends on what the
   * model just said. The graph is better for work with a known shape that
   * must survive interruption — review pipelines, migrations, anything where
   * "resume exactly once, after the effect that already happened" matters.
   * Replacing one with the other would trade a real strength for a different
   * real strength; carrying both costs a branch at dispatch.
   */
  executionEngine?: 'loop' | 'graph';
  /**
   * ADR-028 H3 — how eagerly a change becomes a stacked pull request.
   *
   * `auto` advises (plan shape, or diff size + separability); `always` stacks
   * whenever the plan permits it; `never` opts out. Defaults to `auto`, because
   * someone who has never used stacks should not have their first pull request
   * silently become one.
   */
  stackingMode?: 'auto' | 'always' | 'never';
  /**
   * ADR-028 F7 — the comprehension review, which runs as a SUBAGENT.
   *
   * Writing questions about consequences and rejected alternatives needs a
   * model reasoning over what it just built; a renderer heuristic would produce
   * the trivia F7 refuses by name. `off` hides the panel entirely, because a
   * surface that cannot do its job is worse than no surface.
   */
  comprehension?: {
    enabled?: boolean;
    /** Blank uses the session model. */
    model?: string;
    /** 3–7. Above that it is homework, not a review. */
    questions?: number;
  };
  /**
   * ADR-028 I1 — whether missing tooling installs itself on startup.
   *
   * `safe` (default) installs only what changes nothing outside the tool's own
   * extension directory; `off` detects and offers without installing.
   */
  autoInstallTools?: 'off' | 'safe';
  /**
   * CC-CONFIG-A5 — provenance/attribution controls for generated commit + PR bodies.
   * `sessionUrl` (default true): include the BrainRouter provenance/session footer.
   * Set false to omit it (private repos / clean history).
   */
  attribution?: { sessionUrl?: boolean };
  /**
   * CC-CONFIG-A6 — hide BUNDLED skills (those shipping with the BrainRouter
   * install) from skill listings, leaving only workspace-authored skills
   * (`skills/`, `.brainrouter/skills`). Also settable via
   * `BRAINROUTER_HIDE_BUNDLED_SKILLS`. Default false.
   */
  skillsHideBundled?: boolean;
  /** MC-E1 — skills/agents discovery controls. Defaults inert. */
  skills?: SkillsCliKnobs;
  /**
   * CC-SKILLS-D1 — max number of leading `/skill` tokens that a single prompt
   * may stack (`/a /b do X` composes a.SKILL.md then b.SKILL.md before the
   * user input). Hard-capped at 5 in the resolver regardless of config so a
   * runaway prompt can't compose an unbounded instruction block. Default 5.
   */
  skillsStackMax?: number;
  /**
   * MC-E2 — keyword-triggered JIT skill injection. When a SKILL.md declares
   * `triggers: [word, ...]` (or `keywords:`) in its frontmatter, a plain user
   * prompt containing one of those words (case-insensitive, word-boundary
   * match) injects that skill's body into the turn exactly like an explicit
   * /skill invocation, alongside the recall-prewarm path. Default true —
   * additive: nothing ever fires unless a skill declares triggers. Set false
   * to disable the hard keyword→inject path entirely.
   */
  skillsKeywordTriggers?: boolean;
  /**
   * CC-UX-E2 — render GFM task-list items (`- [ ]` / `- [x]`) as checkbox
   * glyphs (☐ / ☑) in the CLI markdown renderer instead of the literal
   * `[ ]` / `[x]` text. Default true (a pure display nicety; the underlying
   * markdown is unchanged). Set false to preserve the raw brackets.
   */
  markdownCheckboxes?: boolean;

  // ---- MCP plumbing -----------------------------------------------------
  /** MCP call timeout in ms. Default 60000. */
  mcpTimeoutMs?: number;
  /**
   * REMOTE-BRAIN (Workstream A, ADR-005) — point the active BrainRouter brain at
   * a remote Streamable-HTTP endpoint instead of the embedded/stdio default.
   * When set, the active `brainrouter` profile is rewritten to
   * `{ type: 'http', url: brainUrl }` at connect time (its `apiKey`/`headers`
   * are preserved; the brain's HTTP transport requires a Bearer API key). Unset
   * (the default) keeps the embedded brain — no behaviour change.
   */
  brainUrl?: string | null;

  // ---- approval / sandbox / spawn --------------------------------------
  /** Sandbox engine. Default 'off'. */
  sandbox?: 'off' | 'on';
  /** Extra read-only paths granted to sandboxed run_command. */
  sandboxReadPaths?: string[];
  /** Extra write-allowed paths granted to sandboxed run_command. */
  sandboxWritePaths?: string[];
  /** Allow outbound network from the sandbox. Default false. */
  sandboxNetwork?: boolean;
  /**
   * CODEX-SANDBOX-FAILCLOSED (0.4.7) — what to do when `sandbox: 'on'` but no
   * sandboxer is available on this platform (Linux without bwrap/firejail,
   * Windows, etc.). `'deny'` (default) refuses to run rather than silently
   * running unsandboxed; `'ask'` requires approval (fails closed where no
   * approver exists, e.g. silent children); `'warn'` runs unsandboxed with a
   * notice (the pre-0.4.7 behavior — opt back in explicitly).
   */
  sandboxUnavailable?: 'ask' | 'deny' | 'warn';
  /**
   * CODEX-SANDBOX-UNATTENDED (0.4.15) — force the sandbox ON for silent /
   * unattended agents (cloud workers, spawned children, non-interactive runs)
   * even when `cli.sandbox` is `'off'`. When enforced, outbound network is
   * denied and a missing sandboxer fails closed (`sandboxUnavailable: 'deny'`),
   * regardless of the looser interactive settings. Default `true` — an
   * operator must opt OUT explicitly to let unattended shells run unsandboxed.
   * Mirrors `cli.hooks.enforceWhenSilent`: relaxed when a human is watching,
   * strict when nobody is.
   */
  sandboxEnforceWhenSilent?: boolean;
  /**
   * HONK-H0 — scrub secret-shaped environment variables (API_KEY/*_TOKEN/*_SECRET
   * names, sk-/br_/gh*_ values) from an ENFORCED (unattended / fleet) shell's
   * environment, so a compromised background child can't exfiltrate the host's
   * keys via `printenv`. Default `true`. Only affects enforced runs; interactive
   * shells are untouched. Allowlist specific vars a job legitimately needs with
   * `cli.jobSecretAllowlist`.
   */
  jobSecretScoping?: boolean;
  /** HONK-H0 — env var NAMES an enforced shell may keep despite secret scoping. */
  jobSecretAllowlist?: string[];
  /**
   * CODEX-EXEC-POLICY (0.4.7) — command prefixes the user pre-approves, so a
   * `run_command` whose every segment matches one auto-approves without a prompt
   * in any mode (e.g. `git status`, `npm test`). Prefixes match on a word
   * boundary. Over-broad prefixes (bare `git`/`bash`/`sudo`/…) are rejected by
   * CODEX-APPROVAL-GUARD. Default empty = no change to approval behavior.
   */
  commandAllowlist?: string[];
  /**
   * CC-SAFETY-B1 — route EVERY `run_command` / shell call through the safety
   * classifier (the destructive-command guard + the approval resolver) via a
   * pre-tool gate, not just the ones that happen to hit a heuristic:
   *   - `'off'`    (default) — no extra gate; existing behavior unchanged.
   *   - `'on'`     — classify every shell call; a destructive/dangerous verdict
   *                  asks (attended) or is denied (silent) as usual.
   *   - `'strict'` — DENY every shell call unless it matches `commandAllowlist`
   *                  (the whitelist). The strictest posture for unattended runs.
   * Honors `enforceWhenSilent` (see `autoClassifyShellEnforceWhenSilent`): when a
   * human is watching, `'on'`/`'strict'` may relax to advisory; when nobody is,
   * the classification is enforced.
   */
  autoClassifyShell?: 'off' | 'on' | 'strict';
  /**
   * CC-SAFETY-B1 — enforce `autoClassifyShell` even in a silent/unattended
   * session (default `true`, mirroring `hooks.enforceWhenSilent`). When `false`,
   * an attended session may downgrade a classifier deny to an advisory prompt.
   */
  autoClassifyShellEnforceWhenSilent?: boolean;
  /**
   * CODEX-WORKTREE-ISOLATION — filesystem isolation for spawned write/shell
   * children. Default `auto`: creates a detached git worktree when the parent
   * workspace is inside a git repo, and falls back to the shared root otherwise
   * (so it never breaks a non-git workspace). On a child's CLEAN completion its
   * changes are merged back onto the parent tree (CODEX-WORKTREE-MERGEBACK) — a
   * patch that doesn't apply cleanly is preserved for manual `git apply` instead
   * of smearing conflict markers. `git-worktree` is the strict variant (errors
   * if worktree creation fails); `off` preserves the legacy shared-root behavior
   * (children edit the parent tree directly). Read-only children always share
   * the parent root.
   */
  childWorkspaceIsolation?: 'off' | 'auto' | 'git-worktree';
  /**
   * A5.1 (0.4.11) — base directory for child-agent git worktrees. Empty (default)
   * = `<BRAINROUTER_HOME>/worktrees` (i.e. `~/.brainrouter/worktrees`). Set an
   * absolute path to relocate them onto a fast/scratch disk or outside backups.
   * Replaces the old `$TMPDIR/brainrouter-worktrees` location.
   */
  worktreeRoot?: string;
  /**
   * BUILD-LOOP P3 (0.4.12) — when the next-action planner may escalate a coding
   * request into the plan→implement→verify→review→merge `build` workflow.
   * `off` = never auto-escalate (the loop only runs via the explicit `/build`
   * command); `escalate` (default) = the planner routes multi-file / feature-scale
   * implementation tasks into the build loop, single edits stay single-agent;
   * `always` = any implementation request (even a one-file change) runs the loop.
   */
  buildLoop?: 'off' | 'escalate' | 'always';
  /**
   * BUILD-LOOP P2.5 (0.4.12) — extend the build loop's pre-merge review gate to
   * ad-hoc isolated write-children. `off` (default) = an isolated `/spawn worker`
   * merges its clean changes back automatically (0.4.11 behavior). `on` = the
   * child's changes are HELD as a reviewable recovery patch instead of
   * auto-merging, so even a one-off delegated worker is reviewed (via
   * `/agents diff <id>`) and applied explicitly (`/agents diff <id> apply`) before
   * anything lands in your tree. (Build-loop fan-out slices are always held +
   * gated regardless of this knob.)
   */
  worktreeMergeReview?: 'off' | 'on';
  /**
   * BUILD-LOOP P5 (0.4.12) — bounded loop-until-green build self-repair. `0`
   * (default) = DISABLED: a `/build` whose Verify is red preserves the work as a
   * recovery patch (no retry), the 0.4.12 P2 behavior. `> 0` = OPT-IN: when Verify
   * comes back red, re-run Implement→Verify→Review in the SAME shared worktree —
   * feeding the verifier's failure back to the worker — up to this many times, then
   * stop on the first green verify (or give up + preserve the patch). Single-worktree
   * builds only; fan-out builds are not retried.
   */
  buildLoopMaxRepairs?: number;
  /**
   * HONK-H1 (0.4.x) — deliver a successful build loop's work as a GitHub Pull
   * Request instead of merging it into your working tree. `false` (default) =
   * 0.4.12 behavior (verify-green + review-ok → patch applied to your tree).
   * `true` = OPT-IN Honk model: the work is committed on a fresh `honk/<slug>-<hash>`
   * branch in an isolated worktree, pushed, and opened as a PR via the GitHub CLI
   * (`gh`) — your working tree is never touched. Requires `gh` installed +
   * authenticated and a GitHub `origin`; if any of that is missing the run falls
   * back to the normal merge-back so work is never lost. Single-worktree builds
   * only (fan-out builds always hold slices for manual synthesis).
   */
  buildLoopEmitPr?: boolean;
  /**
   * HONK-H1 — base branch for the emitted PR. Empty (default) = the repo's current
   * branch (the branch the build started from). Set to target a fixed integration
   * branch (e.g. `main`).
   */
  buildLoopPrBaseBranch?: string;
  /**
   * HONK-H1 — open the emitted PR as a DRAFT (default true) so a human reviews
   * the agent's work before it can merge. Set false to open ready-for-review PRs.
   */
  buildLoopPrDraft?: boolean;
  /**
   * MC-D1 — optional build-loop CRITIC gate. Disabled by default (zero behavior
   * change). When enabled, after a `/build` run's Verify passes, a cheap-tier
   * LLM critic scores P(task actually complete) ∈ [0,1] with a structured
   * diagnostic taxonomy; a score below `threshold` feeds the diagnostics back
   * as bounded refinement rounds (reusing the build loop's repair mechanics,
   * at most `maxRefinementIterations`), then the merge gate proceeds with the
   * best-scored result. The final score/diagnostics are recorded on the run.
   */
  critic?: {
    /** Master switch. Default false. */
    enabled?: boolean;
    /** Acceptance score in [0,1]. Default 0.7. */
    threshold?: number;
    /** Max refinement rounds when below threshold. Default 2 (clamped 0..8). */
    maxRefinementIterations?: number;
    /** Explicit critic model. Empty (default) = the per-role model config
     *  (`agentModels.critic`, falling back to the session model). */
    model?: string;
  };
  /** Hard per-agent-task budget. Both caps default to 0, meaning uncapped. */
  budget?: BudgetCliKnobs;
  /** PARITY-W3 — ring the terminal bell on an idle background-completion notice. Default false. */
  notifyBell?: boolean;
  /** Child-drain timeout in ms. Default 30000. */
  childDrainTimeoutMs?: number;
  /** MEM-22: working-offload result-cache retention in ms. Default 1_800_000 (30m). */
  offloadRetentionMs?: number;
  /** MEM-22: max cached offload results before the reclaimer evicts the least-recently-used. Default 64. */
  offloadMaxEntries?: number;
  /** Maximum spawn depth. Default 3. */
  maxSpawnDepth?: number;
  /**
   * CODEX-AGENT-LIFECYCLE (0.4.7) — cap on concurrently-live child agents
   * (spawn slots). Spawning beyond this is refused until a child finishes,
   * preventing unbounded fan-out + orphan drift. `0` disables the cap.
   * Default 8.
   */
  maxConcurrentChildren?: number;
  /**
   * HONK-H3 — shared GLOBAL concurrency cap for the fleet runner: the most fleet
   * jobs that drain at once across ALL workspaces (vs `maxConcurrentChildren`,
   * which is per-parent-session). `0` disables the cap. Default 4.
   */
  fleetMaxConcurrentJobs?: number;
  /** MAS-P4-T4: max auto-chain follow-up agents per worker. Default 2. */
  autoChainMaxFollowups?: number;
  /** MAS-P4-T1: cap on MCP tools shown to an agent per turn (0 = no cap). Default 16. */
  agentMcpToolBudget?: number;
  /** §5.4: collapse the per-turn MCP tool list to discovery entry points
   *  (mcp_search / mcp_describe / mcp_call) to save context on large catalogs.
   *  Default false (full catalog shown, capped by agentMcpToolBudget). */
  mcpProgressiveDiscovery?: boolean;

  // ---- scheduling / tracing / search -----------------------------------
  /** Background ticker interval for /schedule jobs in ms. Default 30000. */
  scheduleTickMs?: number;
  /** Path to the OTEL-flavored JSONL trace file. Unset = no tracing. */
  traceLog?: string;
  /**
   * AUG-A4: where trace events go. `stdout-jsonl` (default) appends to
   * `traceLog`; `otel` / `langsmith` / `langfuse` best-effort POST each
   * event (vendor-shaped) to `tracingEndpoint`. config.json only — never
   * an env var (0.3.9 knob policy).
   */
  tracingBackend?: 'stdout-jsonl' | 'otel' | 'langsmith' | 'langfuse';
  /** AUG-A4: ingest URL for non-jsonl tracing backends. */
  tracingEndpoint?: string;
  /** AUG-A4: bearer/API key for the tracing backend (if it needs one). */
  tracingApiKey?: string;
  /** Override the web_search tool's endpoint URL (when not using the brain default). */
  webSearchEndpoint?: string;
  /** Provider-backed web_search plus crawler defaults. */
  webSearch?: WebSearchCliKnobs;
  /** Native desktop computer-use tool. Default off; desktop host only. */
  computerUse?: ComputerUseCliKnobs;

  /** PLUGIN-MARKETPLACE P1 — plugin enable map + registry override. Default
   *  `{ enabled: {} }` (nothing enabled). Skipped entirely under `safeMode`. */
  plugins?: PluginsCliKnobs;

  // ---- runtime plane (MC-A1) --------------------------------------------
  /** Which runtime backend hosts agent conversations. Default
   *  `{ backend: 'process', maxLive: 0 }` — exactly today's in-process
   *  behavior; isolated backends are strictly opt-in. */
  runtime?: RuntimeCliKnobs;

  // ---- trigger ingress (MC-B1) ------------------------------------------
  /** Inbound webhook ingress (`brainrouter serve --triggers`). Default
   *  `{ enabled: false }` — nothing listens until the user opts in. */
  triggers?: TriggersCliKnobs;

  // ---- tier escalation --------------------------------------------------
  /** Tier ladder override — when set, beats the provider built-in. */
  tierLadder?: { flash?: string; standard?: string; pro?: string };

  // ---- tool-output context compaction ----------------------------------
  /** Enable the heuristic tool-output compactor. Default true. */
  contextCompaction?: boolean;

  // ---- update notice (CLI-22) -------------------------------------------
  /** Show a throttled "update available" notice at startup. Default true. */
  updateCheck?: boolean;

  // ---- policy hardening (POLICY-3) --------------------------------------
  /** How to treat file writes outside the workspace root. Default 'ask'. */
  externalDirWrites?: ExternalDirMode;
  /** Per-host outbound allowlist for fetch_url / web_search ([] = unrestricted). */
  egressAllowlist?: string[];

  // ---- edit→verify loop (CLI-18) ----------------------------------------
  /** Command run after a file write; failures are fed back to the model.
   *  `{file}` is substituted with the edited path. Empty = off. */
  postEditCheck?: string;

  // ---- auto skill extraction (MEM-33b) ----------------------------------
  /** After a successful multi-step turn, fire-and-forget distil a reusable
   *  skill (memory_extract_skill). Off by default (one LLM call per turn). */
  autoExtractSkills?: boolean;

  // ---- offline replay (CLI-21b) -----------------------------------------
  /** On launch, auto-replay prompts that were queued while offline (once
   *  reconnected). Default true. */
  autoReplayOffline?: boolean;

  // ---- browser verification (VERIFY-BROWSER) ---------------------------
  /** Shell command template for `/verify browser` — runs a browser smoke
   *  test and writes artifacts (screenshots / video / console+network logs)
   *  into a run directory. `{url}` and `{out}` are substituted. Empty = off.
   *  Infrastructure-agnostic: wire Playwright / puppeteer / a Chrome
   *  DevTools MCP harness — whatever produces files in `{out}`. */
  browserSmoke?: string;

  // ---- automatic code-index freshness (CLI-REINDEX) --------------------
  /** Keep the brain's code index fresh by calling memory_reindex_source from
   *  the file read/edit paths (stat-gated to skip unchanged files; a no-op
   *  brain-side when content matches). Skipped while MCP is offline and for
   *  non-code files. Default true. */
  autoReindex?: boolean;

  // ---- LSP semantic navigation (CLI-19) ---------------------------------
  /** language → server launch command for the `lsp` tool, e.g.
   *  { "typescript": "typescript-language-server --stdio" }. Merged over the
   *  built-in defaults; set "" to disable a language. */
  lspServers?: Record<string, string>;

  // ---- code-mode global prompt prefix (§5.7) ----------------------------
  /** Prepended to the system prompt in Code mode — a durable house-style /
   *  guardrail block applied to every code-mode turn. Empty = none. */
  codePromptPrefix?: string;

  // ---- customizable keyboard shortcuts (§5.9) ---------------------------
  /** Desktop shortcut overrides: action id → chord string (e.g. {"save":"Cmd+S"}).
   *  Resolved through ui/shortcuts.ts over the built-in defaults. */
  shortcuts?: Record<string, string>;

  // ---- orchestration ----------------------------------------------------
  /**
   * Default parent wait timeout for child-agent tools in ms. Default **0 = wait
   * until completion**. This does not kill the child; child execution is bounded
   * by `maxToolLoops`, per-call LLM/MCP/shell timeouts, and reconnect handling.
   * Set a positive value only when the parent should stop waiting and return a
   * timeout envelope while the child keeps running.
   */
  childAgentTimeoutMs?: number;
  /** Character budget for the in-REPL child-agent result preview. Default 2500. */
  agentPreviewChars?: number;

  // ---- diagnostics ------------------------------------------------------
  /** Verbose beforeExit/exit tracing — default false. */
  debugExit?: boolean;

  // ---- workspace override (used by --workspace flag) -------------------
  /** Workspace root override (normally set by the --workspace CLI flag). */
  workspaceOverride?: string;

  /**
   * 0.4.15 — cap on COMPLETION tokens per LLM call (`max_tokens` on the wire).
   * Unset (default) sends no cap, so the provider's own default applies — but
   * some endpoints (e.g. certain fast/cheap models) default to a LOW cap that
   * truncates long answers mid-sentence. Set this to lift that cap, e.g. 8192.
   */
  maxOutputTokens?: number;

  // ---- telemetry ---------------------------------------------------------
  /**
   * 0.4.15 — local-first, privacy-conscious telemetry for task/workflow
   * lifecycle, plan revision, review, uploads, memory capture, git/workspace
   * refresh, errors, and latency. Local JSONL only (no network); stores only
   * metadata/counters/latency, never message or file content. `enabled`
   * defaults TRUE; set `{ "telemetry": { "enabled": false } }` under `cli` in
   * config.json to turn it off entirely.
   */
  telemetry?: { enabled?: boolean };
  /**
   * Global GitHub settings shared by every GitHub surface (connector ingest,
   * Track sync, gh CLI wrappers). `caBundle` is a trusted-certificate path for
   * corporate TLS interception (passed to gh as SSL_CERT_FILE — moved here from
   * `track.githubCaBundle`, which remains a read fallback). `oauthClientId`
   * overrides the OAuth device-flow app id (GitHub Enterprise / self-registered
   * apps; connector Phase 2).
   */
  github?: { caBundle?: string; oauthClientId?: string };
  /**
   * TRACK external sync (0.4.15). GitHub Issues bridge config. `repo` is
   * "owner/name"; `token` is a PAT with `repo`/`issues` scope (falls back to
   * the standard `GITHUB_TOKEN` / `GH_TOKEN` env when omitted, like the gh
   * CLI). Read on demand by the `/track sync` command + desktop Sync panel.
   */
  track?: {
    githubRepo?: string;
    githubToken?: string;
    /** Multiple GitHub repositories available to Track sync. */
    githubRepos?: Array<{ repo: string; token?: string; label?: string }>;
    /** Repo from `githubRepos` used by default when a command omits `--repo`. */
    activeGithubRepo?: string;
    /** Optional trusted CA bundle path passed through to GitHub CLI commands. */
    githubCaBundle?: string;
    /**
     * BR-123 commit scanner (0.4.16). `enabled` (default false): on `/track sync
     * --commits`, parse `<KEY>-<n>` from recent commit messages and link each
     * commit to its work item + advance todo → in-progress. `scanDepth` caps the
     * history walked (default 50).
     */
    commitScanner?: { enabled?: boolean; scanDepth?: number };
  };
  /**
   * Lifecycle shell hooks (0.4.16). `enabled` (default true) is the master
   * switch. `enforceWhenSilent` (default true) runs the BLOCKING hook events
   * (pre-tool, user-prompt-submit) for silent/unattended agents too — deep
   * workers, headless, and cloud runs — so a deny hook enforces policy
   * regardless of who is driving. Advisory events (post-tool, pre/post-turn)
   * stay interactive-only.
   */
  hooks?: { enabled?: boolean; enforceWhenSilent?: boolean };
  /**
   * PER-PROVIDER WIRE-FORMAT OVERRIDE. Maps `providerId` (as stored in
   * `llm.provider`, lowercased) → the wire format to use for that provider's
   * requests. Use when a custom OpenAI-compatible gateway supports the
   * `/v1/responses` API even though BrainRouter's built-in catalog default
   * (chat-completions) doesn't recognize it — or to force chat-completions
   * on canonical OpenAI while debugging a Responses shape regression.
   *
   * SEMANTICS — an explicit override BYPASSES the canonical-endpoint safety
   * gate. The resolver trusts the user's assertion that their endpoint
   * accepts `/v1/responses`, including gateway model ids that do not look
   * like OpenAI-native ids (for example `google/gemma-4-12b`). A gateway
   * that 404s on `/responses` (most OpenRouter/LiteLLM/vLLM gateways only
   * proxy `/chat/completions`) will only fail at the actual HTTP call.
   * Built-in defaults remain conservative and still apply the canonical
   * endpoint + model-shape gates when no explicit override is present.
   *
   * Values are validated against `'responses' | 'chat-completions'` (typos
   * such as `'response'` or `'Responses'` are silently dropped so the
   * resolver stays fail-safe). Keys are case-insensitive and trimmed.
   * Set under `cli` in `~/.config/brainrouter/config.json`.
   * Example: `{ "lmstudio": "responses", "opencode": "chat-completions" }`.
   *
   * CAVEAT — `setCliKnobOverride({ providerRequestFormat: {...} })` SHALLOW-
   * REPLACES the whole map (consistent with how every other top-level knob
   * on `ResolvedCliKnobs` works), so an argv override that targets one
   * provider key will wipe config-file entries for the others. For multi-
   * key sets, edit `config.json` directly; in-process overrides are for
   * single-key tests/scripts.
   */
  providerRequestFormat?: Record<string, ProviderWireFormat>;
  /**
   * Per-tool enable/disable overrides (keyed by tool name; MCP tools use their
   * `mcp_<server>_<tool>` namespaced name). `true` force-ENABLES a tool the agent
   * would otherwise hide (e.g. a built-in hidden by the local-model L2 allowlist,
   * or an MCP tool trimmed by the relevance budget); `false` force-DISABLES it.
   * A PROTECTED core tool (lifecycle + file/shell — see `tool/toolPolicy.ts`)
   * ignores `false` and is always shown. Overrides never bypass the HARD gates
   * (access tier, worker-thread/computer-use capability) — they only flip the
   * soft visibility layers. Absent key = default behaviour. Set under `cli`.
   */
  toolOverrides?: Record<string, boolean>;
}

/**
 * 0.4.15 — assignment of a model (and optionally a named provider) to a
 * sub-agent role. `provider` references a key in `Config.providers`; omitted →
 * use the main `llm`. `model` overrides the model on the chosen provider;
 * omitted → that provider's default model. An assignment under the `default`
 * role applies to every sub-agent that has no role-specific entry.
 */
export interface AgentModelAssignment {
  provider?: string;
  model?: string;
}

export interface Config {
  activeServer: string;
  servers: Record<string, ServerConfig>;
  llm?: LLMConfig;
  /**
   * 0.4.15 — additional NAMED OpenAI-compatible LLM providers (endpoint + key +
   * default model), beyond the main `llm`. Mirrors the `servers`/`activeServer`
   * pattern for MCP. Referenced by `agentModels` to route sub-agents to a
   * different provider/model than the main agent.
   */
  providers?: Record<string, LLMConfig>;
  /**
   * 0.4.15 — per-sub-agent-role model routing. Keyed by role
   * (`default · explorer · architect · reviewer · worker · verifier`); each
   * value picks a provider (from `providers`) and/or a model. Lets e.g. the
   * explorer run a cheap/fast model while the reviewer runs a strong one.
   */
  agentModels?: Record<string, AgentModelAssignment>;
  /** 0.3.9: all former-env CLI knobs. Optional; defaults apply when missing. */
  cli?: CliKnobs;
}

export interface ResolvedCliKnobs {
  permissions: { allow: string[]; deny: string[] };
  automation: ResolvedAutomationKnobs;
  hooks: { enabled: boolean; enforceWhenSilent: boolean };
  recallMode: 'always' | 'gated' | 'off';
  nextActionPlanner: 'on' | 'off';
  prefixMemoryAnchors: 'on' | 'off';
  personaAnchor: 'on' | 'off';
  personalityDefault: 'concise' | 'standard' | 'detailed' | 'pair-programmer' | null;
  briefingMaxCharsPerSource: number;
  briefingMaxSources: number;
  autoCompactTokens: number;
  turnEndResultCapTokens: number;
  turnEndShrinkRatio: number;
  childResultSystemChars: number;
  maxToolResultChars: number;
  toolOutputCompressionEnabled: boolean;
  toolOutputCompressionMinChars: number;
  toolOutputCompressionTargetKeep: number;
  effortRoutingMode: 'adaptive' | 'off';
  effortForToolResumeTurns: 'low' | 'medium';
  verbositySteeringLevel: 0 | 1 | 2 | 3 | 4;
  stormWindow: number;
  stormThreshold: number;
  maxToolLoops: number;
  localModelProfile: 'auto' | 'on' | 'off';
  repeatToolSequenceLimit: number;
  repeatSequenceExemptTools: string[];
  repeatLoopLimit: number;
  parallelSafeToolCalls: boolean;
  altScreen: boolean;
  hideCursor: boolean;
  quiet: boolean;
  theme: 'light' | 'dark' | 'auto';
  llmTimeoutMs: number;
  router: ResolvedRouterCliKnobs;
  llmMaxReconnects: number;
  llmMaxConcurrent: number;
  disableStream: boolean;
  confirmRunWorkflow: boolean;
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fallbackModel: string | null;
  /** CC-CONFIG-A2 — resolved ORDERED fallback chain (validated, capped at 3, deduped;
   *  `fallbackModel` appended last for back-compat). */
  fallbackModels: string[];
  /** CC-CONFIG-A3 — resolved available-models allowlist (validated, deduped). */
  availableModels: string[];
  enforceAvailableModels: boolean;
  /** MC-D3 — validated named LLM profiles (blank names / model-less entries dropped). */
  llmProfiles: Record<string, LlmProfileConfig>;
  /** MC-D3 — active profile name; '' when unset or not among `llmProfiles`. */
  activeLlmProfile: string;
  /** CC-CONFIG-A4 — resolved version-range gate ('' = unset). */
  requiredMinimumVersion: string;
  requiredMaximumVersion: string;
  enforceVersionRange: boolean;
  /** CC-CONFIG-A1 — safe/troubleshooting mode. */
  safeMode: boolean;
  /** ADR-027 D2 — turn loop or typed graph executor. Both ship; this selects. */
  executionEngine: 'loop' | 'graph';
  stackingMode: 'auto' | 'always' | 'never';
  comprehension: { enabled: boolean; model: string; questions: number };
  autoInstallTools: 'off' | 'safe';
  /** CC-CONFIG-A5 — provenance footer controls for commit/PR bodies. */
  attribution: { sessionUrl: boolean };
  /** CC-CONFIG-A6 — hide bundled skills from listings. */
  skillsHideBundled: boolean;
  /** MC-E1 — resolved skills/agents discovery controls. */
  skills: Required<SkillsCliKnobs>;
  /** CC-SKILLS-D1 — max stacked `/skill` tokens per prompt (clamped 1..5). */
  skillsStackMax: number;
  /** MC-E2 — keyword-triggered JIT skill injection kill-switch (default true). */
  skillsKeywordTriggers: boolean;
  /** CC-UX-E2 — render GFM task-list checkboxes (☐ / ☑) in the CLI renderer. */
  markdownCheckboxes: boolean;
  mcpTimeoutMs: number;
  /** REMOTE-BRAIN — remote brain HTTP endpoint, or null for the embedded default. */
  brainUrl: string | null;
  sandbox: 'off' | 'on';
  sandboxReadPaths: string[];
  sandboxWritePaths: string[];
  sandboxNetwork: boolean;
  sandboxUnavailable: 'ask' | 'deny' | 'warn';
  sandboxEnforceWhenSilent: boolean;
  jobSecretScoping: boolean;
  jobSecretAllowlist: string[];
  commandAllowlist: string[];
  autoClassifyShell: 'off' | 'on' | 'strict';
  autoClassifyShellEnforceWhenSilent: boolean;
  childWorkspaceIsolation: 'off' | 'auto' | 'git-worktree';
  worktreeRoot: string;
  buildLoop: 'off' | 'escalate' | 'always';
  worktreeMergeReview: 'off' | 'on';
  buildLoopMaxRepairs: number;
  buildLoopEmitPr: boolean;
  buildLoopPrBaseBranch: string;
  buildLoopPrDraft: boolean;
  /** MC-D1 — validated critic-gate knobs: enabled defaults false; threshold
   *  falls back to 0.7 outside [0,1]; iterations clamped 0..8 (default 2). */
  critic: { enabled: boolean; threshold: number; maxRefinementIterations: number; model: string };
  /** MC-D4 — hard per-task budget caps. 0 means uncapped. */
  budget: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  notifyBell: boolean;
  childDrainTimeoutMs: number;
  offloadRetentionMs: number;
  offloadMaxEntries: number;
  maxSpawnDepth: number;
  maxConcurrentChildren: number;
  fleetMaxConcurrentJobs: number;
  autoChainMaxFollowups: number;
  agentMcpToolBudget: number;
  mcpProgressiveDiscovery: boolean;
  scheduleTickMs: number;
  updateCheck: boolean;
  externalDirWrites: ExternalDirMode;
  egressAllowlist: string[];
  postEditCheck: string;
  autoExtractSkills: boolean;
  autoReplayOffline: boolean;
  autoReindex: boolean;
  browserSmoke: string;
  lspServers: Record<string, string>;
  codePromptPrefix: string;
  shortcuts: Record<string, string>;
  traceLog?: string;
  tracingBackend: 'stdout-jsonl' | 'otel' | 'langsmith' | 'langfuse';
  tracingEndpoint?: string;
  tracingApiKey?: string;
  webSearchEndpoint?: string;
  webSearch: ResolvedWebSearchKnobs;
  computerUse: { enabled: boolean; mode: string };
  /** PLUGIN-MARKETPLACE P1/P2/P3 — resolved plugin knobs (validated enable map +
   *  trimmed registry url; `registryUrl: ''` = unset → built-in default; the
   *  validated marketplace-source list; the P3 trust/consent + managed gates). */
  plugins: {
    enabled: Record<string, boolean>;
    registryUrl: string;
    marketplaces: MarketplaceSource[];
    altManifestNames: string[];
    approved: Record<string, PluginCapabilityConsent>;
    allowedMarketplaces: string[];
    blockedMarketplaces: string[];
    allowManagedHooksOnly: boolean;
    orgScope: boolean;
    /** PLUGIN-MARKETPLACE P5 — community registry repo for `plugin publish`
     *  (empty = unset → stdout + local file + gh instructions). */
    publishRepo: string;
    /** PLUGIN-MARKETPLACE P5 — surface (never install) an "updates available"
     *  notice on session start. Default false. */
    autoUpdateCheck: boolean;
  };
  agents: { hosted: ResolvedHostedAgentConfig[] };
  /** MC-A1 — validated runtime-plane knobs: backend falls back to 'process';
   *  `maxLive` clamped ≥ 0 (0 = no live-instance cap). MC-A6 adds the
   *  workspace-archive knobs: `archiveOnDispose` (default true),
   *  `archiveMaxMB` (tarball payload cap, clamped 1..1024, default 64) and
   *  `archiveKeep` (prune keeps newest N, default 20; 0 = no count prune).
   *  MC-A5 adds `jitSecrets` (default false — raw child env unchanged) and
   *  `jitSecretTtlMs` (lease lifetime, clamped 1s..1h, default 60s). */
  runtime: {
    backend: RuntimeBackendKind;
    maxLive: number;
    archiveOnDispose: boolean;
    archiveMaxMB: number;
    archiveKeep: number;
    jitSecrets: boolean;
    jitSecretTtlMs: number;
    /** MC-A3 — container backend image ('' = unset → backend refuses to start). */
    containerImage: string;
    /** MC-A3 — validated `docker run` limits (0/'' = no limit). */
    container: { cpus: number; memory: string };
    serve: boolean;
    serveHost: string;
    servePort: number;
    remoteUrl: string;
    previewPorts: Record<string, number>;
  };
  /** MC-B1 — validated trigger-ingress knobs: `enabled` requires an explicit
   *  `true` (default-deny); `port` clamped 1..65535 (default 8787); `host`
   *  defaults to loopback; `githubSecret` trimmed ('' = fall back to the
   *  GitHub connector's `webhookSecret`, else reject deliveries);
   *  `allowedRepos` sanitized ([] = every event accepted-but-dropped). */
  triggers: {
    enabled: boolean;
    port: number;
    host: string;
    /** Phase 1 — resolved GitHub App bot creds (only present when configured). */
    githubApp?: GithubAppCliKnobs;
    githubSecret: string;
    slackSigningSecret: string;
    gitlabSecret: string;
    jiraSecret: string;
    allowedRepos: string[];
    /** MC-B2 — resolver @mention handle (default 'brainrouter', '@' stripped). */
    mentionHandle: string;
    /** MC-B4 — CI-failure nudge comment; explicit `true` only (default false). */
    ciNudge: boolean;
  };
  tierLadder?: { flash?: string; standard?: string; pro?: string };
  contextCompaction: boolean;
  childAgentTimeoutMs: number;
  agentPreviewChars: number;
  debugExit: boolean;
  workspaceOverride?: string;
  maxOutputTokens?: number;
  /** PER-PROVIDER WIRE-FORMAT OVERRIDE — validated subset of
   *  `CliKnobs.providerRequestFormat`; entries whose value isn't one of the
   *  accepted `ProviderWireFormat` literals are dropped on resolve. */
  providerRequestFormat: Record<string, ProviderWireFormat>;
  /** Per-tool enable/disable overrides (validated subset of `CliKnobs.toolOverrides`;
   *  non-boolean values dropped). `true` = force-enable, `false` = force-disable. */
  toolOverrides: Record<string, boolean>;
}
