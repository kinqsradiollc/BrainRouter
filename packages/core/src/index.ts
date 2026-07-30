/**
 * @kinqs/brainrouter-core — the headless BrainRouter engine shared verbatim by
 * the CLI and the Desktop app (the interactive terminal layer stays in the CLI;
 * the agent reaches the user through an injected `InteractivePrompter` port).
 *
 * Consumers import curated domain entrypoints
 * (`@kinqs/brainrouter-core/<domain>`). The source is organized by DOMAIN, not
 * by layer:
 *
 *   provider/   — model catalog, policy, routing/recovery, adapters, and tiers
 *   agent/      — the Agent, its prompter port, repair, patch/edit helpers
 *   tool/       — LLM tool specs/registry/executors + tool budget
 *   orchestration/ — multi-agent coordination (roles, router, phases, spawn…)
 *   session/    — sessions, transcripts, modes, runtime, recap, chapters, prefs
 *   storage/    — the file-backed store primitive (paths/JSON) + low-level stores
 *   config/     — config.json loading + bundled config-asset loader
 *   mcp/ · lsp/ · exec/ — MCP pool, LSP client, sandboxed command execution
 *   memory/ · prompt/ · telemetry/ · command/ · context/
 *   goal/ · task/ · review/ · requirement/ · annotation/ · artifact/ ·
 *   attachment/ · background/ · workflow/ · worker/ · schedule/ · hooks/ ·
 *   pack/ · git/ · workspace/ · worktree/ — first-class workflow domains
 *   util/       — cross-cutting helpers with no natural domain home
 *
 * This root barrel stays minimal; curated domain entrypoints are the supported
 * surface. The documented Desktop renderer exception is temporary.
 */
export const CORE_PACKAGE = '@kinqs/brainrouter-core';
