# `@kinqs/brainrouter-mcp-server`

The cognitive memory engine behind [BrainRouter](https://github.com/kinqsradiollc/BrainRouter)
— exposed as a [Model Context Protocol](https://modelcontextprotocol.io/)
server so any MCP-speaking agent (Claude Desktop, Cursor,
[`@kinqs/brainrouter-cli`](https://www.npmjs.com/package/@kinqs/brainrouter-cli),
custom clients) can recall, capture, and reason over long-term memory.

Ships the `brainrouter-mcp` binary.

---

## What it gives you

- **Long-term memory** — sensory log + cognitive extraction (L1 facts, L2 focus scenes, L3 persona) with decay, contradiction tracking, and citation reinforcement.
- **Recall surface** — `memory_recall`, `memory_search`, `memory_graph_query`, `memory_file_history`, `memory_failed_attempts`, `memory_explain_recall`.
- **Working memory** — `memory_working_context` / `memory_working_offload` for in-flight payloads that shouldn't bloat the LLM context.
- **Skill catalogue** — `list_skills`, `get_skill`, `search_skills`, `get_persona` — ships with 70+ canonical skills bundled at publish time.
- **HTTP and stdio transports** — run as a hosted service (HTTP/SSE) or spawn as a stdio child from any MCP client.

---

## Install

```bash
npm install -g @kinqs/brainrouter-mcp-server
```

The `-g` flag is required so `brainrouter-mcp` lands on your `$PATH`.
See [`@kinqs/brainrouter-cli`'s README](https://www.npmjs.com/package/@kinqs/brainrouter-cli)
for the sudo / nvm caveats — the same rules apply.

Verify:

```bash
which brainrouter-mcp
brainrouter-mcp --version    # prints 0.3.5
```

---

## Configure

The server reads its config from a `.env` file. The challenge for a
globally-installed package is that you don't know where the package
lives, and even if you did, it's typically in a path you can't easily
edit (`/usr/local/lib/node_modules/...` or similar). To fix that, the
server looks for `.env` in three places, in order:

1. `$BRAINROUTER_ENV_FILE` — explicit override (set this when you want a
   per-project or per-deployment config).
2. `~/.config/brainrouter/server.env` — the canonical user location.
3. `./.env` — current working directory (matches the classic dotenv
   behavior; useful for monorepo dev).

At startup the server prints which path it loaded from, so there's never
any ambiguity:

```
env: loaded 17 vars from /Users/you/.config/brainrouter/server.env
```

### One-time setup

```bash
brainrouter-mcp init             # scaffolds ~/.config/brainrouter/server.env
$EDITOR ~/.config/brainrouter/server.env
```

`init` copies the package's bundled `.env.example` to
`~/.config/brainrouter/server.env` and chmods it to `0600`. It won't
overwrite an existing file.

### Minimum fields to set

```bash
# Cognitive extraction LLM (any OpenAI-compatible endpoint:
# OpenAI, OpenRouter, LM Studio, Ollama, vLLM…)
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini

# Embeddings — required for vector recall. Key falls back to BRAINROUTER_LLM_API_KEY.
BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536

# Server auth — change before exposing the server
BRAINROUTER_ADMIN_PASSWORD=change_me_before_use
BRAINROUTER_JWT_SECRET=replace_with_a_long_random_secret  # `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
```

Full knob list (reranker, prewarming, focus-scene triggers, sweep
intervals, JWT, CORS) lives in the bundled `.env.example` — view it
after `init` ran, or directly with:

```bash
cat "$(npm root -g)/@kinqs/brainrouter-mcp-server/.env.example"
```

---

## Run

```bash
# HTTP transport on :3747 — what the CLI connects to via login
brainrouter-mcp --http --port 3747

# stdio transport — for clients that spawn the server themselves
brainrouter-mcp
```

The server writes logs to stderr. To leave it running detached, use a
process manager (launchd / systemd / tmux / `nohup`) of your choice.

---

## Docs

- **Repo**: <https://github.com/kinqsradiollc/BrainRouter>
- **Memory engine deep-dive**: [BRAINROUTER.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/BRAINROUTER.md)
- **Maintainer runbook**: [SETUP.md](https://github.com/kinqsradiollc/BrainRouter/blob/main/SETUP.md)
- **Bugs / requests**: <https://github.com/kinqsradiollc/BrainRouter/issues>

---

## License

MIT
