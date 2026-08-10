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
- **[ADR-025 package boundary inventory](adr-025-package-boundary-inventory.md)** —
  current package/host owners, public entrypoints, mixed-responsibility module
  triage, migration order, and boundary-guard backlog for the accepted
  whole-platform modernization.

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
  proposed revisioned work/steering contracts, parser-backed code intelligence, whole-context repository assurance, verified browser actions, provider recovery, and a shared human review workbench;
  [ADR-025 repository assurance and runtime boundary modernization](decisions/ADR-025-repository-assurance-and-runtime-boundary-modernization.md) —
  accepted evidence-and-coverage-led PR assurance, distinct code/security/authorized-assessment programs, and an incremental whole-platform contracts/domain/policy/ports/adapters migration across shared packages and product hosts;
  [ADR-026 Desktop native visual system and platform-adaptive shell](decisions/ADR-026-desktop-native-visual-system.md) —
  proposed semantic styling layers, native window boundaries, system appearance, state-preserving surface contracts, and a small-PR migration gated by live macOS and Windows review;
  [ADR-027 compounding debt, graph execution, and workbench modernization](decisions/ADR-027-compounding-debt-graph-execution-and-workbench-modernization.md) —
  proposed knowledge/technical/cognitive debt program grounded in the human-oversight evidence, graph execution replacing the turn loop, offline skill resolution, attachment storage with agent access and profile-aware document understanding, one visual system, an agent-callable control layer, session execution roots, two review gates, citable research artifacts, a database growth ladder, and distributed-systems correctness fixes;
  [ADR-028 surfaces that tell the truth](decisions/ADR-028-surfaces-that-tell-the-truth.md) —
  accepted rule that a surface never claims a state it has not established, offline-first planner sync (hybrid clocks, an ordered idempotent outbox, field-level merge that keeps both versions), the comprehension review whose wrong answer may be the agent's, and the reachability sweep that catches a module nothing calls;
  [ADR-029 one workspace, many surfaces](decisions/ADR-029-one-workspace-many-surfaces.md) —
  accepted URI address space every mode resolves, backlinks computed rather than stored, a block-based Notes mode on the planner's sync stack with lease-with-fencing-epoch locking, databases whose rows ARE pages, and Part F's rule that an offer the product cannot honour is worse than an absence;
  [ADR-030 documents the agent can actually read](decisions/ADR-030-documents-the-agent-can-actually-read.md) —
  accepted PDF understanding: dependency-free inflation as the floor, a WebAssembly parser chosen over a native binding because our desktop ships an architecture it has no build for, per-page classification so a scan says it is a scan, and extracted text fenced as the untrusted input it is;
  [ADR-031 a design skill, and the capability it belongs to](decisions/ADR-031-a-design-skill-and-the-capability-it-belongs-to.md) —
  accepted single skill library with generated per-package copies and generated third-party notices, all skills carried everywhere, and a vendored design skill attached to the `frontend` capability rather than a profile;
  [ADR-032 an agent that gets better, and cannot get worse](decisions/ADR-032-an-agent-that-gets-better-and-cannot-get-worse.md) —
  accepted rule that a behavioural change must be reversible, attributable and falsifiable: a gate whose price of admission is naming what would show the lesson wrong, two provenance tiers (model-inferred evidence, human-corrected instruction) neither of which touches the base prompt, learned procedures promoted to a user-scoped skill store outside the generated library, automatic bounded checkpoints at turn end / compaction / session end, and retirement that demotes what never pays off back down the ladder it climbed;
  [ADR-033 review that finds things, and says where](decisions/ADR-033-review-that-finds-things-and-says-where.md) —
  accepted split of deterministic engineering from model judgement in code review: review units are bundles of related files decided by path and import relationships and run concurrently, the non-interactive bot may ask once for a file from the checkout it already has, a finding's line is computed from the evidence it quoted rather than remembered, a reflection pass reads the findings as a set and may publish fewer than it received, precision is the target and recall is the trade, a benchmark built from our own merged pull requests keeps that claim checkable, and a review that cannot complete says so instead of holding the merge gate.;
  [ADR-035 a meeting you cannot lose](decisions/ADR-035-a-meeting-you-cannot-lose.md) —
  proposed durability-then-liveness rework of meeting capture: audio written to disk as it arrives
  instead of accumulating in a renderer ref, a session created at Record rather than at Stop,
  incremental per-segment transcription so text exists during the meeting and a failure is bounded
  to one segment, failed segments shown as marked gaps that retry from the audio still on disk, and
  a destructive acceptance test — kill the app mid-recording and lose nothing.
  [ADR-036 the finding carries its code](decisions/ADR-036-the-finding-carries-its-code.md) —
  proposed review-console change that renders each bot finding's own hunk in the dashboard: the
  excerpt persisted with the finding at the reviewed revision rather than fetched from the forge, so
  it survives a deleted branch and needs no credentials; before/after when a fix is proposed; the
  finding's hunk rather than the whole diff, with "Open pull request" kept as the honest boundary;
  and repository source treated as untrusted data that may never become markup.;
  [ADR-037 credentials the page cannot read](decisions/ADR-037-credentials-the-page-cannot-read.md) —
  proposed move of the dashboard session out of `localStorage`: the refresh token to an httpOnly
  cookie, the access token to memory only, and the never-expiring API key out of the browser
  entirely. Because the dashboard is CROSS-ORIGIN with the API, `SameSite` gives no CSRF protection,
  so an origin check plus a double-submit token ship WITH the cookie rather than after it — and a
  `*` CORS origin combined with credentials must refuse to boot.;
  [ADR-038 a planner worth opening](decisions/ADR-038-a-planner-worth-opening.md) —
  proposed rework of planner and notes across dashboard, desktop and CLI: shared components instead
  of one implementation per host (notes exists twice today), a real token system instead of 67 lines
  of per-page CSS, a Today view designed for a working day rather than an empty text field, sync
  turned from a caption into a control, and the CLI given the operations a terminal is better at
  rather than an imitation of the GUI;
  [ADR-039 the half of security a model cannot see](decisions/ADR-039-the-half-of-security-a-model-cannot-see.md) —
  proposed addition of static data-flow analysis as a review INPUT rather than a parallel bot: the
  engine enumerates candidates deterministically, the model adversarially verifies which are
  reachable, and only survivors publish — argued from this release, where the two approaches found
  almost disjoint sets and raw scanner output was 300+ alerts of which 11 were real. Grounded in how
  this class of engine actually works: database-first rather than per-diff (so it is its own stage
  with its own budget, never blocking the review), precision already encoded as query metadata and
  selected by suite rather than by a filter of ours, taint models extended as DATA so our own
  chokepoints can be declared as barriers — without which it re-reports code we already fixed — and
  a separate engine licence that decides, before any engineering, whether this can run against
  customer code at all.

Published benchmark results: [`../brainrouter-benchmark/reports/`](../brainrouter-benchmark/reports/).

If you're new, read [BRAINROUTER.md](../BRAINROUTER.md) first. If you just
want to run something, [README.md → Quick Start](../README.md#quick-start).
