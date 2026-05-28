# BrainRouter — Deep Docs

The top-level files ([README](../README.md), [BRAINROUTER](../BRAINROUTER.md),
[PRESENTATION](../PRESENTATION.md)) stay short on purpose. This folder has the
deep dives.

- **[memory-engine.md](memory-engine.md)** — the 4-layer stack, forgetting
  curve, ACE reinforcement loop, recall pipeline (FTS5 + vector + filepath
  → RRF → priority blend → rerank → relevance judge → graph), ranking
  blend, extraction robustness.
- **[cli.md](cli.md)** — the terminal agent: startup banner & statusline,
  `/where` and `/quiet`, tool loop, access modes, `/compact`, hookify
  rules, multi-agent orchestration, personality overlays, goal state
  machine, session isolation.
- **[hooks.md](hooks.md)** — authoring reference for shell hooks
  (`cli/hooks.json`) and hookify rules (`hooks/*.md`): events, schema,
  three worked examples, debug + limit notes.
- **[brain-agents.md](brain-agents.md)** — 0.4.0 design freeze for
  the brain-side agent registry, `memory_jobs` queue, and three MCP
  tools (`memory_agent_status` / `memory_agent_run` /
  `memory_job_retry`). Type stubs are importable from
  `@kinqs/brainrouter-types`; the Phase 1 runtime ships in 0.4.1.
- **[federation.md](federation.md)** — 0.4.0 shared-memory plane:
  `/agents --remote`, `/dm` and `/broadcast` cross-CLI messaging, the
  dashboard Live Sessions widget, the active/stale/swept lifecycle,
  hard-kill + brain-restart recovery, privacy boundary, **plus a
  15-minute end-to-end walkthrough running three federated terminals
  on a real test project**.
- **[configuration.md](configuration.md)** — env-loader priority chain
  (`$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`),
  `brainrouter-mcp init`, `~/.config/brainrouter/config.json` as the
  canonical CLI chat-LLM credential store, stdio vs HTTP transport,
  storage layout, backpressure, diagnostics.

If you're new, read [BRAINROUTER.md](../BRAINROUTER.md) first. If you just
want to run something, [README.md → Quick Start](../README.md#quick-start).
