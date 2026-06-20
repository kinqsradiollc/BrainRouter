import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExternalDirMode } from '../exec/execPolicy.js';
import { sanitizeCommandAllowlist } from '../exec/approvalGuard.js';
import { BUILTIN_PROVIDERS } from '../provider/providers/index.js';

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
  /** Per-call LLM timeout in ms. Default 120000. A timeout is treated as a
   *  RECONNECT signal (not a hard failure) — see `llmMaxReconnects`. */
  llmTimeoutMs?: number;
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
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** PARITY-E3 — model to fall back to when the primary model is unavailable. */
  fallbackModel?: string | null;

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
   * CODEX-EXEC-POLICY (0.4.7) — command prefixes the user pre-approves, so a
   * `run_command` whose every segment matches one auto-approves without a prompt
   * in any mode (e.g. `git status`, `npm test`). Prefixes match on a word
   * boundary. Over-broad prefixes (bare `git`/`bash`/`sudo`/…) are rejected by
   * CODEX-APPROVAL-GUARD. Default empty = no change to approval behavior.
   */
  commandAllowlist?: string[];
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
  /** MAS-P4-T4: max auto-chain follow-up agents per worker. Default 2. */
  autoChainMaxFollowups?: number;
  /** MAS-P4-T1: cap on MCP tools shown to an agent per turn (0 = no cap). Default 40. */
  agentMcpToolBudget?: number;

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
   * TRACK external sync (0.4.15). GitHub Issues bridge config. `repo` is
   * "owner/name"; `token` is a PAT with `repo`/`issues` scope (falls back to
   * the standard `GITHUB_TOKEN` / `GH_TOKEN` env when omitted, like the gh
   * CLI). Read on demand by the `/track sync` command + desktop Sync panel.
   */
  track?: { githubRepo?: string; githubToken?: string };
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
  // Endpoint → env-var map, DERIVED from the provider code modules
  // (BUILTIN_PROVIDERS) so it can never drift from the catalog — the old
  // hand-maintained "keep in lockstep with PROVIDER_CATALOG" copy is gone.
  // OpenRouter + Gemini have no code module yet (they're reachable via the
  // generic openai-compatible flow), so they're the only explicit entries.
  // (Anthropic native was removed in 0.3.9 — Claude routes through OpenRouter.)
  const PROVIDER_ENV_BY_ENDPOINT: Array<{ endpoint: string; envKey: string }> = [
    ...BUILTIN_PROVIDERS.filter((p) => p.endpoint && p.envKey).map((p) => ({ endpoint: p.endpoint, envKey: p.envKey })),
    { endpoint: 'https://openrouter.ai/api/v1',                     envKey: 'OPENROUTER_API_KEY' },
    { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
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
export interface ResolvedCliKnobs {
  permissions: { allow: string[]; deny: string[] };
  recallMode: 'always' | 'gated' | 'off';
  nextActionPlanner: 'on' | 'off';
  prefixMemoryAnchors: 'on' | 'off';
  personaAnchor: 'on' | 'off';
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
  repeatToolSequenceLimit: number;
  parallelSafeToolCalls: boolean;
  altScreen: boolean;
  hideCursor: boolean;
  quiet: boolean;
  theme: 'light' | 'dark' | 'auto';
  llmTimeoutMs: number;
  llmMaxReconnects: number;
  llmMaxConcurrent: number;
  disableStream: boolean;
  confirmRunWorkflow: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  fallbackModel: string | null;
  mcpTimeoutMs: number;
  sandbox: 'off' | 'on';
  sandboxReadPaths: string[];
  sandboxWritePaths: string[];
  sandboxNetwork: boolean;
  sandboxUnavailable: 'ask' | 'deny' | 'warn';
  commandAllowlist: string[];
  childWorkspaceIsolation: 'off' | 'auto' | 'git-worktree';
  worktreeRoot: string;
  buildLoop: 'off' | 'escalate' | 'always';
  worktreeMergeReview: 'off' | 'on';
  buildLoopMaxRepairs: number;
  notifyBell: boolean;
  childDrainTimeoutMs: number;
  offloadRetentionMs: number;
  offloadMaxEntries: number;
  maxSpawnDepth: number;
  maxConcurrentChildren: number;
  autoChainMaxFollowups: number;
  agentMcpToolBudget: number;
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
  traceLog?: string;
  tracingBackend: 'stdout-jsonl' | 'otel' | 'langsmith' | 'langfuse';
  tracingEndpoint?: string;
  tracingApiKey?: string;
  webSearchEndpoint?: string;
  tierLadder?: { flash?: string; standard?: string; pro?: string };
  contextCompaction: boolean;
  childAgentTimeoutMs: number;
  agentPreviewChars: number;
  debugExit: boolean;
  workspaceOverride?: string;
  maxOutputTokens?: number;
}

export function resolveCliKnobs(cfg?: Config): ResolvedCliKnobs {
  const c = cfg?.cli ?? {};
  return {
    recallMode: c.recallMode ?? 'gated',
    nextActionPlanner: c.nextActionPlanner ?? 'on',
    permissions: { allow: c.permissions?.allow ?? [], deny: c.permissions?.deny ?? [] },
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
    maxToolLoops: c.maxToolLoops ?? 60,
    repeatToolSequenceLimit: c.repeatToolSequenceLimit ?? 8,
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
    sandbox: c.sandbox ?? 'off',
    sandboxReadPaths: c.sandboxReadPaths ?? [],
    sandboxWritePaths: c.sandboxWritePaths ?? [],
    sandboxNetwork: c.sandboxNetwork ?? false,
    sandboxUnavailable: c.sandboxUnavailable ?? 'deny',
    // CODEX-APPROVAL-GUARD — drop over-broad prefixes (bare `git`/`bash`/`sudo`/…)
    // so a too-permissive config.json entry can never auto-approve everything.
    commandAllowlist: sanitizeCommandAllowlist(c.commandAllowlist ?? []).allowed,
    childWorkspaceIsolation: c.childWorkspaceIsolation ?? 'auto',
    worktreeRoot: c.worktreeRoot ?? '',
    buildLoop: c.buildLoop ?? 'escalate',
    worktreeMergeReview: c.worktreeMergeReview ?? 'off',
    buildLoopMaxRepairs: Math.max(0, Math.floor(c.buildLoopMaxRepairs ?? 0)),
    notifyBell: c.notifyBell ?? false,
    childDrainTimeoutMs: c.childDrainTimeoutMs ?? 30_000,
    offloadRetentionMs: c.offloadRetentionMs ?? 1_800_000,
    offloadMaxEntries: c.offloadMaxEntries ?? 64,
    maxSpawnDepth: c.maxSpawnDepth ?? 3,
    maxConcurrentChildren: c.maxConcurrentChildren ?? 8,
    autoChainMaxFollowups: c.autoChainMaxFollowups ?? 2,
    agentMcpToolBudget: c.agentMcpToolBudget ?? 40,
    scheduleTickMs: c.scheduleTickMs ?? 30_000,
    traceLog: c.traceLog,
    tracingBackend: c.tracingBackend ?? 'stdout-jsonl',
    tracingEndpoint: c.tracingEndpoint,
    tracingApiKey: c.tracingApiKey,
    webSearchEndpoint: c.webSearchEndpoint,
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
    childAgentTimeoutMs: c.childAgentTimeoutMs ?? 0, // 0 = parent waits until child completion
    agentPreviewChars: c.agentPreviewChars ?? 2_500,
    debugExit: c.debugExit ?? false,
    workspaceOverride: c.workspaceOverride,
    maxOutputTokens: c.maxOutputTokens,
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
