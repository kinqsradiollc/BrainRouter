# ADR-021 — Workspace Onboarding: Typed Profiles, Dynamic Capabilities & Knowledge

**Status:** Accepted (phased; W0–W3a shipped; transactional CLI foundation implemented) · **Builds on** ADR-010
(org/team/user tenancy), ADR-017 (production flows), ADR-019 (org/project
switching), ADR-020 (memory self-improvement) · **Touches** `packages/core`,
`brainrouter-cli`, `brainrouter-desktop`, `brainrouter`, and the dashboard.

## Date

2026-07-21

## Context

Adding a workspace has historically done no project-aware setup. The global
provider/model wizard and project initialization were both exposed as
“onboarding”, while every project still received the same engineering-flavored
agent, skills, and tools. There was no durable marker describing whether a
project was a software project, research collection, course of study, writing
workspace, or data-science project.

Typed workspace profiles also require capabilities that are not yet available
end to end. Research and study work need source-grounded knowledge retrieval.
Frontend engineering needs design-system, component, accessibility, and visual
verification guidance, but that does not make it a different agent or a
different workspace profile. Finally, initialization must work without a live
brain while still being able to use a configured model when one is available.

## Decision

### 1. Global onboarding and workspace onboarding are separate, ordered flows

BrainRouter has exactly two onboarding lifecycles:

1. **Global setup**, once per installation/user, configures the provider,
   model, MCP connections, and application preferences.
2. **Workspace setup**, once per project, describes that project and writes its
   local manifest.

On first launch, successful global setup chains into workspace setup when the
current workspace has no manifest. Cancelling workspace setup writes nothing
and never invalidates completed global setup. Adding another workspace runs
only workspace setup. Both flows can be re-entered explicitly for editing.

### 2. A typed, committable workspace manifest

`.brainrouter/workspace.json` declares the workspace profile, domain agents,
available task-time capabilities, skills, tool groups, memory posture,
instruction-file pointer, and onboarding marker. `packages/core/src/workspace/`
is the only schema/load/save/normalization chokepoint; no consumer parses the
JSON independently.

The manifest is safe to commit and contains no credentials, organization IDs,
project IDs, local absolute paths, or raw instruction content. Safe unknown
fields and unknown capability IDs are preserved for forward compatibility;
obvious sensitive keys/values and local absolute paths are discarded at the
core boundary. Invalid values degrade safely. **No manifest means byte-for-byte
legacy behavior.**

`.brainrouter/` remains ignored for runtime state, but `workspace.json` is an
explicit exception so the team-sharing contract is real.

### 3. Profiles are editable presets, not silos

Profiles (`engineering`, `research`, `data-science`, `study`, `writing`, and
`custom`) preselect a domain agent, task-time capabilities, skill packs, tool
groups, and memory tags. They do not restrict what a user can subsequently
edit. `custom` starts empty.

### 4. Engineer is one persona; frontend is a dynamic capability

There is one `engineer` domain persona. There is no `frontend-builder` persona,
agent, orchestration role, or selectable default. The engineering preset uses:

```json
{
  "agents": { "default": "engineer", "enabled": ["engineer"] },
  "capabilities": { "enabled": ["frontend"], "disabled": [] }
}
```

An enabled capability is available for per-turn activation; it is not injected
on every turn. A shared resolver combines the manifest, active domain agent,
current task, relevant file signals, and live skill/tool catalogs. Frontend work
activates only for an enabled active `engineer`; its available skill pack, tool
groups, and prompt overlay apply for that turn while the identity remains
`engineer`.
Backend, infrastructure, or general engineering work receives no frontend
overlay. Explicitly disabled capabilities always win.

Root agents and delegated children use the same resolver against their own task.
Harness roles (`architect`, `explorer`, `reviewer`, `verifier`, and `worker`)
remain unchanged and orthogonal to domain persona/capability selection. Legacy
manifests containing `frontend-builder` normalize to `engineer` with the
`frontend` capability enabled.

### 5. Client-side workspace setup is canonical and progressively assisted

The CLI and desktop share the manifest, profile, deterministic scan, suggestion,
and validation contracts from core. Workspace setup always works offline. When
a model is available, the user may describe the project conversationally or run
a bounded setup agent. Model output is a suggestion only: it is schema-validated,
shown in the same editable confirmation UI, and never written without explicit
confirmation.

Desktop uses the selected managed model. CLI uses the configured session model.
Both fall back to deterministic filesystem signals when model access fails. The
setup agent is read-only while inspecting a project and can propose manifest and
instruction-file changes; every write is presented as a diff and confirmed.

Starter skills ship in BrainRouter’s own CLI/core packages so this path does not
depend on server template tools. Existing server template and bootstrap serving
remain available for downstream clients but are deprecated for BrainRouter’s
own onboarding.

### 6. Runtime effects are resolved at shared chokepoints

The manifest affects the default domain agent, capability overlays, skill
catalog ordering/filtering, per-turn tool exposure, briefing context, and memory
capture tags. Capability tool profiles map explicitly to existing extension/tool
IDs; they do not mutate process-global extension settings. Desktop and CLI use
the same core resolution. A missing/unreadable manifest yields an exact no-op.

Profile and capability context also propagates to delegated agents. A child
resolves capabilities from its delegated task instead of blindly inheriting the
parent’s active overlay.

### 7. Domain capability packs use the plugin system; skills gain allowlists

Study, research, data, writing, and frontend capability packs are delivered
through the existing plugin conventions. Skills gain `allowed-tools` as a
per-turn allowlist alongside `disallowed-tools`; the effective surface is the
intersection of access policy, role scope, capability scope, and skill
allowlist, followed by deny rules. Required security gates cannot be bypassed.

The frontend capability owns design-artifact awareness, component-system
discipline, accessibility checks, and screenshot/browser verification. These
are engineering skills, not a second engineer identity.

### 8. Knowledge is project-scoped source retrieval, not another memory system

The brain gains a knowledge subsystem as a sibling of cognitive memory:
knowledge bases, documents, parsed chunks, embeddings, hybrid retrieval,
source citations, parse jobs, and optional derived notes. Knowledge requests
are scoped to an authenticated organization and its existing Project resource.
The server derives organization/user/role from authentication and verifies
Project access; it never authorizes from a local path, basename, workspace tag,
or client-supplied organization/user identity.

The local manifest does not store server `orgId`, `projectId`, or a replacement
workspace ID. Desktop resolves the active repository to an accessible Project
and asks the user when the match is absent or ambiguous. Knowledge setup for a
repository with no Project requires an explicit create/link action.

Ingest is asynchronous: cap and redact input, create a queued document, process
parse/chunk/embed work through the existing tenant-fair job infrastructure, and
expose status/retry through project-scoped APIs. Raw unredacted payloads are not
persisted in the first version. Retrieval remains independent from cognitive
recall ranking and returns provenance-rich citations. Only explicitly accepted
distilled facts enter cognitive memory through its existing engine.

## Delivery order

- **W0–W3a (shipped)** — bundled starter skills; core manifest/presets; CLI
  project onboarding baseline; desktop manifest IPC and shared suggestion.
- **W1c (shipped)** — one engineer plus dynamic capabilities, legacy
  normalization, and a committable `workspace.json`.
- **W2b foundation (implemented)** — ordered global/workspace setup, edit
  re-entry, recoverable global and project writes, and commit-first model,
  MCP-profile, account, and live-brain reconciliation. Assisted scan and setup
  commands remain in W3c.
- **W3b** — complete desktop onboarding, re-entry, editable selections,
  accessibility, and renderer lifecycle tests.
- **W3c** — conversational suggestion and bounded setup agent with deterministic
  fallback and confirmation-only writes.
- **W4** — shared runtime persona/capability/skill/tool/briefing/memory wiring,
  including delegated tasks and strict no-manifest compatibility tests.
- **W5/W6** — domain persona definitions, packs/docs, and client bootstrap-path
  deprecation. Persona definitions needed by runtime land before their use.
- **C1/C2/C4** — skill tool allowlists, plugin-delivered profile/capability packs,
  and the frontend design-artifact workflow.
- **B1–B3** — project/RBAC foundation and knowledge store; async parsing and
  retrieval; profile-aware recommendations and opt-in sourced distillation.
- **C3** — dashboard and desktop knowledge management after the server contracts
  and job status APIs are stable.

The executable scope, dependency graph, acceptance criteria, and verification
matrix live in the companion workspace-onboarding specification.

## Consequences

- Users configure infrastructure once and describe each project separately.
- One engineering identity can move naturally across backend and frontend work
  without persona switching, while task-specific guidance stays focused.
- Committed manifests make project intent and capability drift reviewable.
- Offline setup remains reliable; model assistance improves suggestions without
  becoming an authority or a write path.
- Knowledge is tenant-safe and source-grounded without polluting or duplicating
  cognitive memory.
- The program spans core, clients, backend, and dashboard, so each phase ships as
  a small PR with full tests and must pass required CI before squash merge.
