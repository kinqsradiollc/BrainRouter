# BrainRouter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%233178c6.svg)](https://www.typescriptlang.org/)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

A cognitive memory engine for LLM agents.

Captures dialogue, classifies it, decays unused facts over time, reinforces
the ones the agent actually uses, and surfaces the right memories on the
next prompt — so your agent stops re-learning the same things every session.

## Star History

<a href="https://www.star-history.com/?repos=kinqsradiollc%2FBrainRouter&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&legend=top-left" />
 </picture>
</a>

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
# 1. Install both globally — the -g flag is critical (without it, the
#    binaries land in ./node_modules/.bin and aren't on $PATH).
npm install -g @kinqs/brainrouter-cli          # exposes `brainrouter`
npm install -g @kinqs/brainrouter-mcp-server   # exposes `brainrouter-mcp`

# 2. Scaffold the MCP server's config file (one-time).
brainrouter-mcp init                            # creates ~/.config/brainrouter/server.env
$EDITOR ~/.config/brainrouter/server.env        # fill in LLM key + embeddings

# 3. Start the MCP server in one terminal:
brainrouter-mcp --http --port 3747

# 4. Run the CLI. The first launch drops you into the in-terminal wizard
#    (theme → provider → API key → model → MCP → AGENT.md) — no separate
#    `brainrouter config` / `brainrouter login` step needed since 0.3.7.
brainrouter
```

> **Re-run the wizard any time with `/init` inside the REPL.** Tweak
> individual knobs with `/config` (bare opens an arrow-key panel;
> `/config theme dark` for one-shot sets). MCP profile edits live
> behind `/login`. The legacy `brainrouter config` / `brainrouter
> login` subcommands still work for users who scripted them.

**Sudo caveat for step 1.** Whether you need `sudo` depends on how Node
is installed: Homebrew / nvm / asdf → no sudo (user-writable prefix);
system Node on macOS/Linux → yes sudo. Check with `npm config get prefix`
— if the path is under your home dir or `/opt/homebrew`, skip sudo.

Published packages: [`@kinqs/brainrouter-cli`](https://www.npmjs.com/package/@kinqs/brainrouter-cli)
(CLI — installs the `brainrouter` binary),
[`@kinqs/brainrouter-mcp-server`](https://www.npmjs.com/package/@kinqs/brainrouter-mcp-server)
(MCP server — installs the `brainrouter-mcp` binary), plus their dependencies
[`@kinqs/brainrouter-sdk`](https://www.npmjs.com/package/@kinqs/brainrouter-sdk)
and [`@kinqs/brainrouter-types`](https://www.npmjs.com/package/@kinqs/brainrouter-types).
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
reranker + relevance judge). The CLI runs the terminal agent you actually
chat with. They can use the same model for both, or different ones —
extraction wants something cheap, chat wants something smart.

#### 1. MCP server — `brainrouter/.env`

Copy `brainrouter/.env.example` to `brainrouter/.env` and fill in at minimum:

```bash
# Cognitive extraction / synthesis LLM (any OpenAI-compatible endpoint:
# OpenAI, OpenRouter, LM Studio, Ollama, vLLM…)
BRAINROUTER_LLM_API_KEY=
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini

# Embeddings — required for vector recall. Key falls back to BRAINROUTER_LLM_API_KEY.
BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536

# Server auth — leave blank to seed on first boot. Generate a JWT secret with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
BRAINROUTER_ADMIN_PASSWORD=
BRAINROUTER_JWT_SECRET=
```

Optional advanced knobs are documented inline in
[`brainrouter/.env.example`](brainrouter/.env.example), grouped into five
numbered sections: LLM, retrieval pipeline (embeddings → reranker → judge),
memory engine, skill pre-warming, server auth.

#### 2. CLI agent — `~/.config/brainrouter/config.json`

The CLI's chat LLM and MCP connection are stored in `config.json`, not `.env`.
**Since 0.3.7 the in-terminal wizard handles the whole setup** the first time
you run `brainrouter` — no separate `brainrouter login` / `brainrouter config`
step needed. The wizard pre-detects API keys from your shell env
(`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, …), runs a
5-second reachability probe on the MCP transport you pick, and writes the
final config in one transaction.

Inside the REPL afterwards:

```text
/init                              # re-run the wizard
/config                            # bare → arrow-key settings panel
/config theme dark                 # one-shot set
/config statusline mode,branch,workflow,goal
/login                             # MCP profile editor (transport → fields → probe → save)
```

The legacy `brainrouter login` / `brainrouter config` subcommands still
work for users who scripted them.

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
local stdio profile via `/login` (recommended) or `/config` → "MCP profile".
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
- **[ROADMAP.md](ROADMAP.md)** — what's next (overview + per-release index pointing into [`brainrouter-roadmap/`](brainrouter-roadmap/)).
- **[CHANGELOG.md](CHANGELOG.md)** — release notes (in-flight + most-recent inline; full history per-version in [`brainrouter-changelog/`](brainrouter-changelog/)).

## License

MIT — see [LICENSE](LICENSE).
