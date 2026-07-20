# ADR-021 — Workspace Onboarding: Typed Profiles, Domain Personas & the Workspace Knowledge Subsystem

**Status:** Accepted (phased; W0 shipped) · **Builds on** ADR-010 (org/team/user tenancy),
ADR-017 (production flows), ADR-019 (org/workspace switcher), ADR-020 (memory self-improvement) ·
**Touches** `packages/core` (manifest chokepoint), `brainrouter-cli` (`/init` v2, personas, bundled skills),
`brainrouter-desktop` (add-workspace onboarding), `brainrouter/` (knowledge subsystem, profile-aware serving).

## Date

2026-07-21

## Context — every workspace gets the same engineering agent

Adding a workspace does nothing project-aware today. `/init` runs the global
config wizard or scaffolds AGENT.md; every workspace then gets the same
engineering-flavored defaults — all skills, all tools, one implicit persona. A
research, tutoring/study, writing, data-science, or frontend-design project has
no way to say what it is, so the agent that shows up is mismatched (an
engineering agent on a research project). There is also no durable marker that
a project has been onboarded for BrainRouter at all.

Two structural gaps compound this:

1. **Init depends on the server.** Project initialization historically runs
   through the brain (template serving + the bootstrap skill via `get_skill`),
   so onboarding requires a live connection. Worse, a CLI-only or desktop
   install shipped with ZERO bundled skills — bundled skill roots resolved only
   through the installed MCP-server package.
2. **Profiles need capabilities we don't serve.** A study profile needs
   tutoring workflows (step-by-step explanation, quiz generation, mastery
   tracking through memory). A research profile needs document-grounded
   knowledge retrieval, not just web search. Frontend work inside an
   engineering workspace needs a design-system-first build pipeline — a
   persona concern within the engineering profile, not a separate workspace
   type. None of these have first-class support in the backend or the client
   runtimes.

## Decision

### 1. A typed, committable workspace manifest — `.brainrouter/workspace.json`

One file declares what kind of project a workspace is and which
agents/skills/tools fit it: `profile` (`engineering | research | data-science |
study | writing | custom`), `agents` (default + enabled), `skills`
(packs/enabled/disabled), `tools` (profile groups + deny), `memory`
(tags/capture hints), and an `onboarded` marker. `packages/core/src/workspace/`
is the single chokepoint (schema, load/save, validation, defaults) — no other
module parses the JSON. The manifest is committable (team-shareable), never
holds secrets, and unknown fields are preserved. **No manifest → today's
behavior exactly.**

### 2. Profiles are presets, not silos

Picking a profile preselects a domain persona, skill packs, tool groups, and
memory tags — all user-editable afterwards. Profile presets live in core beside
the manifest chokepoint.

### 3. Client-side onboarding is canonical; the backend bootstrap path is deprecated

`/init` v2 (CLI wizard + optional bounded scan agent that drafts AGENT.md and
SUGGESTS a profile) and the desktop add-workspace wizard write the manifest —
fully offline. Server-side skills (`get_skill` + CRUD) remain the library;
template serving remains for downstream clients; our own onboarding stops
depending on either. The starter skill set now ships inside our packages
(`brainrouter-cli/skills/`, `packages/core/skills/`, synced from the monorepo
source of truth with a drift-failing parity test) so init works standalone.

### 4. Domain personas sit ABOVE harness roles

New persona definitions (`engineer`, `researcher`, `data-scientist`, `tutor`,
`writer`, `frontend-builder`) join the agent catalog beside — not instead of —
the orchestration harness roles (architect/explorer/reviewer/verifier/worker).
A persona shapes briefing, default skills, and tool posture; it never changes
the orchestration tiers. Workspaces can add personas under
`.brainrouter/agents/` (existing shadowing precedence).

### 5. A workspace-scoped knowledge subsystem in the brain

To serve research/study/knowledge-heavy profiles, `brainrouter/` gains a
knowledge-base subsystem as a SIBLING of the cognitive memory graph — not a
parallel memory system: workspace/org-scoped knowledge bases with document
ingest → parse → chunk → embed → retrieve, reusing pgvector, the embedding
runtime, ADR-010 tenancy, and the parallel per-tenant job-runner pattern for
parse workers. Ingest and retrieval respect the existing security chokepoints
(userId pin, redaction, length caps). MCP tools: `knowledge_ingest`,
`knowledge_search`, `knowledge_list`. Durable facts still route through the
memory engine; knowledge bases hold source documents and their derived chunks.

### 6. Profile skill packs ship as plugins; skills gain `allowed-tools`

Profile packs (study, research, data, writing, and a frontend pack for the
frontend-builder persona inside engineering) are distributed
through the existing plugin-marketplace conventions (a pack is a plugin
contributing skills + personas). Skill frontmatter gains `allowed-tools` (a
per-skill tool ALLOWLIST enforced for the turn the skill runs) alongside
today's `disallowed-tools`, keeping the regex-parseable frontmatter rules.

## Phases

- **W0 (shipped)** — bundled starter skills in our packages + own-package
  bundled skill root + sync script + parity test.
- **W1–W4** — core manifest + presets → CLI `/init` v2 → desktop onboarding →
  runtime wiring (default agent, packs, tool groups, briefing, memory tags).
- **W5–W6** — domain personas + docs; backend bootstrap deprecation.
- **B1–B3 (backend)** — knowledge subsystem foundation → generalized parse job
  queue → profile-aware skill/persona serving and knowledge distillation.
- **C1–C4 (clients)** — `allowed-tools` → profile packs as plugins → knowledge
  UI → design-artifact flow for the frontend-builder persona.

## Consequences

- Workspaces self-describe; the right agent shows up per project, and
  onboarding works offline. Un-onboarded workspaces behave exactly as today.
- Two document stores exist with distinct jobs (cognitive memory vs source
  knowledge); the sibling design plus shared tenancy/chokepoints prevents the
  "parallel memory" failure mode, but reviewers must hold that line.
- Committed manifests make profile drift visible in PRs; teams inherit
  onboarding.
- The plugin marketplace becomes the delivery path for domain capability —
  packs version independently of the core release train.
- More moving parts in onboarding UX (wizard, scan agent, chip) — each step
  must stay skippable, and skipping must write nothing.
