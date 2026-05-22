# BrainRouter Roadmap

Pre-release. No tagged versions yet; everything below is descriptive of work in progress.

---

## Recently Completed

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

- **First tagged release**: Stabilize versioning across the monorepo, cut the initial public release with a packaged install path (`npx brainrouter`, Docker image for the MCP server).
- **Dashboard memory explorer**: Surface FTS/vector ranking signals + `memory_explain_recall` inline so users can audit *why* a record surfaced.
- **Web chat parity with CLI**: Match goal lifecycle, hookify rules, and multi-agent orchestration in the browser surface.
- **Provider matrix**: Verified configs for OpenAI, Anthropic, Gemini, OpenRouter, and local backends (LM Studio, Ollama).
