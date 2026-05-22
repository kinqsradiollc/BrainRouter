# @brainrouter/mcp-server

The cognitive memory engine behind [BrainRouter](https://github.com/kinqsradiollc/BrainRouter) — exposed as a [Model Context Protocol](https://modelcontextprotocol.io/) server so any MCP-speaking agent (Claude Desktop, Cursor, [`@brainrouter/cli`](https://www.npmjs.com/package/@brainrouter/cli), custom clients) can recall, capture, and reason over long-term memory.

## What it gives you

- **Long-term memory** — sensory log + cognitive extraction (L1 facts, L2 focus scenes, L3 persona) with decay, contradiction tracking, and citation reinforcement.
- **Recall surface** — `memory_recall`, `memory_search`, `memory_graph_query`, `memory_file_history`, `memory_failed_attempts`, `memory_explain_recall`.
- **Working memory** — `memory_working_context` / `memory_working_offload` for in-flight payloads that shouldn't bloat the LLM context.
- **Skill catalogue** — `list_skills`, `get_skill`, `search_skills`, `get_persona` — ships with 70+ canonical skills bundled at publish time.
- **HTTP and stdio transports** — run as a hosted service (HTTP/SSE) or spawn as a stdio child from any MCP client.

## Install

```bash
npm install @brainrouter/mcp-server
```

## Run

```bash
# HTTP transport on :3747
npx brainrouter-mcp --http --port 3747

# stdio (default — for clients that spawn the server themselves)
npx brainrouter-mcp
```

## Configure

Copy `.env.example` to `.env` and set at minimum:

```bash
BRAINROUTER_LLM_API_KEY=sk-...
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini

BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536

BRAINROUTER_ADMIN_PASSWORD=change_me_before_use
BRAINROUTER_JWT_SECRET=replace_with_a_long_random_secret
```

Full knob list (reranker, prewarming, focus-scene triggers, sweep intervals, JWT, CORS) lives in `.env.example` next to this README.

## Docs

- [BrainRouter overview](https://github.com/kinqsradiollc/BrainRouter)
- [What the memory engine does](https://github.com/kinqsradiollc/BrainRouter/blob/main/BRAINROUTER.md)
- [Deep dives](https://github.com/kinqsradiollc/BrainRouter/tree/main/brainrouter-docs)

## License

MIT
