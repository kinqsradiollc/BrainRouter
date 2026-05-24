# BrainRouter Roadmap

Active released version: **0.3.5** — global-install UX fix
([`@kinqs/brainrouter-cli` on npm](https://www.npmjs.com/package/@kinqs/brainrouter-cli)).

In-flight: **0.3.6** — relevance judge, goal-loop hardening, dashboard
markdown/Mermaid/KaTeX, `.env` template reorg, LLM pipeline robustness
fixes. One remaining workstream in [`0.3.6.md`](0.3.6.md) (Item 3,
multi-workflow concurrency). Live progress checklist in
[`Tasks.md`](../Tasks.md).

Next major target: **0.4.0 — Federation** (multi-CLI, multi-instance, shared
memory). Design in [`0.4.0.md`](0.4.0.md).

---

## Per-release roadmaps

| Release | Theme | Status |
|---|---|---|
| **[0.3.6](0.3.6.md)** | CLI UX tranche + multi-workflow + relevance judge | _In-flight_ — 8 items, 7 shipped (Items 1 + 2 + 2b + 2c + 2d + 2e + 2f via PR #26 + #27 + #30 + #32 + #31 + #35 + #36); Item 3 multi-workflow concurrency is the last remaining workstream |
| [0.3.7](0.3.7.md) | Quick wins post-0.3.6 | Planned — cron `/schedule`, `/release-notes`, hooks JSON doc, "Strict Tool-Call Recovery" pattern (deer-flow), per-vendor MCP install snippets (semble) |
| [0.4.0](0.4.0.md) | **Federation — many agents, one memory** | Designed — 5 stages + memory-quality augmentations from deer-flow / semble |
| [0.4.x](0.4.x.md) | Post-federation polish | Planned — dynamic subagents, worktree isolation, `/rewind`, `/context per-skill`, benchmark harness, progressive skill loading, code-aware chunking |
| [0.5.0](0.5.0.md) | TUI cycle + plugin marketplace | Sketched — fullscreen renderer, plugin marketplace, gateway shape |
| [Intentionally excluded](intentionally-excluded.md) | Out of scope | Voice mode, claude.ai Remote Control, IM gateways |

## Cross-cutting reference material

- **[`CHANGELOG.md`](../CHANGELOG.md)** + [`brainrouter-changelog/`](../brainrouter-changelog/) — what shipped, per version.
- **[`openSrc/REFERENCES.md`](../openSrc/REFERENCES.md)** — peer-CLI projects we read for ideas (Claude Code, Codex, Antigravity, deer-flow, semble, etc.). Cited liberally in 0.3.7+ files.

## Recently completed (shipped versions, headline summary)

See [`brainrouter-changelog/`](../brainrouter-changelog/) for the full per-version notes. Headlines:

- **0.3.5** — global-install UX (`brainrouter-mcp init`, env-loader priority chain).
- **0.3.4** — first public npm release; four `@kinqs/` packages.
- **0.3.3** — `/goal` state machine; `usage_limited` status; token budget; wrap-up steering.
- **0.3.2** — OTEL trace nesting; headless-mode slash-command rejection; GitHub-PR statusline segment.
- **0.3.1** — reliability hardening: silent memory failure fixed, MCP timeouts, auto-compaction, fuzzy tool-name matching.
- **0.3.0** — Terminal Agent CLI; multi-agent orchestration (`spawn_agent` × 5 roles); memory engine; hookify rules.
- **0.2.0** — dashboard polish: Admin Users console; Memories Hub; Contradiction resolution UI.

## Up Next (post-0.5.0 wishlist)

These aren't yet sized into a specific release; they're the macro themes we expect to need.

- **Docker image for the MCP server** — one-command `docker run` deploy so users don't manage Node/SQLite/embedding-dimension drift themselves.
- **Dashboard memory explorer** — surface FTS/vector ranking signals + `memory_explain_recall` inline so users can audit *why* a record surfaced.
- **Dashboard parity with CLI** — match goal lifecycle, hookify rules, and multi-agent orchestration in [`brainrouter-dashboard/`](../brainrouter-dashboard/).
- **Provider matrix** — verified configs for OpenAI, Anthropic, Gemini, OpenRouter, and local backends (LM Studio, Ollama).
- **`@kinqs/brainrouter-sdk` 1.0** — lock the public surface so external integrators can build against it without expecting renames.

## Current status & verification

- **Manual verification** — run late-phase integration scenarios against a live MCP HTTP server and dev server.
- **Security check** — evaluate migrating the custom IP-based rate limiter in `brainrouter/src/index.ts` to `express-rate-limit` for production-grade deployments.
