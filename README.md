# BrainRouter

BrainRouter is a local-first MCP server, memory engine, and dashboard for AI coding agents. It stores agent conversations, extracts durable engineering memories, retrieves relevant context, and exposes governance and observability tools over MCP and HTTP.

This repository is the current implementation, not only a concept prototype. The source of truth is the TypeScript code under [mcp/src](./mcp/src), the shared packages under [packages](./packages), and the Next.js dashboard under [web](./web).

## Current Scope

BrainRouter currently provides:

- An MCP server with stdio and Streamable HTTP transports.
- API-key authentication for MCP clients.
- JWT and API-key authentication for REST APIs.
- Multi-user memory isolation through `userId`.
- SQLite storage at `~/.brainrouter/memory.db` by default, with FTS5 and optional sqlite-vec vector tables.
- L0 raw turn capture with sensitive-value redaction.
- L1 memory extraction through an OpenAI-compatible chat-completions endpoint.
- L1 deduplication, contradiction detection, GraphRAG extraction, L2 scene distillation, and L3 persona distillation.
- Hybrid recall using keyword search, optional vector search, file-path matching, RRF scoring, optional reranking, scene context, persona context, and graph expansion.
- Memory governance tools for update, evidence, export/import, audit, diagnostics, verification, and hard delete.
- Session-scoped working memory offload under `.brainrouter/work/<user>/<session>/`.
- Host hook ingestion for Claude Code, Codex, and generic MCP-style events.
- A Next.js dashboard for auth, memories, timeline, evidence, recall inspection, scenes, persona, users, hooks, working memory, and diagnostics.

BrainRouter does not currently expose a runtime `BRAINROUTER_LLM_MODE` agent/server mode switch in `mcp/src`. All registered MCP tools are listed by the server; `create_skill` and `update_skill` require an admin-authenticated user.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `mcp/` | MCP server, REST API, memory engine, SQLite store, tools, host integrations, and setup scripts. |
| `web/` | Next.js dashboard. The client defaults to `NEXT_PUBLIC_API_URL` or `http://localhost:3747`. |
| `packages/types/` | Shared API, memory, and store TypeScript types. |
| `packages/sdk/` | `BrainRouterClient`, a typed REST client for dashboard and external consumers. |
| `packages/hooks/` | React hooks that wrap the SDK for dashboard surfaces. |
| `agents/` | Agent-facing repository instructions and examples. |
| `skills/`, `references/`, `personas/`, `docs/templates/` | Global BrainRouter content loaded through MCP resource tools. |

## Requirements

- Node.js 22 or newer. The MCP package uses `node:sqlite`.
- npm 10 or newer.
- An OpenAI-compatible chat-completions endpoint if you want L1/L2/L3 extraction to run.
- Optional embedding and reranker endpoints for vector search and reranking.

## Install

```bash
npm install
npm run build
```

The root workspace scripts run package builds and tests across workspaces:

```bash
npm run build
npm test
```

## Configure

Copy the MCP environment example and edit it for your machine:

```bash
cp mcp/.env.example mcp/.env
```

The MCP server imports `dotenv/config`, so run server commands from `mcp/` when you want `mcp/.env` to load automatically:

```bash
cd mcp
npm run dev:http
```

Key settings:

- `BRAINROUTER_MEMORY_DB`: SQLite database path. Defaults to `~/.brainrouter/memory.db`.
- `BRAINROUTER_ADMIN_EMAIL` and `BRAINROUTER_ADMIN_PASSWORD`: initial admin credentials when the database is empty.
- `BRAINROUTER_JWT_SECRET`: persistent dashboard session signing key. If omitted, a random key is generated and sessions break on restart.
- `BRAINROUTER_LLM_API_KEY`, `BRAINROUTER_LLM_ENDPOINT`, `BRAINROUTER_LLM_MODEL`: OpenAI-compatible chat-completions config for extraction.
- `BRAINROUTER_EMBEDDING_*`: optional embeddings config. Without an embedding API key, recall falls back to keyword/file-path search.
- `BRAINROUTER_RERANKER_*`: optional reranking config.
- `BRAINROUTER_DISABLE_EXTRACTION_SWEEPER` and sweep interval variables: controls backlog recovery.

See [mcp/.env.example](./mcp/.env.example) for the complete current list.

## Create or Reset an Admin User

The server seeds an admin user on first boot if the database has no users. You can also create or reset one explicitly:

```bash
cd mcp
BRAINROUTER_MEMORY_DB=/path/to/memory.db \
BRAINROUTER_ADMIN_EMAIL=admin@example.com \
BRAINROUTER_ADMIN_PASSWORD='change-me' \
npm run setup:admin -- --reset --userId admin
```

The script prints the API key once. MCP clients need that key as `BRAINROUTER_API_KEY` or `--apiKey`.

## Run MCP over stdio

Build first, then configure your MCP client to spawn the compiled server:

```json
{
  "mcpServers": {
    "brainrouter": {
      "command": "node",
      "args": [
        "/Users/anhdang/Documents/Github/BrainRouter/mcp/dist/index.js",
        "--root",
        "/path/to/workspace"
      ],
      "env": {
        "BRAINROUTER_API_KEY": "br_your_api_key"
      }
    }
  }
}
```

`--root` selects the local workspace whose `brainrouter.config.json`, local skills, references, personas, and template docs should be merged with the global BrainRouter registry. If omitted, the resolver tries `BRAINROUTER_LOCAL_ROOT`, then auto-detection, then falls back to this repository.

## Run MCP over HTTP

```bash
cd mcp
npm run dev:http
```

Default endpoints:

- Health: `GET http://localhost:3747/health`
- MCP Streamable HTTP: `POST/GET/DELETE http://localhost:3747/mcp`
- REST API: `http://localhost:3747/api/...`

HTTP MCP requests must send `Authorization: Bearer <api-key>`. Streamable HTTP clients should also send an MCP-compatible `Accept` header such as `application/json, text/event-stream`.

## Run the Dashboard

```bash
cd web
npm run dev
```

Open `http://localhost:3000`. The dashboard talks to `NEXT_PUBLIC_API_URL` or `http://localhost:3747` by default. Sign in with the admin email/password or use open signup to create a non-admin user.

## Main MCP Tools

Content and registry tools:

- `list_skills`, `get_skill`, `search_skills`
- `get_persona`, `get_reference`
- `list_template_docs`, `get_template_doc`
- `create_skill`, `update_skill` (admin only)

Memory tools:

- `memory_resolve_session`
- `memory_capture_turn`
- `memory_recall`
- `memory_search`
- `memory_graph_query`
- `memory_contradictions`
- `memory_mark_cited`
- `memory_register_skill_hints`
- `memory_explain_recall`

Governance tools:

- `memory_get`
- `memory_update`
- `memory_evidence_add`
- `memory_evidence_get`
- `memory_export`
- `memory_import`
- `memory_governance_delete`
- `memory_audit`
- `memory_diagnostics`

Engineering workflow tools:

- `memory_debug_trace_save`
- `memory_debug_trace_search`
- `memory_failed_attempts`
- `memory_file_history`
- `memory_task_state`
- `memory_task_update`
- `memory_handover`
- `memory_verify`

Host and working-memory tools:

- `memory_hook_register`
- `memory_hook_status`
- `memory_working_context`
- `memory_working_offload`
- `memory_working_reset`

See [BRAINROUTER.md](./BRAINROUTER.md) for the tool behavior and REST route map.

## Memory Flow

1. A client resolves a stable session with `memory_resolve_session`.
2. The agent captures messages with `memory_capture_turn`.
3. L0 messages are redacted and stored in SQLite.
4. Every captured turn currently meets the extraction threshold, so pending L0 messages are sent to the L1 extractor.
5. Extracted L1 records are deduplicated, stored, and optionally embedded.
6. Contradiction detection, graph extraction, L2 scene work, and L3 persona work run in background paths.
7. Recall combines FTS, optional vector search, file-path matches, priority decay, citation boosts, optional reranking, scene context, persona context, and graph expansion.
8. `memory_mark_cited` feeds the ACE citation loop and can auto-archive repeatedly ignored memories.

## REST API

The REST API is intended for the dashboard, SDK, and host integrations. Most routes accept either a JWT from `/api/auth/signin` or an API key as `Authorization: Bearer ...`. Admin user-management routes require a JWT from an admin user.

Important route groups:

- `/api/auth`: sign in, sign up, current user, rotate API key.
- `/api/users`: admin user management.
- `/api/memories`: list, read, patch, archive, hard delete, and evidence attachment.
- `/api/export`, `/api/import`, `/api/audit`, `/api/operations`, `/api/governance/diagnostics`.
- `/api/recall/explain`: recall inspector.
- `/api/scenes`, `/api/persona`, `/api/contradictions`, `/api/graph`, `/api/stats`.
- `/api/evidence`, `/api/hooks`, `/api/working`, `/api/skills/activations`.

## Documentation

- [BRAINROUTER.md](./BRAINROUTER.md): implementation reference for the current MCP server, memory engine, tools, routes, and env vars.
- [PRESENTATION.md](./PRESENTATION.md): short presentation script aligned with current scope.
- [AGENT.md](./AGENT.md): agent-facing project router. It may reference live MCP tools that are only available when a BrainRouter server is connected.

## License

MIT. See [LICENSE](./LICENSE).
