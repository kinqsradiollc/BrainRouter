# Changelog

All notable changes to BrainRouter.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The full per-version history lives in [`brainrouter-changelog/`](brainrouter-changelog/) — one file per release. The current in-flight version (`[Unreleased]`) and the most-recent shipped release are inlined below for at-a-glance scanning; everything older is one click away.

---

## [0.3.7] - Unreleased

Terminal UI redesign — in-terminal config wizard + full Ink chat REPL. Full notes will land in [`brainrouter-changelog/0.3.7.md`](brainrouter-changelog/0.3.7.md).

---

## [0.3.6] - 2026-05-25

Smarter recall, friendlier CLI, more reliable agent loop. Full notes: [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md).

- **Multi-workflow concurrency.** `/workflow switch <slug>` flips between `/feature-dev` / `/spec` / `/review` workflows; `/workflows` lists them with artifact markers. Goals stay session-scoped (workflows are pure storage + navigation).
- **New session knobs.** `/effort low|medium|high` (forwarded as `reasoning_effort` to gpt-5 / o-series / gpt-oss / deepseek-r/v / qwen3 / magistral), `/mode planning|fast` + `/review-policy request|proceed` (replace `/yolo` + `autoApproveShell`), `/grill-me <task>` (2–5 clarifying questions before any edit), `ask_user_choice` (mid-turn arrow-key picker).
- **Context budget — 70% lighter system prompt + gated recall.** Static prompt cut from ~4,750 → ~1,400 tokens; briefing fires only on turn 1, post-compaction, or messages carrying ≥2 entity-shaped tokens. Goal text deduplicated to a single per-turn anchor.
- **MCP identity + offline UX + multi-MCP foundation.** BrainRouter MCP auto-detected; when offline, system prompt swaps to a `⚠️ OFFLINE` block and banner/statusline gain a distinct `brain` indicator. New `/mcp list` / `/mcp reconnect` / `/mcp tools`.
- **REPL stdin no longer freezes** after spinner-based slash commands.

---

## [0.3.5] - 2026-05-22

Global-install UX fix.

- **`brainrouter-mcp init`** — scaffolds `~/.config/brainrouter/server.env` from the bundled template (chmod 0600). Won't overwrite an existing file.
- **Env-loader priority chain** — `$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`. Server prints which file it loaded at startup.
- **Published READMEs rewritten** for global-install users (the actual npm flow ending with `brainrouter` on `$PATH`); SETUP.md split into "install from npm" vs "clone and build" paths.

Backward compatible — existing monorepo dev (`brainrouter/.env`) still works in the third priority slot.

---

## Older releases

| Version | Date | Highlights |
|---|---|---|
| [0.3.4](brainrouter-changelog/0.3.4.md) | 2026-05-22 | First public npm release across four `@kinqs/` packages |
| [0.3.3](brainrouter-changelog/0.3.3.md) | 2026-05-21 | `/goal` state machine (`usage_limited`, token budget, wrap-up steering) |
| [0.3.2](brainrouter-changelog/0.3.2.md) | 2026-05-19 | Observability + headless + UX polish |
| [0.3.1](brainrouter-changelog/0.3.1.md) | 2026-05-17 | Reliability hardening — silent failures, races, edge cases |
| [0.3.0](brainrouter-changelog/0.3.0.md) | 2026-05-16 | Terminal Agent CLI + multi-agent orchestration + memory engine |
| [0.2.0](brainrouter-changelog/0.2.0.md) | 2026-05-15 | Admin & dashboard polish (Users console, Memories Hub, Contradiction UI) |

See [`brainrouter-changelog/README.md`](brainrouter-changelog/README.md) for the full per-version index and writing conventions.
