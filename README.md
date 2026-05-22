# BrainRouter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%233178c6.svg)](https://www.typescriptlang.org/)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

A cognitive memory engine for LLM agents.

Captures dialogue, classifies it, decays unused facts over time, reinforces
the ones the agent actually uses, and surfaces the right memories on the
next prompt — so your agent stops re-learning the same things every session.

## What you get

- **MCP server (`brainrouter`)** — drop-in memory tools for any MCP-speaking client.
- **Terminal CLI (`brainrouter-cli`)** — memory-native coding agent with
  slash commands, hookify rules, multi-agent orchestration.
- **Dashboard (`brainrouter-dashboard`)** — Next.js web UI for browsing
  captured memories, focus scenes, contradictions, recall traces, working
  memory, timelines, persona, skills, and a hosted chat.

## Install

Two paths — pick one. **Install from npm** is the fast path for trying the
agent against a hosted MCP server. **Clone the repo** is needed if you want to
run your own MCP server, hack on the engine, or use the dashboard.

### From npm (CLI + MCP server)

```bash
# Terminal agent
npm install -g @brainrouter/cli          # exposes `brainrouter` on $PATH

# MCP server (only if you want to run your own — the CLI also works against a hosted one)
npm install -g @brainrouter/mcp-server   # exposes `brainrouter-mcp`
```

Published packages: [`@brainrouter/cli`](https://www.npmjs.com/package/@brainrouter/cli)
(CLI — installs the `brainrouter` binary),
[`@brainrouter/mcp-server`](https://www.npmjs.com/package/@brainrouter/mcp-server)
(MCP server — installs the `brainrouter-mcp` binary), plus their dependencies
[`@brainrouter/sdk`](https://www.npmjs.com/package/@brainrouter/sdk)
and [`@brainrouter/types`](https://www.npmjs.com/package/@brainrouter/types).
The dashboard and React hooks stay in the repo — they ship as a server, not a library.

### From source (full monorepo)

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install
npm run build
```

### Configure your models

BrainRouter ships **two independent processes** with two separate configurations.
The MCP server runs the cognitive engine (extraction, embeddings, optional
reranker). The CLI runs the terminal agent you actually chat with. They can
use the same model for both, or different ones — extraction wants something
cheap, chat wants something smart.

#### 1. MCP server — `brainrouter/.env`

Copy `brainrouter/.env.example` to `brainrouter/.env` and fill in at minimum:

```bash
# Cognitive extraction / synthesis LLM (any OpenAI-compatible endpoint:
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

Optional advanced knobs (split extraction/synthesis models, reranker,
pre-warming, focus-scene triggers, sandbox) are documented inline in
[`brainrouter/.env.example`](brainrouter/.env.example).

#### 2. CLI agent — `~/.config/brainrouter/config.json`

The CLI's chat LLM and MCP connection are stored in `config.json`, not `.env`.
Set them up once with the interactive commands:

```bash
brainrouter login    # connect to a hosted/local MCP server (HTTP/SSE)
brainrouter config   # set chat LLM provider, model, API key, endpoint
```

Tool-runtime knobs that don't fit `config.json` (sandbox, trace log, web-search
backend, tool-loop limits) live in `brainrouter-cli/.env` — see
[`brainrouter-cli/.env.example`](brainrouter-cli/.env.example).

### Run

The CLI's full power — memory recall, skills, capture, persona, focus scenes,
contradiction tracking — comes from the MCP server. Start it first, then the
CLI:

```bash
# Terminal A — MCP HTTP server on :3747 (cognitive memory engine)
cd brainrouter && npm run start:http

# Terminal B — CLI agent
npm run cli
```

Type `/help` in the REPL.

**Offline mode.** If the MCP server isn't reachable, the CLI still boots — but
only local tools (file edits, shell, web fetch, spawn_agent) work. Memory
recall, capture, and skills are disabled until the server is back. The startup
banner shows `⚠️  OFFLINE MODE` when this happens. Pass `--strict-mcp` to make
the CLI exit instead of degrading.

**Stdio mode.** If you'd rather run the MCP as a spawned child of the CLI
(instead of a separate HTTP service), point your active server profile at the
`default` stdio profile via `brainrouter config` → "Set Active Server Profile".
You don't need to run `start:http` in that case — the CLI spawns the server
on demand.

### Web dashboard (optional)

With the MCP HTTP server already running (Terminal A above), start the
dashboard in a third terminal:

```bash
cd brainrouter-dashboard && npm install && npm run dev
```

Open <http://localhost:3000>. The dashboard exposes the chat surface at
`/chat` plus inspectors for memories, scenes, contradictions, recall traces,
working memory, persona, hooks, and the user/admin console.

## Docs

- **[SETUP.md](SETUP.md)** — maintainer runbook: first-time setup, daily run, upgrade, publish, troubleshooting, and reset.
- **[BRAINROUTER.md](BRAINROUTER.md)** — what the memory engine actually does.
- **[PRESENTATION.md](PRESENTATION.md)** — slide-deck overview.
- **[brainrouter-docs/](brainrouter-docs/)** — deep dives (math, env vars, CLI internals).
- **[AGENT.md](AGENT.md)** — guidance for AI coding agents working in this repo.
- **[ROADMAP.md](ROADMAP.md)** — what's next.
- **[CHANGELOG.md](CHANGELOG.md)** — release notes.

## License

MIT — see [LICENSE](LICENSE).
