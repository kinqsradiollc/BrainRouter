# BrainRouter — Deep Docs

The top-level files ([README](../README.md), [BRAINROUTER](../BRAINROUTER.md),
[PRESENTATION](../PRESENTATION.md)) stay short on purpose. This folder has the
deep dives.

- **[memory-engine.md](memory-engine.md)** — the 4-layer stack, forgetting
  curve, ACE reinforcement loop, recall pipeline (FTS5 + vector + filepath
  → RRF → priority blend → rerank → graph), ranking
  blend, extraction robustness.
- **[cli.md](cli.md)** — the terminal agent: startup banner & statusline,
  `/where` and `/quiet`, tool loop, access modes, `/compact`, hookify
  rules, multi-agent orchestration (packs + worker threads), durable
  workflows + the live `/workflows` run viewer, the `!` shell escape,
  `/effort … xhigh|max`, `/review --fix` + `/simplify`, personality
  overlays, goal state machine, session isolation. Opens with a
  **"What's new in 0.4.2"** index.
- **[hooks.md](hooks.md)** — authoring reference for shell hooks
  (`cli/hooks.json`) and hookify rules (`hooks/*.md`): events, schema,
  three worked examples, debug + limit notes.
- **[automations.md](automations.md)** — inbound triggers → autonomous agent
  jobs (0.4.17): webhook ingress + signature verification, `on`/`when`/`do`
  rules, desktop setup, the loopback/tunnel reachability model, and the
  end-to-end event → fleet job → draft PR → comment-back chain.
- **[brain-agents.md](brain-agents.md)** — 0.4.0 design freeze for
  the brain-side agent registry, `memory_jobs` queue, and three MCP
  tools (`memory_agent_status` / `memory_agent_run` /
  `memory_job_retry`). Type stubs are importable from
  `@kinqs/brainrouter-types`; the Phase 1 runtime shipped in 0.4.1.
- **[federation.md](federation.md)** — the shared-memory plane:
  `/dm` and `/broadcast` cross-CLI messaging, the dashboard Live Sessions
  widget, the active/stale/swept lifecycle, hard-kill + brain-restart
  recovery, privacy boundary, **Stage 5 cross-vendor delegation
  (`session_delegate_task` / `/handoff`, 0.4.2)**, plus a 15-minute
  end-to-end walkthrough running three federated terminals on a real
  test project.
- **[configuration.md](configuration.md)** — env-loader priority chain
  (`$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`),
  `brainrouter-mcp init`, `~/.config/brainrouter/config.json` as the
  canonical CLI store (`llm.*` creds + `cli.*` runtime knobs incl.
  `fallbackModel` / `notifyBell` / `effort`), stdio vs HTTP transport,
  storage layout, backpressure, diagnostics.
- **[policy.md](policy.md)** — the exec policy & trust model: access modes
  (`read`/`write`/`shell`), sandbox, external-directory writes, the per-host
  egress allowlist, how each tool maps to a gated action, and the bundled
  `readonly` / `workspace` / `trusted` profiles you switch with `/policy`.
- **[mcp-install.md](mcp-install.md)** — installing the BrainRouter MCP server
  into MCP clients.

### Specs & decisions

- **[specs/](specs/)** — design specs: [workspace onboarding, dynamic capabilities, and project knowledge](specs/workspace-onboarding-and-capabilities.md), [memory-accuracy](specs/memory-accuracy.md)
  (+ the [audit](specs/memory-accuracy-audit.md)), [build-loop-workflow](specs/build-loop-workflow.md),
  [per-session-isolation](specs/per-session-isolation.md),
  [multi-agent-result-delivery](specs/multi-agent-result-delivery.md).
- **[decisions/](decisions/)** — ADRs: [ADR-001 async store worker](decisions/ADR-001-async-store-worker.md) …
  [ADR-021 workspace onboarding: typed profiles, domain personas & the workspace knowledge subsystem](decisions/ADR-021-workspace-onboarding-typed-profiles.md) —
  `.brainrouter/workspace.json` manifest (core chokepoint), profile presets, offline `/init` v2, bundled starter skills, and the B/C restructure phases;
  [ADR-022 persona, orchestration, and context contracts](decisions/ADR-022-persona-orchestration-and-context-contracts.md) —
  separate JSON persona and executable-role schemas, profile-scoped orchestration, task capabilities, and bounded context composition;
  [ADR-023 profile-specific orchestration plans](decisions/ADR-023-profile-specific-orchestration-plans.md) —
  bounded per-profile strategy graphs that reference reusable role JSON while preserving manifest and runtime authority ceilings;
  [ADR-024 agent work contracts, repository assurance, and browser reliability](decisions/ADR-024-agent-work-repository-assurance-and-browser-reliability.md) —
  proposed revisioned work/steering contracts, parser-backed code intelligence, whole-context repository assurance, verified browser actions, provider recovery, and a shared human review workbench.

Published benchmark results: [`../brainrouter-benchmark/reports/`](../brainrouter-benchmark/reports/).

If you're new, read [BRAINROUTER.md](../BRAINROUTER.md) first. If you just
want to run something, [README.md → Quick Start](../README.md#quick-start).
