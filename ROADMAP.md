# BrainRouter Roadmap

Active version: **0.3.4** — first npm-published release. The CLI, MCP server,
and shared types/SDK now install with `npm install -g @brainrouter/cli` /
`@brainrouter/mcp-server`. The dashboard and React hooks remain in-repo
deliverables.

---

## Recently Completed

### 0.3.4 — First npm release
- **Published packages**: [`@brainrouter/cli`](https://www.npmjs.com/package/@brainrouter/cli) (CLI — installs the `brainrouter` binary), [`@brainrouter/mcp-server`](https://www.npmjs.com/package/@brainrouter/mcp-server), [`@brainrouter/sdk`](https://www.npmjs.com/package/@brainrouter/sdk), [`@brainrouter/types`](https://www.npmjs.com/package/@brainrouter/types). License, repository, keywords, `publishConfig.access: public`, `files` allowlist, and `prepack` hooks on each.
- **CLI offline mode**: degrades cleanly when the MCP server is unreachable instead of hard-exiting; `--strict-mcp` opts back into the old fail-fast behavior. Startup banner surfaces `⚠️  OFFLINE MODE`.
- **CLI inspection-tool previews**: `list_dir`, `grep_search`, `glob_files` now render their results indented under the tool-completion line, so users see the content even when small models forget to echo it.
- **CLI env separation**: `~/.config/brainrouter/config.json` is the canonical source for chat-LLM creds; `.env` loading is restricted to runtime knobs (sandbox, timeouts, trace log, web search). Removed silent LLM-cred precedence bug where `brainrouter/.env` could shadow `config.json`.
- **bash/shell tool alias**: `bash`, `Bash`, `shell`, `sh` all route to `run_command` for cross-vendor model familiarity (Claude Code parity).
- **README**: documents the two-config (MCP env vs CLI config.json) split, the install-from-npm path, MCP-required-for-full-power dependency, and the offline-mode escape hatch.



### Dashboard & Backend
- **Hardened Dashboard Authentication**: "Remember Me" for session JWT persistence, dynamic JWT cleanup after API validation failures, signup password strength validation, and descriptive error messages.
- **Admin User Management**: Paginated tables, user creation forms, enable/disable status controls, API key reset dialogs, delete confirmation flows, and self-protection overrides.
- **Memories Management Hub**: Keyword search, classification type filters, active/archived toggles, infinite scroll, inline content editing, and multi-select bulk actions.
- **Developer Profiles**: displayName updates, API key rotation, masked keys with click-to-copy, copyable connection JSON blocks.
- **MCP Onboarding Assistance**: Dismissible banner showing copyable SSE configurations for connecting desktop clients to local server instances.
- **Cognitive Operations Monitoring**: Contradiction resolution workflows, sidebar pending contradiction badges, evidence kind filtering, recent memory activity feeds.
- **Backend Quality of Service**: Client IP-based rate limiting on auth routes, input length sanitization, CORS support.

### Terminal Agent CLI
- **`brainrouter` CLI**: Node-based interactive REPL with theme-aligned dark console. 60+ slash commands across session / memory / workflow / orchestration / guard / obs / ui surfaces.
- **Dynamic configuration**: `~/.config/brainrouter/config.json` supports both local stdio and remote HTTP MCP transports.
- **Dual-system reasoning**: Pre-turn memory briefing (System 1 recall) + post-turn `memory_capture_turn` (System 2 consolidation).
- **Local execution tooling**: Sandboxed `run_command`, `read_file`, `write_file`, `apply_patch`, `web_search`, plus the full MCP tool registry.
- **Goal state machine**: `usage_limited` status, token + iteration budgets, replace-confirmation prompt, wrap-up steering on the final budget turn, `/goal edit` unified mutation.
- **Multi-agent orchestration**: `spawn_agent` with explorer / architect / reviewer / worker / verifier roles, durable workflow folders (`spec.md` / `tasks.md` / `walkthrough.md`), auto-review pass.

---

## Current Status & Verification

- **Manual Verification**: Run the late-phase integration test scenarios against a live MCP HTTP server and dev server.
- **Security Check**: Evaluate whether to migrate the custom IP-based rate limiter in `brainrouter/src/index.ts` to `express-rate-limit` depending on production deployment security requirements.

---

## Up Next

- **Docker image for the MCP server**: One-command `docker run` deploy so users don't have to manage Node/SQLite/embedding-dimension drift themselves.
- **Dashboard memory explorer**: Surface FTS/vector ranking signals + `memory_explain_recall` inline so users can audit *why* a record surfaced.
- **Dashboard parity with CLI**: Match goal lifecycle, hookify rules, and multi-agent orchestration in the browser surface (`brainrouter-dashboard`).
- **Provider matrix**: Verified configs for OpenAI, Anthropic, Gemini, OpenRouter, and local backends (LM Studio, Ollama).
- **`@brainrouter/sdk` 1.0**: Lock the public surface so external integrators can build against it without expecting renames.
