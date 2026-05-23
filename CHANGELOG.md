# Changelog

All notable changes to BrainRouter.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [0.3.6] - Unreleased

Smarter memory recall, friendlier dashboard, more reliable agent loop.

### Features
- **Relevance judge** — opt-in LLM gate after the reranker that drops memories that share keywords but aren't actually relevant. Off by default; enable with `BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true`. Falls back to reranker output on any failure — a flaky judge never breaks recall.
- **Dashboard Markdown, math, and diagrams** — chat, persona, and scene cards render full Markdown with LaTeX (`\[…\]` / `\(…\)`); Working Memory canvas renders Mermaid diagrams with theme awareness.

### Improvements
- **`/goal` loops stay focused.** Goal text is re-anchored as a system message every turn; default budget is effectively unlimited (anti-spin and `/goal pause` remain the real safety nets); inline `budget: N iterations` works in the goal text itself.
- **Fan-out veto.** Phrases like "no spawn_agent" or "do this in one turn" reliably stop the agent from spawning child agents regardless of complexity score.
- **`.env` templates** reorganized into numbered sections; placeholder strings blanked so committed examples never look like real secrets. New `BRAINROUTER_RELEVANCE_JUDGE_*` tunables documented.

### Fixes
- **Memory paths no longer corrupted.** The extractor's JSON-escape repair was silently turning Windows paths and Unix path segments like `\bin` / `\target` / `\release` into control characters when the LLM emitted malformed JSON. Path strings now survive intact.
- **Relevance judge survives LM Studio model auto-unload.** Detects the "no models loaded" 400, waits 1.5s, and retries once.
- **Goal stops leaking across sessions.** Opening a new CLI session in the same workspace no longer shows the previous session's goal as "already active." Any legacy workspace-level `goal.json` is archived to `cli/.brainrouter.migrated/` on the first session-scoped goal write so future sessions cannot rediscover it.
- **Intermittent CI test failure fixed** — flaky JWT-tampering assertion (~1/64 base64 collision odds), previously misdiagnosed as a Node-20 crypto incompatibility.

### Docs & tooling
- **`CLAUDE.md`** added as Claude Code's repo-level instructions (vendor-specific sibling to `AGENT.md`).
- **`openSrc/REFERENCES.md`** (gitignored) routes agents through vendored research projects so they don't grep the world.
- **CI**: Dependabot keeps React + React-DOM in lockstep; major-version bumps ignored until 0.3.6 ships; build runs in proper dependency order (`build:packages` → `build:apps`); Node matrix narrowed to 22.x (matches `engines.node`).

---

## [0.3.5] - 2026-05-22

Global-install UX fix.

- **`brainrouter-mcp init`** — scaffolds `~/.config/brainrouter/server.env` from the bundled template (chmod 0600). Won't overwrite an existing file.
- **Env-loader priority chain** — `$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`. Server prints which file it loaded at startup.
- **Published READMEs rewritten** for global-install users (the actual npm flow ending with `brainrouter` on `$PATH`); SETUP.md split into "install from npm" vs "clone and build" paths.

Backward compatible — existing monorepo dev (`brainrouter/.env`) still works in the third priority slot.

---

## [0.3.4] - 2026-05-22

First public npm release. Four packages under `@kinqs/`:

| Package | What it is |
|---|---|
| `@kinqs/brainrouter-cli` | Installs the `brainrouter` CLI binary |
| `@kinqs/brainrouter-mcp-server` | Installs `brainrouter-mcp` (MCP server) |
| `@kinqs/brainrouter-sdk` | Typed client helpers |
| `@kinqs/brainrouter-types` | Shared TypeScript types |

### Features
- **CLI offline mode** — MCP unreachable no longer hard-exits; `--strict-mcp` opts back into fail-fast. Banner shows `⚠️ OFFLINE MODE`.
- **Inspection-tool previews** — `list_dir`, `grep_search`, `glob_files` render results inline even when small models forget to echo them.
- **`bash` / `shell` / `sh` aliases** for `run_command` (Claude Code parity). Gated on `run_command` being available, so read-only mode can't sneak shell access.

### Improvements
- **CLI env separation** — `~/.config/brainrouter/config.json` is the canonical chat-LLM credential store; `.env` is restricted to runtime knobs (sandbox, timeouts, web search).
- **Dashboard migration** to `brainrouter-dashboard/` (Next.js 15, same page set).
- **SETUP.md** — maintainer runbook covering first-time setup, daily run, upgrade, publish, troubleshooting, nuclear-reset paths.

---

## [0.3.3] - 2026-05-22

`/goal` state machine + structural refactors.

### Features
- **`usage_limited` goal status** — resumable state distinct from `paused` (user-initiated) and `blocked` (agent gave up); triggered when iteration or token cap runs out.
- **Token budget on goals** — optional `maxTokens` cap. When reached, the goal transitions to `usage_limited`. Protects a fixed dollar budget without estimating turn counts.
- **Replace-confirmation prompt** — `/goal <new text>` won't silently overwrite an in-progress goal.
- **Wrap-up steering** on the final budget turn — the model is directed to consolidate and finalize instead of starting new investigations.
- **`/goal edit`** — unified update entrypoint for status, text, budget, and tokens.
- **`/goal tokens <N>`** — set or clear the per-goal token cap.

### Improvements
- **REPL split** into seven category command files (memory, ui, workflow, orchestration, obs, guard, session). Slash commands behave identically — only the layout changed.
- **Source tree restructured** into responsibility folders under `brainrouter-cli/src/`.
- **Monorepo versions synchronized** to 0.3.3 across all seven packages (prior releases had drifted).

### Fixes
- **MCP no longer pollutes the workspace tree.** Working memory, session state, and `/feedback` now live under `~/.brainrouter/` instead of in your project. Empty `<workspace>/.brainrouter/` shells from prior installs auto-clean.

---

## [0.3.2] - 2026-05-22

Observability + headless + UX polish.

- **OTEL trace nesting** for spawned child agents — fan-out trees now reconstruct correctly in observability tools.
- **Headless mode rejects slash commands** with a clear error and exit code 2 instead of silently routing them to the LLM.
- **GitHub PR info in statusline** (`/statusline mode,branch,pr`) with a 30s cache.
- **Dynamic terminal tab title** prefixed with `(N)` when continuation or child agents are pending — useful for background tabs.
- **`brainrouter agents [--json]`** — list child sessions from the command line without entering the REPL.
- **Paginated `/help`** with category groups; drill in with `/help <category>`.
- **Streaming `/diff`** for large edits, with `--staged` and `--all` flags.

### Fixes
- Slash commands followed by tab or newline now match correctly.
- Prompt history no longer records consecutive duplicate user prompts.

---

## [0.3.1] - 2026-05-22

Reliability hardening — silent failures, races, and edge cases.

### Fixes
- **🚨 Silent memory failure.** The CLI was looking for the wrong recall-response key, so every memory recall returned zero records and the citation / decay loop was effectively dead.
- **MCP child never saw LLM credentials** when spawned from a non-package directory. Symptoms: extraction failures piled up, cognitive table stayed empty.
- **`OPENAI_API_KEY` fallback bypassed by empty config string** (`??` nullish coalescing on an empty string).
- **Goal budget off-by-one.** Budget=10 fired 11 iterations.
- **Silent verifier child agents could bypass shell-approval prompts** — privilege-escalation path through `spawn_agent` closed. Silent children now refuse shell unless explicitly auto-approved.
- **No MCP timeout** — a hung MCP server used to hang the whole turn forever. Now races against `BRAINROUTER_MCP_TIMEOUT_MS` (60s default).
- **No auto-compaction** — long sessions silently blew the request-body cap. Now auto-compacts at 80k tokens (`BRAINROUTER_AUTO_COMPACT_TOKENS`).
- **Hallucinated tool names hard-failed.** `Read_File` / `read-file` / `read.file` now fuzzy-match against the real tool registry first.
- **JSON state corruption killed the REPL.** Bad `goal.json` or transcript files now quarantine to `<path>.corrupt-<ts>` and recover instead of bricking boot.
- **Sweeper interval misconfiguration could flood the LLM backend** — added a 30s code-level floor with a warning log and a reentrancy guard.

### Features
- **LLM concurrency semaphore** — cap simultaneous LLM calls per process via `BRAINROUTER_LLM_MAX_CONCURRENT` (default 2 MCP / 4 CLI). Set to `1` on consumer hardware running LM Studio; raise to `16+` for cloud backends.
- **LM Studio "Model is unloaded" auto-recovery** — detects the specific 400 body and retries once after the JIT load completes.
- **HTTP MCP transport documented and verified** end-to-end. Switch via `~/.config/brainrouter/config.json` → `"activeServer": "local-http"`.
- **`/doctor` extraction health check** — reports `healthy | backlog | DEGRADED` with the last extractor error inline.
- **Stronger fan-out detection** — broader phrase matching ("test all", "review every", "audit the whole codebase") and clearer spawn-agent visual output.

---

## [0.3.0] - 2026-05-22

Terminal Agent CLI + multi-agent orchestration + memory engine.

### Features
- **Terminal Agent CLI (`brainrouter`)** — memory-native coding agent with ~70 slash commands, durable per-session transcripts, and LLM-driven compaction.
- **Multi-agent orchestration** — first-class `spawn_agent` with five built-in roles:
  - **explorer** — read-only research
  - **architect** — design tradeoffs
  - **reviewer** — severity-ordered findings
  - **worker** — write-access implementation
  - **verifier** — test/shell validation
- **Web Chat (`/chat`)** — interactive in-browser agent with full memory engine access (recall, scenes, consolidation, contradictions).
- **HTTP Chat Completions endpoint** — MCP server exposes `/api/chat-completions` so any HTTP client can drive a BrainRouter agent.
- **Memory consolidation** — generates human-readable filesystem snapshots (`MEMORY.md`, `user.md`, `feedback.md`, `project.md`, `reference.md`).
- **Filtered & freshness-boosted recall** — `memory_recall` / `memory_search` accept type / scene / time / priority filters; new captures get a freshness bump.
- **Graph expansion & spreading activation** — 2-hop BFS over the knowledge graph; citation-driven reinforcement (LTP, +5% per cite, capped +30%); synaptic pruning of uncited memories.
- **Hookify Markdown rules** — drop a `.md` file with YAML frontmatter into `.brainrouter/hooks/` to install warn/block guardrails on tool calls without writing code.
- **Working-memory canvas** — large child-agent outputs auto-offload to a working-memory canvas via `memory_working_*` tools instead of polluting parent context.
- **Skill memetic potential** — repeatedly invoking a skill heats it up so its context gets pre-injected; half-life decay keeps cold skills out of the prompt.

---

## [0.2.0] - 2026-05-21

Admin & dashboard polish.

- **Admin Users console** at `/users` — paginated list; create / enable / disable / delete with self-protection; API key resets.
- **Memories Hub** — debounced text search, type filter chips, active/archived toggle, inline edit modal, infinite scroll, bulk actions.
- **Expanded Profile settings** — display-name editing, masked API key with click-to-copy, rotate-key confirmation, copy-paste MCP client config (STDIO + HTTP/SSE).
- **Contradiction resolution UI** — open/resolved filter, resolve/dismiss controls, real-time pending badge in the sidebar.
- **Auth hardening** — Remember-Me JWT persistence, signup password strength, rate-limit 20 attempts / 15 min per IP, dynamic CORS via `BRAINROUTER_CORS_ORIGIN`.
- **MCP onboarding banner** with copyable SSE connection variables.

### Fixes
- Recall Inspector no longer crashes on null/undefined potential scores.
- AuthGuard no longer flashes loading state when validating session persistence on mount.
- Stale JWT tokens cleared after protected API call failures.
