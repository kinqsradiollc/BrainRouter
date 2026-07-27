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
| **MCP server env** | `~/.config/brainrouter/server.env` (global install) **or** `brainrouter/.env` (monorepo dev) | Infra + tuning only: DB URL, encryption/JWT secrets, admin seed, CORS, and the optional memory-engine/recall tuning knobs. **AI providers moved to the DB (dashboard → AI Providers, ADR-012)** — the LLM/embedding/reranker env recipes below are a one-time seed / reference, not the live config. |
| **CLI credentials + transport** | `~/.config/brainrouter/config.json` (`llm.*`, `servers.*`, `activeServer`) | Chat model, endpoint, API key, MCP server profiles, active profile — the CLI's single source of truth since 0.3.7. |
| **CLI runtime knobs** | `~/.config/brainrouter/config.json` (`cli.*` block) | Tool-loop limits, sandbox, trace log, workspace override, quiet/theme overrides, recall mode, parallel-safe tools, child-drain / shrink ratios, etc. Behaviour env vars were retired in 0.3.9 — the full field list is the `CliKnobs` interface in [`brainrouter-cli/src/config/config.ts`](../brainrouter-cli/src/config/config.ts). The CLI no longer reads any `.env` file. |
| **MCP client transport** | `~/.config/brainrouter/config.json` (`servers` / `activeServer`) | Stdio vs HTTP MCP transport profile selection. |
| **Local telemetry (0.4.15)** | `~/.brainrouter/telemetry/events.jsonl` (data); `cli.telemetry.enabled` (toggle) | Privacy-conscious, local-first lifecycle + latency events for background tasks, plan revisions, reviews, uploads, memory capture, and git/workspace refresh. Local JSONL only — **no network**, metadata/counters/latency only (never message or file content). Enabled by default; set `cli.telemetry.enabled` to `false` in `config.json` to turn it off entirely. |

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
overwrite an existing file. Edit the new file to set `BRAINROUTER_DATABASE_URL`,
`BRAINROUTER_SECRET_KEY`, `BRAINROUTER_JWT_SECRET`, and the admin seed. **AI
providers are added in the dashboard after first boot (ADR-012), not here.**

## Two processes, one env boundary

The MCP server and the CLI agent are separate processes with separate
concerns and a strict env boundary since 0.3.7:

| Process | Config source |
| --- | --- |
| **MCP server** | `brainrouter/.env` (monorepo dev) or `~/.config/brainrouter/server.env` (global install) — DB URL, encryption/JWT secrets, admin seed, CORS, and optional memory-engine/recall tuning knobs. **AI providers live in the DB (dashboard), not here (ADR-012).** |
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
# ~/.config/brainrouter/server.env  (MCP server) — infrastructure only
BRAINROUTER_DATABASE_URL=postgres://postgres:postgres@localhost:5432/brainrouter
BRAINROUTER_SECRET_KEY=...     # openssl rand -base64 32  (encrypts DB-stored provider keys)
BRAINROUTER_JWT_SECRET=...     # openssl rand -hex 32
BRAINROUTER_ADMIN_PASSWORD=... # seeds the first admin on first boot
```

That's the minimum for the server — the memory store runs on Postgres + pgvector
(SQLite has been removed), so a connection string is required. **AI providers
(LLM / embeddings / reranker) are NOT set here** — after first boot, sign in to
the dashboard as the seeded admin → **Intelligence → Models & providers** and add
them there (stored encrypted in the DB, ADR-012).

For the CLI, run `brainrouter` and complete the wizard — it writes
`~/.config/brainrouter/config.json` with your provider, key, and model.

---

## LLM provider recipes

> **Providers live in the DATABASE now (ADR-012).** Configure the LLM,
> embeddings, and reranker in the **dashboard → AI Providers** (or
> `POST /api/admin/providers`), and per-role sub-agent models under
> **AI Providers → Subagents**. The `BRAINROUTER_*_LLM/EMBEDDING/RERANKER_*`
> env vars below are **(a)** a handy reference for the endpoint/model values you
> enter in the dashboard, and **(b)** a one-time seed — if they're still set on a
> legacy deployment they're migrated into the DB on first boot, then ignored.
> Don't set them for a fresh install.

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

### Multiple providers & per-sub-agent models (0.4.15)

The CLI config (`~/.config/brainrouter/config.json`) takes a single main `llm`
plus an optional `providers` map of **named OpenAI-compatible endpoints**, and an
`agentModels` map that routes each **sub-agent role** to a provider/model. So the
explorer can run a cheap/fast model while the reviewer runs a strong one; a role
with no entry inherits the main `llm` exactly as before.

```json
{
  "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-5.3", "endpoint": "https://api.openai.com/v1" },
  "providers": {
    "groq":  { "provider": "groq", "apiKey": "gsk_...", "model": "llama-3.3-70b", "endpoint": "https://api.groq.com/openai/v1" },
    "local": { "provider": "lmstudio", "apiKey": "", "model": "qwen2.5-coder-7b", "endpoint": "http://localhost:1234/v1" }
  },
  "agentModels": {
    "default":  { "provider": "groq" },                       // every sub-agent unless overridden
    "explorer": { "provider": "local" },                      // cheap/local for exploration
    "reviewer": { "model": "gpt-5.3-codex" }                  // main provider, a stronger model
  }
}
```

Roles: `default · explorer · architect · reviewer · worker · verifier`. An entry
with only `model` keeps the main provider's endpoint/key; with a `provider` it
uses that named endpoint (and its default model unless `model` is given). The
wire format is always OpenAI-compatible. Manage it from `/config` → **LLM
providers** + **Sub-agent models**, or the Desktop **Connectors** settings.

---

## Embedding provider

The MCP server uses embeddings for the vector retriever. The endpoint
defaults to OpenAI's, but vector search stays inactive until you set an
embedding key. Any OpenAI-compatible `/v1/embeddings` endpoint works.

```env
BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_API_KEY=sk-...       # falls back to BRAINROUTER_LLM_API_KEY
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
```

### Custom embedding endpoints

LM Studio, vLLM, Infinity, BAAI/bge-* via TEI — anything that speaks
`POST /v1/embeddings`:

```env
BRAINROUTER_EMBEDDING_ENDPOINT=http://localhost:8081/v1/embeddings
BRAINROUTER_EMBEDDING_API_KEY=local
BRAINROUTER_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
```

The **vector width is derived from the embedder automatically** — there is no
dimension to configure. `cognitive_vec` adopts the running store's width at boot
and re-dimensions to the embedder's real output length on the first write, so
swapping embedders just re-embeds; nothing to set (or mismatch) by hand.

---

## Reranker provider

A cross-encoder reranker rescores the top-K candidates before the final
gate. Optional but recommended for noisy stores. The reranker only
**reorders** — it never drops candidates.

### Cohere

```env
BRAINROUTER_RERANKER_ENDPOINT=https://api.cohere.com/v1/rerank
BRAINROUTER_RERANKER_API_KEY=...
BRAINROUTER_RERANKER_MODEL=rerank-english-v3.0
BRAINROUTER_RERANKER_TOP_N=10              # explicit top-K (server default is 5)
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

## Web search backend

In Desktop, `web_search` uses the workspace's persistent browser session and
Google results. Headless CLI use defaults to Google Programmable Search and
requires `cli.webSearch.google.apiKey` plus `cli.webSearch.google.cx`. You may
instead point at a custom backend:

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
| `BRAINROUTER_DATABASE_URL` | Postgres + pgvector connection (the memory store). The server will not start without it. |
| `BRAINROUTER_SECRET_KEY` | AES-256-GCM key that encrypts the DB-stored provider / integration keys. Required to save any secret from the dashboard. `openssl rand -base64 32`. |
| `BRAINROUTER_JWT_SECRET` | Session signing (sessions reset every boot without it). Required for any shared/hosted deploy. |

The LLM credential is **not** required here — AI providers are configured in the
dashboard (**Intelligence → Models & providers**) and stored in the DB (ADR-012).

### LLM core — server `.env` (`brainrouter/.env`) — SEED-ONLY / legacy

> These `BRAINROUTER_LLM_*` vars are **not** the live config path. Set the LLM
> provider in the dashboard instead; if these are still present on a legacy
> deployment they're migrated into the DB once on first boot, then ignored. Kept
> here as a reference for the endpoint/model values you'll enter in the dashboard.
> (The CLI chat agent is configured separately in `config.json` `llm.*`.)

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_LLM_ENDPOINT` | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible chat endpoint. |
| `BRAINROUTER_LLM_MODEL` | `gpt-4o-mini` | Chat model. |
| `BRAINROUTER_EXTRACTION_MODEL` (`brainrouter/.env`) | inherits | Cheaper/faster model for cognitive extraction. |
| `BRAINROUTER_SYNTHESIS_MODEL` (`brainrouter/.env`) | inherits | Smarter model for scene/identity distillation. |
| `BRAINROUTER_LLM_TIMEOUT_MS` | _(none — no timeout)_ | Per-call LLM timeout (extraction / synthesis). **Default: none — the call waits for the server** (a local LLM or a saturated backend can take minutes; aborting just drops the extraction). Set a positive ms value to bound all generative calls. Not propagated CLI → MCP. |
| `BRAINROUTER_LOCAL_LLM_MIN_TIMEOUT_MS` | _(none)_ | **Opt-in** timeout floor for **local** backends (`localhost`/`127.0.0.1`/`::1`). Unset = no floor (wait for the server). Set e.g. `600000` to floor local-endpoint calls at 10 min. |
| `BRAINROUTER_EXTRACTION_TIMEOUT_MS` | inherits `BRAINROUTER_LLM_TIMEOUT_MS` (none) | Override the per-call timeout for cognitive-extraction calls specifically. Default none — set a positive ms value to bound. |
| `BRAINROUTER_LLM_MAX_CONCURRENT` | `2` | Global cap on in-flight LLM calls **from the MCP process**; `<1` = uncapped. 1 for single-GPU LM Studio, 16+ for cloud. (The CLI pool is a separate `cli.*` knob.) |
| `BRAINROUTER_INLINE_EXTRACTION` | _(unset → deferred)_ | `on` blocks the `memory_capture_turn` reply on cognitive extraction (synchronous; debug only). Default backgrounds it so the MCP reply never waits on the LLM. |

### Embedding — `brainrouter/.env` — SEED-ONLY / legacy (set the embedder in the dashboard)

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_EMBEDDING_ENDPOINT` | `https://api.openai.com/v1/embeddings` | OpenAI-compatible `/v1/embeddings`. Vector search stays inactive until an embedding key is configured. |
| `BRAINROUTER_EMBEDDING_API_KEY` | inherits `BRAINROUTER_LLM_API_KEY` | Embedding credential. |
| `BRAINROUTER_EMBEDDING_MODEL` | `text-embedding-3-small` | e.g. `text-embedding-3-small`, `BAAI/bge-large-en-v1.5`. |
| `BRAINROUTER_EMBEDDING_TIMEOUT_MS` | _(none — no timeout)_ | Per-call embedding timeout. **Default: none — the embed call waits for the server** rather than degrading recall to FTS-only on a slow-but-alive embedder (0.4.15). Set a positive ms value (floored to 1000) as an opt-in backstop. |

> The vector **width** is DB-driven — derived from the embedder automatically
> (no `BRAINROUTER_EMBEDDING_DIMENSIONS` any more). `cognitive_vec` adopts the
> running store's width at boot and re-dimensions to the embedder's real output
> length on the first write.

### Reranker — `brainrouter/.env` — SEED-ONLY / legacy (set the reranker in the dashboard); the tuning knobs below are live

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_RERANKER_ENDPOINT` | _(unset — disables rerank)_ | Cohere or vLLM `/v1/rerank`. |
| `BRAINROUTER_RERANKER_API_KEY` | _(unset)_ | Reranker credential. |
| `BRAINROUTER_RERANKER_MODEL` | `rerank-english-v3.0` | e.g. `rerank-english-v3.0`, `BAAI/bge-reranker-v2-m3`. |
| `BRAINROUTER_RERANKER_TOP_N` | `5` | Top-K returned by the reranker. |
| `BRAINROUTER_RERANKER_TIMEOUT_MS` | _(none — no timeout)_ | Per-call reranker timeout. **Default: none — recall waits for the reranker** however long it takes; only a genuine failure (connection refused/reset, HTTP error, bad body) falls back to RRF. Aborting a slow-but-alive cross-encoder silently degraded every recall to RRF, which is why the bound is now opt-in. Set a positive ms value (floored to 1000, no upper clamp) as a backstop against a server that holds the socket but never replies. |
| `BRAINROUTER_RERANKER_MAX_CONCURRENT` | `8` | In-flight cap on outbound rerank requests from this process (separate pool from the generative + embedding caps). **Default 8** — concurrent recalls are safe now that there's no per-call timeout to blow. Set `0` (or `<1`) for **unbounded** on a scalable GPU/vLLM/Cohere backend; set `1` to serialize against a strictly single-worker server. |
| `BRAINROUTER_RERANKER_ACQUIRE_WAIT_MS` | _(none — queue for the slot)_ | Max time a recall waits for a reranker slot before shedding to RRF. **Default: none — the recall queues for the slot indefinitely, so no recall is dropped under parallel load** (it waits its turn). Set a positive ms value (floored to 1000) to **opt into** load-shedding to RRF when the slot stays busy. Shedding is NOT a failure — it never trips the breaker. |
| `BRAINROUTER_RERANKER_BREAKER_THRESHOLD` | `0` (disabled) | Consecutive reranker failures before the circuit opens. **Default 0 = breaker OFF** — every recall attempts the cross-encoder and surfaces its own failure (RRF for that call only) instead of pre-emptively skipping the server for a cooldown. Set N>0 to enable outage-dampening. |
| `BRAINROUTER_RERANKER_BREAKER_COOLDOWN_MS` | `30000` | While open, the reranker is skipped entirely (recall uses RRF, no network wait) for this long, then retried. Only applies when `…BREAKER_THRESHOLD` > 0. |
| `BRAINROUTER_RERANKER_MAX_DOC_CHARS` | `1500` | Per-doc chars sent to the cross-encoder (0.4.14). Covers a whole chunk instead of the old hardcoded 700; clamped [100, 8000]. Raise for larger-context rerankers, lower for strict 512-token ones. |
| `BRAINROUTER_RECALL_RERANK_BLEND_ALPHA` | `1.0` | MEM-BLEND (0.4.14): weight of the cross-encoder relevance vs the pre-rerank score (RRF + half-life recency), by **reciprocal rank** (cross-encoder scores are bimodal, so a raw-score blend is a no-op). `1` = pure reranker; `0` = pure retriever order. Default **1.0** (trust the reranker — on reranker-favorable queries blending in the weaker lexical order hurts); MEM-ROUTE lowers it per query type so the retriever/recency wins for reflective/synthesis. Clamp [0,1]. |
| `BRAINROUTER_RECALL_RERANK_CHAR_BUDGET` | `30000` | MEM-RERANK2 (0.4.14): total character budget sent to the cross-encoder (latency ∝ Σ doc-chars). Budgeting by chars rather than a fixed count adapts to doc length — long-doc corpora send ~20 candidates (cuts long-session latency ~1.5×: 22.7s→14.8s, recall fully held), short-doc corpora send the whole pool (deep gold still rescued). The tail keeps its pre-score order and is appended (no recall loss). Clamp [1500, 500000]. |
| `BRAINROUTER_RECALL_QUERY_ROUTING` | `on` | MEM-ROUTE (0.4.14): query-type routing. Reflective/analytical queries ("most likely sentiment", "overall pattern", "how do they feel") are detected by a zero-cost heuristic and **skip the cross-encoder** — its surface-similarity scoring demotes their low-overlap gold, and the plain retriever path measurably beats it there (os-rm `full` R-any@10 0.73→0.87). Factual/conversational queries keep the reranker. `off` to always rerank. |

### Recall pipeline widths — `brainrouter/.env`

How many candidates flow through each retrieval stage, plus the
no-cross-encoder diversity selector.

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_RECALL_FTS_LIMIT` | `15` | Stage-1 FTS5/BM25 keyword candidate pool. Clamp [1, 200]. |
| `BRAINROUTER_RECALL_VEC_LIMIT` | `15` | Stage-1 vector candidate pool. Clamp [1, 200]. |
| `BRAINROUTER_RECALL_RERANK_POOL` | `20` | Merged RRF pool fed to the reranker. Clamp [1, 200]. |
| `BRAINROUTER_RECALL_TOP_RESULTS` | `5` | Final result count when the reranker is off. Clamp [1, 200]. |
| `BRAINROUTER_RECALL_DIVERSITY` | `on` | MMR diversity selection on the no-cross-encoder path. `off` ranks by score alone. |
| `BRAINROUTER_RECALL_DIVERSITY_LAMBDA` | `0.7` | Diversity↔relevance tradeoff (0 = diversity-only, 1 = relevance-only). Clamp [0, 1]. |

### Memory engine — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_DATABASE_URL` | _(required)_ | Postgres + pgvector connection string (SQLite removed, ADR-007). `DATABASE_URL` is also accepted. The engine connects + migrates **lazily on first use** and closes the pool on SIGINT/SIGTERM. |
| `BRAINROUTER_REDIS_URL` | _(unset → in-process)_ | **Optional** read cache for hot global data (CVE catalog list/detail, hot dashboard GETs). `REDIS_URL` is also accepted. Purely an accelerator — with it unset, or if Redis is unreachable, the server transparently uses a bounded in-process TTL cache with identical correctness. Set it to share the cache across replicas and survive restarts. Needs the optional `ioredis` package (baked into the Docker image; compose wires the bundled `redis`). |
| `BRAINROUTER_HOME` | `~/.brainrouter` | Per-user state root. Honored by both processes. |
| `BRAINROUTER_LOCAL_ROOT` | _(unset)_ | Override the local-state root. |
| `BRAINROUTER_IMPORT_CHUNK_CHARS` | `1500` | Chunk records longer than this on `memory_import` (0.4.14) so recall stages get focused units (child id `${parent}::c{i}`, parent in metadata). `0` disables. |
| `BRAINROUTER_IMPORT_EMBED` | `1` (on) | Embed imported records immediately (0.4.14) for instant vector recall instead of waiting on the background sweep. `0` = backfill via the sweep (faster bulk import). |
| `BRAINROUTER_EMBED_CONCURRENCY` | `8` | Cap of the **dedicated embedding pool** (0.4.15) — bulk embedding AND the recall query-embed. Independent of `BRAINROUTER_LLM_MAX_CONCURRENT` (pre-0.4.15 the embedder shared the generative semaphore, so a recall query-embed could stall behind a slow generation). Lower it if the embedder shares a single GPU with the generative model. |
| `BRAINROUTER_GRAPH_ENABLED` | `true` | 2-hop graph extraction + BFS expansion. |
| `BRAINROUTER_GRAPH_TIMEOUT_MS` | _(superseded — no timeout)_ | Graph-extraction LLM timeout. Superseded by the no-timeout policy: extraction waits for the server. Set `BRAINROUTER_LLM_TIMEOUT_MS` to bound generative calls globally. |
| `BRAINROUTER_CONTRADICTION_TIMEOUT_MS` | _(superseded — no timeout)_ | Contradiction-check timeout. Superseded by the no-timeout policy — see `BRAINROUTER_LLM_TIMEOUT_MS`. |
| `BRAINROUTER_CONTRADICTION_MAX_CANDIDATES` | `3` | Records compared against each new memory for contradictions (one LLM call each). Capped 5→3 in 0.4.15 to bound per-record fan-out. Clamp ≥1. |
| `BRAINROUTER_NEURAL_SPARK_ENABLED` | `true` | 2-hop spreading activation (firing/propagation, Hebbian LTP, LTD decay+prune). When `false`, recall ranks on the plain scored/reranked set. |
| `BRAINROUTER_BLACKBOARD_ADMISSION` | `on` | Stage newly extracted records on a blackboard before committing to cognitive memory. `off` admits every record directly (skips staging). |
| `BRAINROUTER_DEDUP_MODE` | `off` | Apply-time dedup guard for new records: `off` · `strict` (content-hash) · `fuzzy`. The LLM dedup still runs regardless; this is a deterministic second pass. |
| `BRAINROUTER_PROVENANCE_FLOOR` | `0.3` | Min fraction of a record's tokens a source chunk must contain to be linked as provenance. Clamp [0, 1]. |
| `BRAINROUTER_PROVENANCE_MAX_CHUNKS` | `3` | Max source chunks linked per record (best-first). Clamp ≥1. |
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

### Background jobs, sweepers & scene tree — `brainrouter/.env`

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_JOB_RUNNER` | `on` | In-process runner that drains out-of-band `memory_jobs` (graph/contradiction/focus/depth). `off` to disable. |
| `BRAINROUTER_JOB_RUNNER_INTERVAL_MS` | `3000` (3s) | Drain tick. Keep it short — a large value delays every deferred job by that interval. |
| `BRAINROUTER_JOB_MAINTENANCE` | `on` | Auto-enqueue maintenance depth agents (`blackboard_reconciler` per user, `vault_exporter` ~hourly). Requires the job runner. `off` to disable. |
| `BRAINROUTER_BENCH_SCHEDULE` | `on` | Auto-schedule the retrieval benchmark (`benchmark_eval`) from maintenance (~daily). `off` keeps it on-demand only (expensive, ~5 min/run). |
| `BRAINROUTER_TREE_AUTOBUILD` | `on` | Grow the durable scene-summary tree during the maintenance pass. `off` keeps it on-demand (`memory_tree_walk`). |
| `BRAINROUTER_TREE_MIN_SCENE_RECORDS` | `3` | Min cognitive records in a scene before it earns a tree leaf. |
| `BRAINROUTER_TREE_LEAF_PER_PASS` | `5` | Max leaves built per maintenance tick. |
| `BRAINROUTER_TREE_SEAL_THRESHOLD` | `6` | Unsealed topic leaves that eagerly seal into a parent summary. |
| `BRAINROUTER_TREE_IDLE_SEAL_FLOOR` | `2` | Seal a *settled* bucket (a pass added no new leaf) at this many unsealed leaves, even below the eager threshold. |
| `BRAINROUTER_TREE_GLOBAL_ROLLUP` | `3` | Unsealed global roots that trigger a global rollup digest. |
| `BRAINROUTER_DISABLE_SESSION_SWEEPER` | `false` | `true` disables the stale-federation-session sweeper. |
| `BRAINROUTER_SESSION_SWEEP_INTERVAL_MS` | `60000` (1m) | Session sweeper tick (floor 10s; below it the sweep is disabled). |
| `BRAINROUTER_SESSION_SWEEP_MAX_AGE_MS` | `300000` (5m) | Evict `active_sessions` rows whose last heartbeat is older than this. |
| `BRAINROUTER_DISABLE_INBOX_SWEEPER` | `false` | `true` disables the cross-session inbox sweeper. |
| `BRAINROUTER_INBOX_SWEEP_INTERVAL_MS` | `300000` (5m) | Inbox sweeper tick (floor 30s; below it the sweep is disabled). |
| `BRAINROUTER_INBOX_SWEEP_MAX_AGE_MS` | `3600000` (1h) | Drop delivered `session_inbox` rows older than this. |

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
| `maxOutputTokens` | _(unset)_ | Cap on **completion** tokens per LLM call (`max_tokens` on the wire). Unset sends no cap, so the provider's own default applies — but some endpoints default to a *low* cap that truncates long answers mid-sentence. Set this (e.g. `8192`) to lift that cap. `0` / negative = unset. |
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
| `sandboxEnforceWhenSilent` | `true` | Force the sandbox **on** for silent / unattended agents (cloud workers, spawned children, non-interactive runs) even when `sandbox: off`. When enforced, outbound network is denied and a missing sandboxer fails closed (`sandboxUnavailable: deny`), and `background: true` runs are refused (they would escape the sandbox). Set `false` to let unattended shells run with the same posture as interactive ones. Mirrors `cli.hooks.enforceWhenSilent`. |
| `autoChainMaxFollowups` | `2` | Cap on auto-chained review/verify follow-ups per worker. |
| `agentMcpToolBudget` | `16` | Cap on MCP tools shown to an agent per turn (0 = no cap). |
| `workspaceOverride` | _(auto)_ | Override the CLI workspace root. |

### Requirement to Track automation

Automation is disabled by default. Enable the global switch and only the stages
you have dogfooded for the workspace:

```json
{
  "cli": {
    "automation": {
      "enabled": true,
      "requirements": { "enabled": true, "autoCreateThreshold": 0.7, "lowActThreshold": 0.4, "autopilot": false },
      "sync": { "enabled": true },
      "sprints": { "enabled": false, "minItems": 3, "respectCapacity": true, "autopilot": false }
    }
  }
}
```

Autonomy is **tiered** — the deeper a stage's blast radius, the more it defers
to you:

- `requirements` captures high-confidence implementation requests as `auto`
  drafts. With `autopilot: false` (default) a draft is **proposed** — the agent
  surfaces a one-click promote and the plan/Track cascade only fires once the
  requirement is `ready` (run `/requirement promote <id>`, or click **Plan &
  track** in the Requirements panel). With `autopilot: true`, a confident
  detection that has concrete acceptance criteria is created `ready` directly, so
  the cascade runs unattended.
- `sync` reconciles a ready requirement, its session plan, Track items, and
  code-link progress. A completed goal reconciles its anchored requirement when
  the global switch is enabled.
- `sprints` with `autopilot: false` (default) only **suggests** ("N ready items —
  start a sprint?" / "this sprint is all done — complete it?") and never touches
  the board — a human makes the irreversible call. With `autopilot: true` it
  auto-creates a future sprint, assigns ready items, and completes a done one
  (it still never auto-*starts* a sprint).

Disable the global switch to stop every automatic stage immediately.

### Commit scanner — code → Track without a tool call

```json
{ "cli": { "track": { "commitScanner": { "enabled": false, "scanDepth": 50 } } } }
```

`/track commits [--depth N] [--since <when>]` parses `<KEY>-<n>` references (e.g.
`BR-123`) out of recent commit messages and **links each commit to its work
item** (deduped by sha) while **advancing `todo` → `in-progress`** — the same
code-signal transition the agent gets from `track_update link`, but driven by the
git history so the board stays in sync even when the agent forgets to link.
Done items still get the commit linked (provenance) but are never moved back. In
the desktop, **Track → Sync → Scan commits** does the same. Idempotent — re-runs
are a no-op.

### Sandboxing — shell env

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_SANDBOX` | _(unset)_ | Set to `on` to wrap `run_command` in `sandbox-exec` (mac) / `bwrap` / `firejail` (Linux). |
| `BRAINROUTER_SANDBOX_NETWORK` | `off` | Allow outbound network from sandboxed commands. |
| `BRAINROUTER_SANDBOX_READ_PATHS` | _(unset)_ | `:`-separated allowlist of read paths. |
| `BRAINROUTER_SANDBOX_WRITE_PATHS` | _(unset)_ | `:`-separated allowlist of write paths. |

### Server / auth + HTTP transport — `brainrouter/.env`

These apply to the **HTTP** MCP transport + dashboard (`npm run start:http`);
the stdio transport ignores JWT/CORS/rate-limit.

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_API_KEY` | _(unset)_ | Static API key for the **stdio** transport (also settable via `--apiKey`). HTTP clients authenticate with a `users.api_key` bearer token instead. |
| `BRAINROUTER_JWT_SECRET` | random per-boot | Dashboard JWT signing key. **Set a fixed 32-byte hex in production** — a random per-boot secret resets all sessions on restart. |
| `BRAINROUTER_JWT_EXPIRES_SECS` | `3600` (1h) | Access-token lifetime. |
| `BRAINROUTER_REFRESH_EXPIRES_SECS` | `2592000` (30d) | Refresh-token lifetime. |
| `BRAINROUTER_DEFAULT_ADMIN_USER_ID` | `admin` | Seeded admin user id (when the users table is empty). |
| `BRAINROUTER_ADMIN_EMAIL` | `admin` | Seeded admin email. |
| `BRAINROUTER_ADMIN_PASSWORD` | _(unset; required to seed)_ | Seeded admin password. If unset, password auth is not seeded. |
| `BRAINROUTER_USER_ID` | `default` | Stdio fallback user id when no authenticated mapping exists. |
| `BRAINROUTER_CORS_ORIGIN` | `http://localhost:3000` | Dashboard CORS allowlist (comma-separated; `*` matches all). |
| `BRAINROUTER_RATE_LIMIT_MAX` | `600` | Max requests per window across `/api` `/v1` `/mcp`. `0` disables rate limiting. |
| `BRAINROUTER_RATE_LIMIT_WINDOW_MS` | `60000` (1m) | Rate-limit window. |
| `BRAINROUTER_MAX_BODY_SIZE` | `16mb` | Max JSON request body (`express.json` limit; e.g. `32mb`). |
| `BRAINROUTER_ENV_FILE` | _(unset)_ | Explicit path to the server env file; overrides the loader's default search order. |

### Hook context (auto-injected)

The CLI injects these into the child process env when running shell hooks
(`pre-turn`, `post-turn`, `pre-tool`, `post-tool`, etc.). You don't set
them; hook scripts read them.

| Var | Purpose |
| --- | --- |
| `BRAINROUTER_HOOK_EVENT` | Event name (`pre-tool`, `pre-turn`, …). |
| `BRAINROUTER_HOOK_TOOL` | Tool name (for `pre-tool` / `post-tool`). |
| `BRAINROUTER_HOOK_PAYLOAD` | JSON payload for the event. |

### Hook enforcement (`cli.hooks`)

```json
{ "cli": { "hooks": { "enabled": true, "enforceWhenSilent": true } } }
```

- **`enabled`** (default `true`) — master switch for ALL lifecycle hooks.
- **`enforceWhenSilent`** (default `true`) — runs the *blocking* events
  (`pre-tool`, `user-prompt-submit`) for **silent / unattended** agents too —
  deep workers, headless, and background/cloud runs — so a `pre-tool` deny hook
  (non-zero exit or `{"decision":"deny"}`) enforces policy regardless of who is
  driving. Advisory events (`pre/post-turn`, `post-tool`, `pre-compact`) stay
  interactive-only. Set `false` to restore the old interactive-only behaviour.

A `pre-tool` deny is enforcement, not advice: it blocks the call before the
model can run it — the deterministic, model-independent guardrail for autonomy.

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

API keys live in the `users.api_key` column of the Postgres store. Generate via the
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
# cognitive memory now lives in Postgres (BRAINROUTER_DATABASE_URL), not a local file
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

### Unattended enforcement

Interactive sessions have a human who can notice and reject a risky shell call;
silent / unattended agents (cloud workers, spawned children, non-interactive
runs) do not. So when an agent runs silent, `cli.sandboxEnforceWhenSilent`
(default **`true`**) forces the strictest posture regardless of the looser
interactive `cli.sandbox*` settings:

- the sandbox is **on** even when `cli.sandbox: off`;
- outbound network is **denied** (overrides `sandboxNetwork: true`);
- a missing sandboxer **fails closed** (overrides `sandboxUnavailable`);
- `background: true` runs are **refused** — they execute unsandboxed and would
  otherwise let a silent agent escape the enforced sandbox.

Sandboxed `run_command` output is badged `(enforced: unattended)` when this
applies. Set `cli.sandboxEnforceWhenSilent: false` to let unattended shells run
with the same posture as interactive ones (e.g. to re-enable background runs in
a trusted CI worker). The macOS profile resolves symlinked write roots (`/tmp`,
`/var/folders/...` → `/private/...`) to their realpath so workspace writes are
not silently denied.

---

## Backpressure

Running BrainRouter against a single local LLM (LM Studio with one GPU,
Ollama, single-replica vLLM) can fan out many concurrent calls per turn:
chat reply, extractor, contradiction checks (one per neighbor up to
`BRAINROUTER_CONTRADICTION_MAX_CANDIDATES`, default 3), graph extraction
(one per record), focus-shift detection, sweeper, plus
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

## Vulnerability intelligence

BrainRouter keeps a durable global CVE catalog current in the background and
uses organization-scoped inventories for exact repository exposure. NVD is the
catalog source, CISA KEV supplies exploited-in-the-wild priority, FIRST EPSS
supplies probability, and OSV matches exact package versions. Catalog presence
or a product-name mention never proves that a repository is affected.

The job runner schedules a source refresh automatically. A production Compose
deployment runs this responsibility in the dedicated `worker` service; a
single-process deployment may leave `BRAINROUTER_JOB_RUNNER=on`. Source cursors,
last success, failures, and checksums/ETags where available are stored in
PostgreSQL and displayed at Dashboard → Vulnerabilities.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NVD_API_KEY` | _(unset)_ | Optional server-only NVD API key. Recommended for production rate limits; never returned to clients. |
| `BRAINROUTER_VULNERABILITY_SYNC` | `on` | Enables scheduled NVD, KEV, and EPSS refresh plus watched-inventory re-evaluation. Set `off` only for an intentional maintenance stop. |
| `BRAINROUTER_VULNERABILITY_SYNC_INTERVAL_MS` | `900000` | Eligibility interval for a normal source refresh. The shared maintenance runner checks on its own bounded cadence. |
| `BRAINROUTER_VULNERABILITY_PARTIAL_SYNC_INTERVAL_MS` | `60000` | Eligibility interval while an NVD pagination/window cursor is incomplete. |

Manual source refresh requires `vulnerabilities:manage`. Repository scanning
requires `vulnerabilities:scan` and current repository access; reading the
catalog/findings requires `vulnerabilities:read`. The scanner accepts supported
lockfiles/manifests or CycloneDX SBOMs, persists only exact component versions,
and executes OSV matching as a background `vulnerability_scan` job. A future-CVE
watch rechecks that stored inventory after feed refresh; error rows remain
visible and retry through the durable job queue.

Agents do not need a separate toggle. CVE/security/advisory/exploit/affected-
version turns automatically receive a bounded `vulnerability_intelligence`
briefing from the persisted catalog, including freshness warnings. Security and
code reviews use the same catalog and exact repository matches without fetching
public feeds on the review request path.

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
