# ADR-021 — Workspace Onboarding: Typed Profiles, Dynamic Capabilities & Knowledge

**Status:** Accepted (phased; W0–W6 shipped; knowledge phases remain) · **Builds on** ADR-010
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

Markdown agent files supply domain identity; optional same-ID JSON files supply
executable child policy. With a readable manifest, reserved orchestration
harness roles remain available while other JSON executors are model-visible and
spawnable only when named by `agents.default` or `agents.enabled`. The raw
registry remains available for inventory and diagnostics, and the no-manifest
path retains its complete legacy executor catalog.

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

The additive schema foundation uses `knowledge_bases`, `knowledge_documents`,
`knowledge_chunks`, and `knowledge_chunk_embeddings`. Every descendant repeats
organization and Project ancestry and proves it through composite foreign keys.
Documents deduplicate by persisted-content hash within a base and expose
`queued`, `parsing`, `ready`, or `failed` as their lifecycle truth. Chunk FTS and
knowledge embeddings are separate from cognitive-memory indexes; knowledge
vectors record their model and dimensions and use exact, dimension-filtered
retrieval until a later scale-driven indexing decision is justified.

Knowledge authorization has a transport-neutral actor derived only from trusted
authentication context. Central RBAC grants `knowledge:read` to every member
role and `knowledge:write` to developer, admin, and owner roles. Exact Project
lookup binds actor organization and user identity in SQL; missing, foreign, and
restricted Projects that the actor cannot access all resolve identically.
Knowledge-base CRUD is exposed first as a transport-neutral service backed by
queries that include organization and Project scope on every read and write;
adapters cannot address a base by its identifier alone.
The REST adapter derives its actor from authenticated request context, exposes
base CRUD beneath a Project-scoped path, and does not accept or return tenant
organization, user, role, or administrator fields. Authenticated HTTP MCP
sessions advertise base list/create tools only when user, organization, and
role are all pinned by the server. Stdio sessions do not expose knowledge tools
without an equivalent trusted organization context. MCP requests cannot
override tenant identity, role, or administrator status, and responses omit
organization and creator identities.

## Delivery order

- **W0–W3a (shipped)** — bundled starter skills; core manifest/presets; CLI
  project onboarding baseline; desktop manifest IPC and shared suggestion.
- **W1c** — correct the manifest/presets/writers to one engineer plus dynamic
  capabilities, add legacy normalization, and make `workspace.json` committable.
- **W2b/W3b** — complete CLI editing/two-flow chaining and desktop onboarding,
  re-entry, editable selections, accessibility, and lifecycle tests.
- **W3c** — conversational suggestion and bounded setup agent with deterministic
  fallback and confirmation-only writes.
- **W4** — shared runtime persona/capability/skill/tool/briefing/memory wiring,
  including delegated tasks and strict no-manifest compatibility tests.
- **W5/W6 (shipped)** — domain persona definitions, packs/docs, and client
  bootstrap-path deprecation. First-party project setup is package-local and
  offline-capable; server skill and template-doc tools remain available for
  downstream clients.
- **C1/C2/C4 (shipped)** — skill tool allowlists, plugin-delivered
  profile/capability packs with selected same-ID specialist executors, and the
  frontend design-artifact workflow without a separate frontend persona.
- **B1a (shipped)** — project-consistent knowledge
  storage, central read/write roles, a server-derived actor, exact Project
  access resolution, scoped base CRUD, authenticated REST routes, and
  authenticated HTTP MCP base list/create tools.
- **B1b (ingest foundation shipped)** — typed document lifecycle records;
  ancestry-scoped persistence; bounded plain-text/Markdown normalization,
  redaction, and persisted-content dedupe; plus atomic enqueue of an ID-only,
  tenant-scoped parse job. The internal runner now performs version-checked,
  deterministic, transactional chunk replacement with idempotent ready/failed
  status truth, then optionally writes organization-provider, model/dimension-
  tagged embeddings. Missing providers preserve FTS-ready documents; embedding
  failures remain safely retryable. A transport-neutral, content-free status
  view and exact-scope retry service now deduplicate active work without
  exposing generic job identifiers. Public status/retry adapters follow independently.
- **B1c–B3** — async retrieval; profile-aware recommendations and
  opt-in sourced distillation.
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
