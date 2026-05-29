# Configuration

Full reference: env vars, providers, transports, storage, sandboxing,
backpressure, diagnostics.

> **0.3.7 — the recommended path is the in-terminal wizard, not
> hand-editing JSON or env files.** This page leads with the wizard
> + slash-command flow; the env-var matrices stay below because some
> users (CI, multi-tenant deploys, advanced split-provider setups)
> genuinely need them.

## Quick start — interactive (recommended)

The first time you run `brainrouter`, a wizard walks you through
theme → provider → API key → model → MCP → AGENT.md in 6 picker
screens. No JSON editing, no separate `brainrouter login` /
`brainrouter config` subcommand sequence. Full breakdown in
[cli.md → First-run wizard](cli.md#first-run-wizard-037).

Once you're past the wizard, every knob has an in-REPL surface:

| Want to change… | Run this inside the REPL |
| --- | --- |
| LLM provider, model, endpoint, key | `/config` (bare) → "LLM provider", or `/config provider openrouter` / `/config model gpt-5` |
| MCP transport / URL | `/login` (new in 0.3.7), or `/config` (bare) → "MCP profile" |
| Theme | `/config theme dark` or bare picker via `/config` |
| Statusline segments | `/config statusline mode,branch,workflow,goal` |
| Reasoning depth | `/config effort high` (or `/effort high`) |
| Execution mode | `/config mode fast` (or `/mode fast`) |
| Review policy | `/config review-policy proceed` (or `/review-policy proceed`) |
| Quiet mode | `/config quiet on` (or `/quiet on`) |
| Personality | `/config personality concise` |
| Editor mode | `/config editor vi` |
| Re-run the full wizard | `/init` |

Everything below this section is for users who **need** to drop
under the wizard — CI environments without a TTY, custom env-file
deployments, or split-provider setups that the picker doesn't
cover.

## Quick recap (where things live)

| What | Where | Owns |
| --- | --- | --- |
| **MCP server env** | `~/.config/brainrouter/server.env` (global install) **or** `brainrouter/.env` (monorepo dev) | LLM credentials, retrieval pipeline (embeddings + reranker + relevance judge), memory engine knobs, server auth, JWT, admin seed. |
| **CLI credentials + transport** | `~/.config/brainrouter/config.json` (`llm.*`, `servers.*`, `activeServer`) | Chat model, endpoint, API key, MCP server profiles, active profile — the CLI's single source of truth since 0.3.7. |
| **CLI runtime knobs** | `~/.config/brainrouter/config.json` (`cli.*` block) | Tool-loop limits, sandbox, trace log, workspace override, quiet/theme overrides, recall mode, parallel-safe tools, child-drain / shrink ratios, etc. Behaviour env vars were retired in 0.3.9 — the full field list is the `CliKnobs` interface in [`brainrouter-cli/src/config/config.ts`](../brainrouter-cli/src/config/config.ts). The CLI no longer reads any `.env` file. |
| **MCP client transport** | `~/.config/brainrouter/config.json` (`servers` / `activeServer`) | Stdio vs HTTP MCP transport profile selection. |

The MCP server ships a template at [`brainrouter/.env.example`](../brainrouter/.env.example) — copy it to `~/.config/brainrouter/server.env` via `brainrouter-mcp init`. The CLI has no `.env` template; use the wizard or `/config` instead.

## MCP env-loader priority chain

The MCP server resolves which `.env` to load in this order (**first hit
wins**):

1. **`$BRAINROUTER_ENV_FILE`** — explicit override. Useful for CI or
   per-deployment env files.
2. **`~/.config/brainrouter/server.env`** — canonical location for
   globally-installed users (`npm i -g @kinqs/brainrouter-mcp-server`).
3. **`./.env`** — current working directory. Preserves classic dotenv
   behavior so monorepo dev (`cd brainrouter/ && npm run start:http`)
   keeps loading `brainrouter/.env` exactly as before.

The server prints `env: loaded N vars from <path>` to stderr at startup
so you can confirm which file was picked.

### First-time global install

After `npm i -g @kinqs/brainrouter-mcp-server`, scaffold the canonical
env file with:

```bash
brainrouter-mcp init
```

This copies the bundled `.env.example` to
`~/.config/brainrouter/server.env` with mode `0600`. It refuses to
overwrite an existing file. Edit the new file to set
`BRAINROUTER_LLM_API_KEY` and any optional knobs.

## Two processes, one env boundary

The MCP server and the CLI agent are separate processes with separate
concerns and a strict env boundary since 0.3.7:

| Process | Config source |
| --- | --- |
| **MCP server** | `brainrouter/.env` (monorepo dev) or `~/.config/brainrouter/server.env` (global install) — LLM credentials, retrieval pipeline, memory engine, auth, JWT, admin seed. |
| **CLI agent** | `~/.config/brainrouter/config.json` — `llm.*` for chat-LLM creds / endpoint / model, `servers.*` + `activeServer` for MCP transport, and `cli.*` for every behaviour knob (tool-loop limits, sandbox, trace log, theme, quiet, etc.). The CLI reads **no `.env` file at all**. |

Why the hard split?

- The MCP's cognitive extractor and the CLI's chat agent can run on
  different models. Each side picks its own credentials.
- CLI-only knobs (`cli.sandbox`, `cli.maxToolLoops`, `cli.traceLog`, …)
  have no meaning in the MCP server.
- A shared `.env` created silent precedence bugs where stale env vars
  could shadow the on-disk `config.json` — retired in 0.3.9 in favour
  of the single `cli.*` block.

### Loading & propagation

- **MCP server**: `import "dotenv/config"` at startup, resolving against
  `~/.config/brainrouter/server.env` (priority 2) or `brainrouter/.env`
  (priority 3 — cwd). See [MCP env-loader priority chain](#mcp-env-loader-priority-chain).
- **CLI agent**: reads `~/.config/brainrouter/config.json` for
  credentials + transport. Runtime knobs come from shell env only.
- **Shell env always wins**: anything already in `process.env` (exported
  in your shell, set via Docker `-e`, etc.) beats the config file.
- **CLI → MCP child propagation** (stdio mode only) passes the CLI's
  resolved LLM credentials so the server's cognitive extractor can share
  them. CLI-only and process-specific vars are filtered out.

## Quick start (minimal)

```env
# ~/.config/brainrouter/server.env  (MCP server)
BRAINROUTER_LLM_API_KEY=sk-...
```

That's the minimum for the server. Defaults: OpenAI
`https://api.openai.com/v1/chat/completions` with `gpt-4o-mini`, no
embeddings, no reranker, memory store at `~/.brainrouter/memory.db`.

For the CLI, run `brainrouter` and complete the wizard — it writes
`~/.config/brainrouter/config.json` with your provider, key, and model.

---

## LLM provider recipes

The chat LLM, the cognitive extractor, and the synthesis distillers can all
target different OpenAI-compatible endpoints. Most users point them at one
provider; advanced setups split (cheap model for extraction, smart model
for chat).

### OpenAI

```env
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini
# Optional: split models
BRAINROUTER_EXTRACTION_MODEL=gpt-4o-mini
BRAINROUTER_SYNTHESIS_MODEL=gpt-4o
```

### Anthropic via OpenAI-compatible gateway

Anthropic doesn't natively expose `/v1/chat/completions`. Use OpenRouter,
LiteLLM, or Anthropic's OpenAI-compat shim:

```env
BRAINROUTER_LLM_API_KEY=sk-or-v1-...
BRAINROUTER_LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
BRAINROUTER_LLM_MODEL=anthropic/claude-sonnet-4
```

### OpenRouter (multi-provider)

```env
BRAINROUTER_LLM_API_KEY=sk-or-v1-...
BRAINROUTER_LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
BRAINROUTER_LLM_MODEL=anthropic/claude-sonnet-4
```

OpenRouter routes to Anthropic, Google, Mistral, DeepSeek, etc. Pick any
model in their catalog.

### Gemini

```env
BRAINROUTER_LLM_API_KEY=...
BRAINROUTER_LLM_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
BRAINROUTER_LLM_MODEL=gemini-2.5-flash
```

(Google publishes an OpenAI-compatible endpoint.)

### LM Studio (local)

```env
BRAINROUTER_LLM_API_KEY=lm-studio
BRAINROUTER_LLM_ENDPOINT=http://localhost:1234/v1/chat/completions
BRAINROUTER_LLM_MODEL=google/gemma-2-9b-it
BRAINROUTER_LLM_MAX_CONCURRENT=1
```

Set concurrency to 1 on consumer hardware to avoid LM Studio's auto-unload
thrash. The CLI also auto-retries once when LM Studio returns
`400 {"error":"Model is unloaded."}`.

### Ollama

```env
BRAINROUTER_LLM_API_KEY=ollama
BRAINROUTER_LLM_ENDPOINT=http://localhost:11434/v1/chat/completions
BRAINROUTER_LLM_MODEL=qwen2:7b
BRAINROUTER_LLM_MAX_CONCURRENT=1
```

### vLLM

```env
BRAINROUTER_LLM_API_KEY=vllm
BRAINROUTER_LLM_ENDPOINT=http://localhost:8000/v1/chat/completions
BRAINROUTER_LLM_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct
BRAINROUTER_LLM_MAX_CONCURRENT=4   # vLLM batches well
```

### Split-provider setup

You can use a cheap local model for high-volume cognitive extraction and a
cloud model for chat:

```env
# Chat (cloud)
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o

# Extraction (local) — uses the same endpoint by default, override here
BRAINROUTER_EXTRACTION_MODEL=qwen2:7b
```

When extraction needs to hit a *different* endpoint than chat, the
extractor inherits `BRAINROUTER_LLM_ENDPOINT` — split by ordering: run
two processes, or use a routing proxy like LiteLLM.

---

## Embedding provider

The MCP server uses embeddings for the vector retriever. Defaults to none
(vector search disabled until configured). Any OpenAI-compatible
`/v1/embeddings` endpoint works.

```env
BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_API_KEY=sk-...       # falls back to BRAINROUTER_LLM_API_KEY
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536      # optional — for models that support truncation
```

### Custom embedding endpoints

LM Studio, vLLM, Infinity, BAAI/bge-* via TEI — anything that speaks
`POST /v1/embeddings`:

```env
BRAINROUTER_EMBEDDING_ENDPOINT=http://localhost:8081/v1/embeddings
BRAINROUTER_EMBEDDING_API_KEY=local
BRAINROUTER_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
BRAINROUTER_EMBEDDING_DIMENSIONS=1024
```

If the endpoint doesn't return a fixed dimension, omit
`BRAINROUTER_EMBEDDING_DIMENSIONS` — the server will pick from the first
response.

---

## Reranker provider

A cross-encoder reranker rescores the top-K candidates before the final
gate. Optional but recommended for noisy stores. The reranker only
**reorders** — it never filters; that's the judge's job (next section).

### Cohere

```env
BRAINROUTER_RERANKER_ENDPOINT=https://api.cohere.com/v1/rerank
BRAINROUTER_RERANKER_API_KEY=...
BRAINROUTER_RERANKER_MODEL=rerank-english-v3.0
BRAINROUTER_RERANKER_TOP_N=10              # default keeps the top 10
```

### Local vLLM reranker

```env
BRAINROUTER_RERANKER_ENDPOINT=http://localhost:8001/v1/rerank
BRAINROUTER_RERANKER_API_KEY=local
BRAINROUTER_RERANKER_MODEL=BAAI/bge-reranker-large
BRAINROUTER_RERANKER_TOP_N=20
```

Custom rerankers must accept `POST { model, query, documents: string[], top_n }`
and return `{ results: [{ index, relevance_score }] }`.

---

## Relevance judge

The final retrieval stage. An LLM grades each rerank finalist with a
binary verdict (`relevant: true | false`) plus a short reason, and any
candidate the judge rejects is dropped before the memories ever reach the
agent's context window. Off by default — opt in with the `_ENABLED` flag.

When to enable it:

- Your memory store has grown noisy and false-positive recalls keep
  surfacing memories that share vocabulary with the query but aren't
  actually about the same subject.
- Accuracy matters more than ~500ms-1s of extra recall latency.

How it works:

1. The reranker hands the judge its top-K candidates (default 10).
2. The judge sends them in a **single batched LLM call** with the query
   and returns one verdict per candidate.
3. Rejected candidates are dropped. If the judge rejects everything, the
   `<relevant-memories>` block is omitted entirely — an empty block is
   misleading.
4. If the judge call errors or times out, the reranker output passes
   through unchanged. A flaky judge never breaks recall.

Verdicts (with reasons) land in `recallExplanation.judgeVerdicts` so you
can audit and tune the prompt without code changes.

### Default (reuses BRAINROUTER_LLM_*)

```env
BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true
# Everything else inherits from BRAINROUTER_LLM_* — endpoint, key, model.
```

### Dedicated fast model

Use a cheaper model for judging so you don't pay GPT-4o prices on every
recall:

```env
BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true
BRAINROUTER_RELEVANCE_JUDGE_MODEL=gpt-4o-mini
BRAINROUTER_RELEVANCE_JUDGE_MAX_CANDIDATES=10
BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS=15000
```

### Dedicated endpoint + key

For a fully separate judging backend (e.g. a local Haiku replica):

```env
BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true
BRAINROUTER_RELEVANCE_JUDGE_ENDPOINT=http://localhost:1234/v1/chat/completions
BRAINROUTER_RELEVANCE_JUDGE_API_KEY=lm-studio
BRAINROUTER_RELEVANCE_JUDGE_MODEL=google/gemma-2-2b-it
```

---

## Web search backend

`web_search` uses DuckDuckGo's Instant Answer API by default (no key). For
real search, point at a custom backend:

```env
BRAINROUTER_WEB_SEARCH_ENDPOINT=http://your-search-proxy.example.com/search
```

The endpoint must accept `POST { query, maxResults }` and return
`{ results: [{ title, url, snippet }] }`. Compatible with Brave Search
API wrappers, Tavily, SerpAPI proxies, etc.

---

## Full env reference

Each section header tags which file the vars belong in.

### Required

| Var | Purpose |
| --- | --- |
| `BRAINROUTER_LLM_API_KEY` | **Server-side** LLM credential (the cognitive extractor). Falls back to `OPENAI_API_KEY`. Set in `brainrouter/.env` / `~/.config/brainrouter/server.env`. The **CLI** chat agent's credential is unrelated — it lives in `config.json` `llm.apiKey`, never an env var. |

### LLM core — server `.env` (`brainrouter/.env`)

These configure the **MCP server's** cognitive extractor. The CLI chat agent
is configured separately in `config.json` `llm.*` (see above). The
CLI's LLM is the chat agent.

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_LLM_ENDPOINT` | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible chat endpoint. |
| `BRAINROUTER_LLM_MODEL` | `gpt-4o-mini` | Chat model. |
| `BRAINROUTER_EXTRACTION_MODEL` (`brainrouter/.env`) | inherits | Cheaper/faster model for cognitive extraction. |
| `BRAINROUTER_SYNTHESIS_MODEL` (`brainrouter/.env`) | inherits | Smarter model for scene/identity distillation. |
| `BRAINROUTER_LLM_TIMEOUT_MS` | `120000` | Per-call chat timeout. Not propagated CLI → MCP. |
| `BRAINROUTER_LLM_MAX_CONCURRENT` | `2` (MCP) / `4` (CLI) | Concurrent LLM calls per process. Not propagated CLI → MCP. |

### Embedding — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_EMBEDDING_ENDPOINT` | _(unset — disables vector search)_ | OpenAI-compatible `/v1/embeddings`. |
| `BRAINROUTER_EMBEDDING_API_KEY` | inherits `BRAINROUTER_LLM_API_KEY` | Embedding credential. |
| `BRAINROUTER_EMBEDDING_MODEL` | _(provider default)_ | e.g. `text-embedding-3-small`, `BAAI/bge-large-en-v1.5`. |
| `BRAINROUTER_EMBEDDING_DIMENSIONS` | auto-detect | Override for truncatable models. |

### Reranker — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_RERANKER_ENDPOINT` | _(unset — disables rerank)_ | Cohere or vLLM `/v1/rerank`. |
| `BRAINROUTER_RERANKER_API_KEY` | _(unset)_ | Reranker credential. |
| `BRAINROUTER_RERANKER_MODEL` | _(provider default)_ | e.g. `rerank-english-v3.0`. |
| `BRAINROUTER_RERANKER_TOP_N` | `10` | Top-K to rerank. |

### Relevance judge — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_RELEVANCE_JUDGE_ENABLED` | `false` | Master flag. When false the judge stage is skipped entirely. |
| `BRAINROUTER_RELEVANCE_JUDGE_API_KEY` | inherits `BRAINROUTER_LLM_API_KEY` | Judge credential. |
| `BRAINROUTER_RELEVANCE_JUDGE_ENDPOINT` | inherits `BRAINROUTER_LLM_ENDPOINT` | OpenAI-compatible chat-completions endpoint. |
| `BRAINROUTER_RELEVANCE_JUDGE_MODEL` | inherits `BRAINROUTER_LLM_MODEL` | Model id. A fast/cheap model is usually right. |
| `BRAINROUTER_RELEVANCE_JUDGE_MAX_CANDIDATES` | `10` | Max candidates batched into a single judge call. |
| `BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS` | `15000` | Per-call timeout. On timeout the reranker output passes through unchanged. |

### Memory engine — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_MEMORY_DB` | `~/.brainrouter/memory.db` | SQLite path. |
| `BRAINROUTER_HOME` | `~/.brainrouter` | Per-user state root. Honored by both processes. |
| `BRAINROUTER_LOCAL_ROOT` | _(unset)_ | Override the local-state root. |
| `BRAINROUTER_GRAPH_ENABLED` | `true` | 2-hop graph extraction + BFS expansion. |
| `BRAINROUTER_GRAPH_TIMEOUT_MS` | `120000` | Graph-extraction LLM timeout. |
| `BRAINROUTER_CONTRADICTION_TIMEOUT_MS` | `60000` | Contradiction-check timeout. |
| `BRAINROUTER_ACE_ARCHIVE_THRESHOLD` | `10` | Uncited surfaces before pruning. |
| `BRAINROUTER_FOCUS_TRIGGER_N` | `10` | New records before scene distillation fires. |
| `BRAINROUTER_IDENTITY_TRIGGER_N` | `50` | New records before identity distillation fires. |
| `BRAINROUTER_MAX_FOCUS_SCENES` | `20` | Cap on active scenes (oldest evicted). |
| `BRAINROUTER_PERSONA_CACHE_TTL_MS` | `3600000` (1h) | Persona-synthesis in-memory cache lifetime. |
| `BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS` | `300000` (5m) | Background extractor sweep. Floored at 30s. |
| `BRAINROUTER_EXTRACTION_SWEEP_MIN_AGE_MS` | `120000` | Minimum sensory-row age before sweep. |
| `BRAINROUTER_EXTRACTION_MAX_FAILURES` | `5` | Per-user failure budget before background pause. |
| `BRAINROUTER_DISABLE_EXTRACTION_SWEEPER` | `false` | Hard-disable the sweeper. |
| `BRAINROUTER_PREWARM_ENABLED` | `false` | Enable skill memetic pre-warming. |

### Skill pre-warming — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_SKILL_MAX_POTENTIAL` | `4.0` | Ceiling on skill heat ($H_{max}$). |
| `BRAINROUTER_SKILL_SPIKE_AMOUNT` | `1.0` | Heat added per trigger ($\Delta_{spike}$). |
| `BRAINROUTER_SKILL_HALF_LIFE_MINUTES` | `10` | Skill heat half-life. |
| `BRAINROUTER_SKILL_PREWARM_THRESHOLD` | `0.3` | Threshold for context injection. |
| `BRAINROUTER_SKILL_MIN_TURN_DECAY` | `0.05` | Minimum heat decay per turn. |

### CLI runtime knobs — `cli.*` in `config.json`

Every CLI behaviour knob lives under the `cli.*` block of
`~/.config/brainrouter/config.json`. **The CLI reads no `BRAINROUTER_*` env
var** (retired in the 0.3.9 env→config migration) and no `.env` file — edit
`config.json`, or use `/config <key> <value>` in-session (`/config` bare opens
an arrow-key panel; `/config raw` dumps the scrubbed JSON). The complete,
authoritative list is the `CliKnobs` interface in
[`brainrouter-cli/src/config/config.ts`](../brainrouter-cli/src/config/config.ts);
the load-bearing ones:

| `cli.*` key | Default | Purpose |
| --- | --- | --- |
| `mcpTimeoutMs` | `60000` | Per-tool MCP timeout. |
| `maxToolResultChars` | `8000` | Clamp on tool-result body sent back to the LLM. |
| `autoCompactTokens` | `80000` | Auto-`/compact` trigger threshold. |
| `maxToolLoops` | `60` | Hard cap on tool iterations per turn. |
| `traceLog` | _(unset)_ | Path for OTEL-style JSONL turn traces. |
| `effort` | `medium` | Reasoning depth `low` / `medium` / `high` / `xhigh` (alias `max`). Pins across sessions; beats the `/effort` workspace preference. |
| `fallbackModel` | `null` | Model to switch to + retry once when the primary model is unavailable (PARITY-E3). |
| `notifyBell` | `false` | Ring the terminal bell on an idle background-completion notice (PARITY-W3). |
| `recallMode` | `gated` | Memory-recall gating: `gated` (turn 1 / post-compaction / ≥2 entity tokens) · `always` · `off`. |
| `theme` | `auto` | Banner / prompt accent: `dark` / `light` / `mono` / `auto`. |
| `quiet` | `false` | Suppress recall tables, briefing dumps, tool-completion previews. |
| `sandbox` | `off` | `on` wraps `run_command` (and the `!` shell escape) in the platform sandbox. |
| `sandboxNetwork` | `false` | Allow outbound network from the sandbox. |
| `autoChainMaxFollowups` | `2` | Cap on auto-chained review/verify follow-ups per worker. |
| `agentMcpToolBudget` | `40` | Cap on MCP tools shown to a child agent per turn (0 = no cap). |
| `workspaceOverride` | _(auto)_ | Override the CLI workspace root. |

### Sandboxing — shell env

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_SANDBOX` | _(unset)_ | Set to `on` to wrap `run_command` in `sandbox-exec` (mac) / `bwrap` / `firejail` (Linux). |
| `BRAINROUTER_SANDBOX_NETWORK` | `off` | Allow outbound network from sandboxed commands. |
| `BRAINROUTER_SANDBOX_READ_PATHS` | _(unset)_ | `:`-separated allowlist of read paths. |
| `BRAINROUTER_SANDBOX_WRITE_PATHS` | _(unset)_ | `:`-separated allowlist of write paths. |

### Server / auth — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_API_KEY` | seeded from `users.api_key` | HTTP MCP transport auth. |
| `BRAINROUTER_JWT_SECRET` | random per-boot | Dashboard JWT signing key. |
| `BRAINROUTER_JWT_EXPIRES_SECS` | `86400` (24h) | JWT lifetime. |
| `BRAINROUTER_DEFAULT_ADMIN_USER_ID` | `admin` | Seeded admin user id. |
| `BRAINROUTER_ADMIN_EMAIL` | `admin` | Seeded admin email. |
| `BRAINROUTER_ADMIN_PASSWORD` | _(unset; required to seed)_ | Seeded admin password. |
| `BRAINROUTER_USER_ID` | _(unset)_ | Override MCP user context. |
| `BRAINROUTER_CORS_ORIGIN` | `http://localhost:3000` | Dashboard CORS allowlist. |

### Hook context (auto-injected)

The CLI injects these into the child process env when running shell hooks
(`pre-turn`, `post-turn`, `pre-tool`, `post-tool`, etc.). You don't set
them; hook scripts read them.

| Var | Purpose |
| --- | --- |
| `BRAINROUTER_HOOK_EVENT` | Event name (`pre-tool`, `pre-turn`, …). |
| `BRAINROUTER_HOOK_TOOL` | Tool name (for `pre-tool` / `post-tool`). |
| `BRAINROUTER_HOOK_PAYLOAD` | JSON payload for the event. |

---

## CLI chat-LLM config

Since 0.3.4 the canonical credential store for the CLI's **chat LLM**
is `~/.config/brainrouter/config.json`. Same file as the MCP transport
profile, with an additional `llm` block:

```json
{
  "activeServer": "default",
  "servers": { /* see below */ },
  "llm": {
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4o",
    "endpoint": "https://api.openai.com/v1/chat/completions"
  }
}
```

`apiKey` is optional in the file — if blank, the CLI backfills from
`BRAINROUTER_LLM_API_KEY` / `OPENAI_API_KEY` in the environment at load
time. Endpoint and model fall back to OpenAI / `gpt-4o-mini` if not set.

Why a JSON file instead of `.env` for credentials? Two reasons:

- **No silent precedence bugs.** Pre-0.3.4 the CLI would happily read
  chat-LLM credentials out of any `.env` it could find (`brainrouter-cli/.env`,
  `brainrouter/.env`, cwd). That meant editing the dashboard's "rotate
  API key" flow could leave a stale key in a `.env` that won
  precedence anyway. Putting credentials in one well-known JSON file
  removes the foot-gun.
- **Shell env for runtime knobs.** Sandbox flags, timeouts, trace log,
  web-search backend, theme, quiet — anything you'd genuinely want
  per-shell — belongs in your shell profile (`export BRAINROUTER_*=…`)
  or an inline env prefix. The CLI no longer reads any `.env` file at
  all (as of 0.3.7).

## MCP client config

The CLI picks an MCP server profile from the same
`~/.config/brainrouter/config.json`:

```json
{
  "activeServer": "default",
  "servers": {
    "default": {
      "type": "stdio"
    },
    "local-http": {
      "type": "http",
      "url": "http://localhost:3747/mcp",
      "apiKey": "br_..."
    },
    "remote": {
      "type": "http",
      "url": "https://brainrouter.example.com/mcp",
      "apiKey": "br_..."
    }
  }
}
```

Switch with `/mcp use <name>` or edit `activeServer`. List with `/mcp`.

When the active MCP server is unreachable the CLI degrades to **offline
mode** (banner shows `⚠️  OFFLINE MODE` — memory recall, skills, and
capture disabled; local tools still work). Pass `--strict-mcp` to opt
back into the old fail-fast behavior.

### Stdio vs HTTP

| | stdio (default) | HTTP |
| --- | --- | --- |
| **When** | Single-machine dev | Multi-process, cloud, separate logs |
| **How** | CLI auto-spawns `node brainrouter/dist/index.js` | Run `npm run start:http` in `brainrouter/`; defaults to :3747 |
| **Logs** | Stderr passthrough to CLI terminal | In the MCP server's own terminal |
| **Auth** | Process-local (no key needed) | `Authorization: Bearer <api_key>` |

API keys live in `users.api_key` in `memory.db`. Generate via the
dashboard at `/profile`, or query directly:

```sql
SELECT api_key FROM users WHERE id = 'admin';
```

---

## Storage layout

Personal CLI state lives under `~/.brainrouter/`. Only committable
workflow artifacts live inside the workspace.

```
~/.config/brainrouter/                   ← user config (XDG-style)
├── server.env                           # MCP env (priority 2 in the loader chain)
└── config.json                          # CLI: chat-LLM creds + MCP transport profiles

~/.brainrouter/                          ← user-global state (override: BRAINROUTER_HOME)
├── memory.db                            # MCP cognitive memory store
├── mcp-cache/<workspace-hash>/          # MCP-side per-workspace cache
│   └── active_session.json
├── work/<user>/<workspace-hash>/<session>/   # working-memory canvas
│   ├── steps.jsonl
│   ├── canvas.mmd
│   ├── refs/
│   └── state.json
└── workspaces/
    └── <basename>-<sha8>/               # one bucket per workspace
        ├── cli/
        │   ├── preferences.json         # theme, statusline, vim, personality, quiet
        │   ├── hooks.json               # shell lifecycle hooks
        │   ├── sessions.json            # child-agent orchestration index
        │   ├── feedback.jsonl
        │   ├── current-workflow.json
        │   ├── .brainrouter.migrated/   # archives of legacy workspace-level files
        │   │   └── legacy-goal-<ts>.json
        │   └── sessions/                # one folder per chat session
        │       └── <encodedKey>/
        │           ├── transcript.jsonl
        │           ├── goal.json
        │           └── tasks.json
        ├── hooks/                       # hookify markdown rules (*.md)
        └── memories/                    # phase-2 consolidation snapshots
            ├── MEMORY.md
            ├── user.md
            ├── feedback.md
            ├── project.md
            ├── reference.md
            ├── raw_memories.md
            └── rollout_summaries/

<workspace>/.brainrouter/                ← workspace-local (committable)
└── workflows/
    └── <slug>/
        ├── spec.md
        ├── tasks.md
        ├── walkthrough.md
        └── meta.json
```

- **Encoding** — workspace → `<basename>-<sha1[0:8]>`. Two checkouts with
  the same basename get distinct buckets via the hash.
- **Session keys** — base64url-encoded so any string is safe as a dir name.
- **Isolation** — `/fork`, `/new`, `/side`, `/btw` each get a fresh
  session key + bucket; no goal/plan leakage.
- **Auto-migration** — workspaces from pre-2026-05-21 builds keep their
  old `<workspace>/.brainrouter/` files; on first run the CLI copies them
  into the home bucket and drops a `.migrated-from-workspace` marker.
- **Legacy goal archive** — pre-PR-#26 builds wrote a single
  workspace-level `cli/goal.json` shared by every CLI in the workspace.
  Since PR #26 each CLI process owns its own UUID `sessionKey` and
  goals live under `sessions/<encodedKey>/goal.json`. If a legacy
  `cli/goal.json` is detected on the first session-scoped goal write,
  the CLI archives it under `cli/.brainrouter.migrated/legacy-goal-<ts>.json`.
- **Why workflows stay in the workspace** — `spec.md` / `tasks.md` /
  `walkthrough.md` are team documentation, meant to be reviewed and
  committed alongside the code.

---

## Sandboxing

`run_command` can be wrapped in a platform sandbox.

| Platform | Tool | How |
| --- | --- | --- |
| macOS | `sandbox-exec` | Built-in. CLI generates a `.sb` profile per command. |
| Linux | `bwrap` (preferred) or `firejail` | Auto-detected. |
| Windows | _(none)_ | Falls back to unsandboxed with a notice. |

Enable:

```env
BRAINROUTER_SANDBOX=on
BRAINROUTER_SANDBOX_NETWORK=off            # block outbound by default
BRAINROUTER_SANDBOX_READ_PATHS=/usr/local:/opt
BRAINROUTER_SANDBOX_WRITE_PATHS=/tmp
```

Sandboxing is an additional layer on top of the existing user-confirmation
step. Confirmation guards intent; sandboxing guards blast radius.

---

## Backpressure

Running BrainRouter against a single local LLM (LM Studio with one GPU,
Ollama, single-replica vLLM) can fan out many concurrent calls per turn:
chat reply, extractor, contradiction checks (one per neighbor up to 5),
graph extraction (one per record), focus-shift detection, sweeper, plus
any spawned children. Consumer hardware running an 8GB model handles
maybe 2–3 concurrent generations before OOMing or auto-unloading.

Mitigations in order:

1. **Concurrency semaphore** (`BRAINROUTER_LLM_MAX_CONCURRENT`) — caps
   in-flight LLM calls per process. Excess queues FIFO.
2. **Sequential per-record fan-out** — contradiction checks within one
   record run sequentially.
3. **LM Studio retry-on-unload** — `400 {"error":"Model is unloaded."}`
   retries once after 1.5s.
4. **Sweeper reentrancy guard** — at most one sweep in flight; later
   ticks no-op until the previous finishes.
5. **Sweeper interval floor** — values below 30s clamp with a warning.

Tuning:

- Consumer hardware (8–12GB GPU, 1 model): `BRAINROUTER_LLM_MAX_CONCURRENT=1`.
- Workstation (24–48GB, 2–3 models): `2–4`.
- Cloud APIs: `16+`.

---

## Diagnostics

- `/doctor` — live health snapshot: MCP latency, extraction status
  (`healthy | backlog | DEGRADED`), last extractor error, child sessions,
  plan items, hookify rules.
- `memory_diagnostics` (MCP tool) — same data over RPC, including
  `scheduler_state.extraction_errors` and `last_error_message`.
- `/tokens` — running session usage + memory-derived savings counter.
- `/trace [on|off|status]` — toggle the OTEL JSONL trace log at runtime.
- `BRAINROUTER_TRACE_LOG=path/to/trace.jsonl` — turn on permanently via env.

Trace lines are NDJSON with shape:

```json
{ "ts": "2026-05-22T17:30:00Z",
  "name": "brainrouter.tool",
  "trace_id": "...", "span_id": "...", "parent_span_id": "...",
  "attrs": { "tool": "read_file", "ok": true, "session_key": "...", "agent_id": "agent-abc123" } }
```

Compatible with `jq` and any OTEL JSONL ingester.
