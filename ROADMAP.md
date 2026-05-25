# BrainRouter Roadmap

Active released version: **0.3.6** — context budget, MCP identity +
offline UX, multi-MCP foundation, goal/workflow decoupling
([`@kinqs/brainrouter-cli` on npm](https://www.npmjs.com/package/@kinqs/brainrouter-cli)).
See [`CHANGELOG.md`](CHANGELOG.md).

In-flight: **0.3.7** — Terminal UI redesign + in-terminal config
wizard **+ full Ink chat REPL + CLI/server env separation**. First-run
users get a `Welcome → Theme → Provider → ApiKey → Model → MCP →
AgentMd → Done` wizard inside the REPL instead of the old "exit, run
`brainrouter login`, exit, run `brainrouter config`, exit" dance. A
new `/config` panel surfaces every CLI knob through a single
arrow-key picker. `/login` opens the MCP profile editor in-REPL. The
everyday turn loop itself was the last surface still on readline; it
now renders through the same Ink tree (banner, composer, scrollback,
tool events, slash palette, footer) with claude-code-style `⏺/⎿/◉`
chrome and progressive collapse on resize. The CLI no longer reads
any `.env` file — `~/.config/brainrouter/config.json` is the sole
credential store and the MCP child's stderr is piped so server logs
never bleed into the terminal. That last piece was originally a 0.3.8
target; pulled forward to avoid shipping a split aesthetic. Quick-win
parity items (cron `/schedule`, `/release-notes`, hooks JSON doc,
deer-flow Strict Tool-Call Recovery, per-vendor MCP install snippets)
carry into 0.3.8. Full detail in
[`brainrouter-roadmap/0.3.7.md`](brainrouter-roadmap/0.3.7.md) and
spec in [`docs/specs/0.3.7-terminal-ui-redesign.md`](docs/specs/0.3.7-terminal-ui-redesign.md).
Live progress checklist in [`Tasks.md`](Tasks.md).

Next major target: **0.4.0 — Federation** (multi-CLI, multi-instance,
shared memory) — see [`brainrouter-roadmap/0.4.0.md`](brainrouter-roadmap/0.4.0.md).

The detailed per-release roadmaps live in
[`brainrouter-roadmap/`](brainrouter-roadmap/). This file is a
top-of-funnel overview: where we are, what's next, and how to find the
detail.

---

## Per-release roadmaps

| Release | Theme | Status |
|---|---|---|
| **[0.3.6](brainrouter-roadmap/0.3.6.md)** | CLI UX tranche + multi-workflow + relevance judge + context budget | _Shipped — 2026-05-25_ — all 11 items merged via PRs #26 + #27 + #38 + #30 + #32 + #31 + #35 + #36 + #39 (items 9 + 10 + 11 bundled) |
| **[0.3.7](brainrouter-roadmap/0.3.7.md)** | **Terminal UI redesign + in-terminal config wizard + full Ink chat REPL + CLI/server env separation** | _In-flight_ — Item 6 shipped + scope expanded (wizard + `/config` + `/login` + Ink chat REPL as unconditional default + CLI reads no `.env` + MCP child stderr piped + wizard Skip fix); Items 1–5 (cron `/schedule`, `/release-notes`, hooks doc, deer-flow Strict Tool-Call Recovery, per-vendor MCP install snippets) cut and carried into 0.3.8 |
| [0.4.0](brainrouter-roadmap/0.4.0.md) | **Federation — many agents, one memory** | Designed — 5 stages + memory-quality augmentations from deer-flow / semble |
| [0.4.x](brainrouter-roadmap/0.4.x.md) | Post-federation polish | Planned — dynamic subagents, worktree isolation, `/rewind`, `/context per-skill`, benchmark harness, progressive skill loading, code-aware chunking |
| [0.5.0](brainrouter-roadmap/0.5.0.md) | TUI cycle + plugin marketplace | Sketched — fullscreen renderer, plugin marketplace, gateway shape |

---

## Recently completed (headlines)

Full per-version notes in [`brainrouter-changelog/`](brainrouter-changelog/).

- **0.3.6** — multi-workflow concurrency; `/effort` + `/mode` + `/review-policy` + `/grill-me` + `ask_user_choice`; system-prompt trim (~70% cut) + gated recall; MCP identity + offline UX; multi-MCP foundation; spinner/stdin freeze fix.
- **0.3.5** — global-install UX (`brainrouter-mcp init`, env-loader priority chain).
- **0.3.4** — first public npm release; four `@kinqs/` packages.
- **0.3.3** — `/goal` state machine; `usage_limited` status; token budget; wrap-up steering.
- **0.3.2** — OTEL trace nesting; headless-mode slash-command rejection; GitHub-PR statusline segment.
- **0.3.1** — reliability hardening: silent memory failure fixed, MCP timeouts, auto-compaction, fuzzy tool-name matching.
- **0.3.0** — Terminal Agent CLI; multi-agent orchestration (`spawn_agent` × 5 roles); memory engine; hookify rules.
- **0.2.0** — dashboard polish: Admin Users console; Memories Hub; Contradiction resolution UI.

---

## Up Next (post-0.5.0 wishlist)

These aren't sized into a specific release; they're the macro themes we expect to need.

- **Docker image for the MCP server** — one-command `docker run` deploy so users don't manage Node/SQLite/embedding-dimension drift themselves.
- **Dashboard memory explorer** — surface FTS/vector ranking signals + `memory_explain_recall` inline so users can audit *why* a record surfaced.
- **Dashboard parity with CLI** — match goal lifecycle, hookify rules, and multi-agent orchestration in [`brainrouter-dashboard/`](brainrouter-dashboard/).
- **Provider matrix** — verified configs for OpenAI, Anthropic, Gemini, OpenRouter, and local backends (LM Studio, Ollama).
- **`@kinqs/brainrouter-sdk` 1.0** — lock the public surface so external integrators can build against it without expecting renames.

---

## Current status & verification

- **Manual verification** — run late-phase integration scenarios against a live MCP HTTP server and dev server.
- **Security check** — evaluate migrating the custom IP-based rate limiter in `brainrouter/src/index.ts` to `express-rate-limit` for production-grade deployments.
