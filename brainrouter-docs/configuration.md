# Configuration

Full reference: env vars, providers, transports, storage, sandboxing,
backpressure, diagnostics.

## Two `.env` files, one per process

The MCP server and the CLI agent are separate processes with separate
concerns. They each get their own `.env`:

| File | Owns |
| --- | --- |
| **`brainrouter/.env`** | MCP server: cognitive-extraction LLM, embeddings, reranker, memory engine knobs, server auth, JWT, admin seed. |
| **`brainrouter-cli/.env`** | CLI agent: chat LLM, tool loop limits, sandbox, web search backend, trace log, workspace override. |

Templates: [`brainrouter/.env.example`](../brainrouter/.env.example) and
[`brainrouter-cli/.env.example`](../brainrouter-cli/.env.example) — copy
the ones you need to drop the `.example` suffix.

### Why two files?

- The MCP's cognitive extractor and the CLI's chat agent can run on
  different models (cheap local model for extraction, smart cloud model
  for chat). Each side picks its own `BRAINROUTER_LLM_*`.
- Concurrency caps default differently per process
  (`BRAINROUTER_LLM_MAX_CONCURRENT` is 2 in MCP, 4 in CLI). If both
  processes read the same file, one always loses.
- CLI-only knobs (`BRAINROUTER_SANDBOX`, `BRAINROUTER_AUTO_COMPACT_TOKENS`,
  `BRAINROUTER_MAX_TOOL_LOOPS`, etc.) have no meaning in the MCP and
  shouldn't pollute its env.

The CLI used to load `brainrouter/.env` as a single source of truth;
that's now legacy. The CLI auto-loads `brainrouter-cli/.env` first and
falls back to `brainrouter/.env` only for the LLM credentials — so a
single-file legacy setup keeps working until you migrate.

### Loading & propagation

- **MCP server**: `import "dotenv/config"` at startup. The CLI hints the
  spawned MCP child's cwd at `brainrouter/`, so `brainrouter/.env` is
  picked up automatically.
- **CLI agent**: explicit loader reads `brainrouter-cli/.env` first, then
  `brainrouter/.env` as a credentials fallback.
- **Shell env always wins**: anything already in `process.env` (exported
  in your shell, set via Docker `-e`, etc.) beats both files.
- **CLI → MCP child propagation** filters out CLI-only and
  process-specific vars (`BRAINROUTER_SANDBOX*`, `BRAINROUTER_MAX_TOOL_LOOPS`,
  `BRAINROUTER_LLM_MAX_CONCURRENT`, `BRAINROUTER_TRACE_LOG`, …) so they
  don't leak into the MCP child.

## Quick start (minimal)

```env
# brainrouter/.env
BRAINROUTER_LLM_API_KEY=sk-...
```

That's the minimum. Defaults: OpenAI `https://api.openai.com/v1/chat/completions`
with `gpt-4o-mini`, no embeddings, no reranker, memory store at
`~/.brainrouter/memory.db`.

For independent control of the CLI's chat LLM (recommended):

```env
# brainrouter-cli/.env
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_MODEL=gpt-4o
```

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

A cross-encoder reranker rescores the top-K System-1 candidates before
graph expansion. Optional but recommended for noisy stores.

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
| `BRAINROUTER_LLM_API_KEY` | LLM credential. Falls back to `OPENAI_API_KEY`. Set in both `brainrouter/.env` (extractor) and `brainrouter-cli/.env` (chat agent) — they can be different values. |

### LLM core — `brainrouter/.env` and `brainrouter-cli/.env`

Same var names, two files. The MCP's LLM is the cognitive extractor; the
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
| `BRAINROUTER_PERSONA_CACHE_TTL_MS` | `3600000` (1h) | L3 persona cache lifetime. |
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

### CLI runtime — `brainrouter-cli/.env`

These never propagate to the MCP child.

| Var | Default | Purpose |
| --- | --- | --- |
| `BRAINROUTER_MCP_TIMEOUT_MS` | `60000` | Per-tool MCP timeout. |
| `BRAINROUTER_MAX_TOOL_RESULT_CHARS` | `8000` | Clamp on tool-result body sent back to the LLM. |
| `BRAINROUTER_AUTO_COMPACT_TOKENS` | `80000` | Auto-`/compact` trigger threshold. |
| `BRAINROUTER_MAX_TOOL_LOOPS` | `60` | Hard cap on tool iterations per turn. |
| `BRAINROUTER_TRACE_LOG` | _(unset)_ | Path for OTEL-style JSONL turn traces. |
| `BRAINROUTER_WEB_SEARCH_ENDPOINT` | _(falls back to DuckDuckGo)_ | Custom search backend. |
| `BRAINROUTER_WORKSPACE` | _(auto-detected)_ | Override CLI workspace root. |

### Sandboxing — `brainrouter-cli/.env`

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

## MCP client config

The CLI picks an MCP server from `~/.config/brainrouter/config.json`:

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
~/.brainrouter/                          ← user-global (override: BRAINROUTER_HOME)
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
        │   ├── preferences.json         # theme, statusline, vim, personality
        │   ├── hooks.json               # shell lifecycle hooks
        │   ├── sessions.json            # child-agent orchestration index
        │   ├── feedback.jsonl
        │   ├── current-workflow.json
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
