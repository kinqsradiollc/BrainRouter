# BrainRouter Roadmap

This document outlines the milestones, completed features, and the future development path of the BrainRouter platform.

---

## Completed In [0.2.0] — 2026-05-21

- **Hardened Dashboard Authentication**: Added a "Remember Me" option for session JWT persistence, dynamic JWT cleanup after API validation failures, signup password strength validation, and descriptive error messages.
- **Admin User Management**: Implemented paginated tables, user creation forms, enable/disable status controls, API key reset dialogs, delete confirmation flows, and self-protection overrides.
- **Memories Management Hub**: Integrated keyword search, classification type filters, active/archived status toggles, infinite scroll, inline content editing, and multi-select bulk actions.
- **Developer Profiles**: Added displayName updates, API key rotation dialogs, masked keys with click-to-copy, and copyable connection JSON blocks.
- **MCP Onboarding Assistance**: Added a dismissible banner showing copyable SSE configurations to connect desktop clients to local server instances.
- **Cognitive Operations Monitoring**: Wired up contradiction resolution workflows, sidebar pending contradiction badges, evidence kind filtering, and recent memory activity feeds.
- **Backend Quality of Service**: Implemented client IP-based rate limiting on authentication routes, input length sanitization rules, and CORS configuration support.

---

## Current Status & Verification (Pre-Release 0.2.0)

- **Manual Verification**: Run integration test scenarios in `CodexTasks.md` Phase L using a live MCP HTTP server and dev server.
- **Security Check**: Evaluate whether to migrate the custom IP-based rate limiter in `mcp/src/index.ts` to `express-rate-limit` depending on production deployment security requirements.

---

## Planned In [0.3.0] — Terminal Agent CLI Client

The next milestone focuses on expanding the BrainRouter ecosystem with a premium terminal-based client (`brainrouter`) designed as a standalone interactive REPL and execution harness.

### Key Milestones
- **Command-line Interface**: Build a node-based terminal agent binary utilizing `readline` and `chalk` to deliver a premium, theme-aligned dark console experience.
- **Interactive Slash Commands**: Support `/config`, `/login`, `/clear`, `/skills`, `/status`, and `/exit` within the main agent shell.
- **Dynamic Configuration Manager**: Read and write configurations to `~/.config/brainrouter/config.json` supporting both local Stdio execution and remote HTTP/SSE streaming endpoints.
- **Dual-System Reasoning**:
  - **System 1 (Heuristic Recall)**: Query remote memory APIs via `memory_recall` to pull relevant facts/instructions.
  - **System 2 (Consolidation)**: Push memories and record interaction results back to the server using `memory_capture_turn`.
- **Local Execution Tooling**: Bundle terminal command execution and file management sandboxed utility functions as local tools accessible by the reasoning agent.
