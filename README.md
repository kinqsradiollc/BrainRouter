# BrainRouter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%233178c6.svg)](https://www.typescriptlang.org/)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

A cognitive memory engine for LLM agents.

Captures dialogue, classifies it, decays unused facts over time, reinforces
the ones the agent actually uses, and surfaces the right memories on the
next prompt — so your agent stops re-learning the same things every session.

<a href="https://www.star-history.com/?repos=kinqsradiollc%2FBrainRouter&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kinqsradiollc/BrainRouter&type=date&legend=top-left" />
 </picture>
</a>

## What you get

- **MCP server (`brainrouter-mcp`)** — drop-in memory + skills + federation tools for any MCP-speaking client. [API reference](BRAINROUTER.md#mcp-api-reference).
- **Terminal CLI (`brainrouter`)** — memory-native coding agent: slash commands, hookify guardrails, multi-agent orchestration (packs + worker threads), durable workflows with a live run viewer, cross-vendor federation, and a `/goal` autonomy loop.
- **Dashboard (`brainrouter-dashboard`)** — Next.js web UI for browsing captured memories, focus scenes, contradictions, recall traces, working memory, timelines, persona, skills, brain-agent health, and a hosted chat.

## Install

Two paths — **npm** is the fast path for trying the agent against a hosted MCP server. **Clone** is needed if you want to run your own MCP server, hack on the engine, or use the dashboard.

**From npm:**

```bash
npm install -g @kinqs/brainrouter-cli          # exposes `brainrouter`
npm install -g @kinqs/brainrouter-mcp-server   # exposes `brainrouter-mcp`
```

**From source:**

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install && npm run build
```

**Sudo caveat.** Whether you need `sudo` for global npm install depends on how Node is installed: Homebrew / nvm / asdf → no sudo; system Node on macOS/Linux → yes. Check with `npm config get prefix`.

Published packages: [`@kinqs/brainrouter-cli`](https://www.npmjs.com/package/@kinqs/brainrouter-cli), [`@kinqs/brainrouter-mcp-server`](https://www.npmjs.com/package/@kinqs/brainrouter-mcp-server), plus shared [`@kinqs/brainrouter-sdk`](https://www.npmjs.com/package/@kinqs/brainrouter-sdk) and [`@kinqs/brainrouter-types`](https://www.npmjs.com/package/@kinqs/brainrouter-types). The dashboard stays in the repo — it ships as a server, not a library.

## Configure

BrainRouter has two independent processes with separate configs.

**MCP server — `brainrouter/.env`**

Copy `brainrouter/.env.example` to `brainrouter/.env` and fill in at minimum:

```bash
BRAINROUTER_LLM_API_KEY=
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRAINROUTER_LLM_MODEL=gpt-4o-mini

BRAINROUTER_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
BRAINROUTER_EMBEDDING_MODEL=text-embedding-3-small
BRAINROUTER_EMBEDDING_DIMENSIONS=1536

BRAINROUTER_ADMIN_PASSWORD=
BRAINROUTER_JWT_SECRET=
```

Full knob reference (LLM, retrieval pipeline, memory engine, skill pre-warming, auth) is in [`brainrouter/.env.example`](brainrouter/.env.example).

**CLI agent — `~/.config/brainrouter/config.json`**

The first time you run `brainrouter`, the in-terminal setup wizard starts automatically:

```
Welcome → Theme → Provider → API key → Model → MCP → AGENT.md → Done
```

It pre-detects API keys from your shell env (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, …), probes the MCP transport, and writes `config.json` in one transaction. Re-run it any time with `/init` inside the REPL.

Tweak individual settings in-REPL:

```text
/config                            # arrow-key settings panel
/config theme dark                 # one-shot set
/login                             # MCP profile editor
```

Tool-runtime knobs (sandbox, trace log, tool-loop limits, theme, quiet, recall mode, parallel-safe tool calls, etc.) live alongside provider creds under `cli.*` in the same `~/.config/brainrouter/config.json` — `.env` files are not read by the CLI. The full field reference is the `CliKnobs` interface in [`brainrouter-cli/src/config/config.ts`](brainrouter-cli/src/config/config.ts); see [`brainrouter-docs/configuration.md`](brainrouter-docs/configuration.md) for the prose walkthrough.

## Run

```bash
# Terminal A — MCP HTTP server on :3747
cd brainrouter && npm run start:http

# Terminal B — CLI agent
brainrouter
```

Type `/help` in the REPL for 70+ slash commands. A bare `!` runs a shell command (`! git status`); `@path` inlines a file into the prompt.

**Offline mode** — if the MCP server isn't reachable, the CLI still boots with only local tools (file edits, shell, web fetch, `spawn_agent`). The banner shows `offline`. Pass `--strict-mcp` to exit instead of degrading.

**Stdio mode** — to run the MCP as a spawned child of the CLI instead of a separate HTTP service, use `/login` → pick the local stdio profile. No separate `start:http` needed.

## Web dashboard (optional)

With the MCP HTTP server running, start the dashboard in a third terminal:

```bash
cd brainrouter-dashboard && npm install && npm run dev
```

Open <http://localhost:3000>. Exposes `/chat` plus inspectors for memories, scenes, contradictions, recall traces, working memory, persona, hooks, and the admin console.

## Docs

- **[SETUP.md](SETUP.md)** — maintainer runbook: first-time setup, daily run, upgrade, publish, troubleshooting, and reset.
- **[BRAINROUTER.md](BRAINROUTER.md)** — what the memory engine actually does.
- **[BENCHMARKS.md](BENCHMARKS.md)** — reproducible proof: retrieval recall, code-recall, scale/context efficiency, load, and end-to-end lift.
- **[PRESENTATION.md](PRESENTATION.md)** — slide-deck overview.
- **[brainrouter-docs/](brainrouter-docs/)** — deep dives (math, env vars, CLI internals). Includes [hooks.md](brainrouter-docs/hooks.md) — authoring reference for shell hooks and hookify rules.
- **[AGENT.md](AGENT.md)** — guidance for AI coding agents working in this repo.
- **[ROADMAP.md](ROADMAP.md)** — what's next.
- **[CHANGELOG.md](CHANGELOG.md)** — release notes.

## License

MIT — see [LICENSE](LICENSE).
