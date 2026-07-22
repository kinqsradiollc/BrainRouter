# Spec: Workspace Onboarding, Dynamic Capabilities, and Project Knowledge

Status: Active program (approved 2026-07-21)
Owner: Core / CLI / Desktop / Brain / Dashboard
Decision: ADR-021
Target: `release/0.4.17` through small, independently reviewed PRs

## Objective

Make project setup conversational, offline-capable, editable, and useful at
runtime. A user configures BrainRouter once, then describes each workspace in
plain language or chooses a preset. BrainRouter proposes the domain agent,
capabilities, skills, tools, memory posture, and instruction-file changes,
while the user remains the final authority over every write.

The program also adds the project-scoped source-knowledge foundation required
by research and study workspaces. It must reuse BrainRouter tenancy, jobs,
embeddings, and security boundaries without becoming a second cognitive memory
system.

## Product Invariants

1. BrainRouter has two onboarding flows: global installation setup and
   per-workspace project setup.
2. Successful first-run global setup chains into project setup when the current
   workspace is not onboarded. Project Skip does not undo global setup.
3. Adding a later workspace runs project setup only. Both flows support explicit
   re-entry; project setup has an editor after onboarding.
4. `engineer` is the only engineering persona. Frontend is a dynamically
   activated engineering capability, never another persona or harness role.
5. Model assistance proposes; it never writes automatically. Every file change
   is reviewed and confirmed.
6. Project setup works offline through deterministic scanning and presets.
7. `.brainrouter/workspace.json` is committable, contains no secrets or server
   tenancy identifiers, and is parsed only by core.
8. No manifest produces the exact legacy prompt, tool, skill, briefing, and
   memory behavior.
9. Knowledge authorization uses authenticated org + existing Project access,
   never local paths, path hashes, workspace tags, or client-supplied identity.
10. Required CI and security review must pass before each PR is squash-merged.

## User Journeys

### First installation

```text
Launch
  → global provider/model/MCP/preferences setup
  → global setup commits successfully
  → current workspace has no manifest
  → project setup opens
  → confirm or Skip
  → session starts
```

Aborting global setup exits without starting project setup. Skipping project
setup leaves the workspace unchanged and starts the session with legacy
behavior. A persistent Finish Setup action remains available.

### Add or open another workspace

After trust is established and the workspace opens, BrainRouter checks its
manifest using a generation/root guard. If absent, it opens project setup. A
late response from a previously active workspace cannot open or mutate the
current workspace.

### Describe a project

The user may enter free text such as the product being built, the expected
outputs, source material, and workflows. BrainRouter combines a bounded local
scan with one structured model call and proposes:

- profile;
- domain agents;
- available dynamic capabilities;
- skill packs and individual skill overrides;
- tool profiles and denies;
- memory tags/capture hint;
- an optional `AGENT.md` draft or patch.

Desktop uses the selected managed model. CLI uses the configured session model.
If a model is unavailable or its output is invalid, the same UI is prefilled
from deterministic scanning. The proposal remains editable before confirmation.

### Set up with AI

The bounded initializer may inspect repository metadata, instructions, source
layout, manifests, tests, and documentation. It cannot mutate the project while
scanning. It returns a validated proposal plus file diffs. Only the final
confirmation writes the manifest and approved instruction file in one
transactional step. Cancellation at any stage writes neither file.

## Workspace Manifest Contract

Version 1 remains backward compatible and gains explicit capabilities:

```jsonc
{
  "version": 1,
  "name": "my-project",
  "profile": "engineering",
  "onboarded": { "at": "2026-07-21T00:00:00.000Z", "by": "wizard" },
  "agents": { "default": "engineer", "enabled": ["engineer"] },
  "capabilities": { "enabled": ["frontend"], "disabled": [] },
  "skills": {
    "packs": ["engineering"],
    "enabled": [],
    "disabled": []
  },
  "tools": { "profiles": ["coding", "terminal", "browser"], "deny": [] },
  "memory": { "tags": ["engineering"], "captureHint": "code" },
  "instructions": "AGENT.md"
}
```

Rules:

- `capabilities.enabled` means available for task-time activation, not active on
  every turn.
- `capabilities.disabled` wins over enabled and over profile defaults.
- Safe unknown fields and unknown capability IDs survive round trips; sensitive
  keys/values, tenancy IDs, and local absolute paths are discarded by core.
- Legacy `frontend-builder` defaults/enabled entries normalize to `engineer`
  plus enabled `frontend`; writers never emit the legacy ID.
- Existing version-1 manifests without capability data remain readable.
- Save uses stable two-space JSON plus a trailing newline.
- Runtime state below `.brainrouter/` remains ignored; only
  `.brainrouter/workspace.json` is re-included for commits.

## Dynamic Capability Contract

Core owns one pure resolver:

```text
resolveWorkspaceCapabilities({ manifest, activeAgent, task, files, availability })
  → active, reasons, skillPacks, skills, toolProfiles, promptBlocks
```

The first registered capability is `frontend`. It activates only when all of
the following are true:

1. the manifest exists;
2. `frontend` is enabled and not disabled;
3. the active domain agent is an enabled `engineer`;
4. task or file signals indicate UI, styling, component, accessibility,
   responsive-layout, design-system, browser-visual, or screenshot work.

When active, it contributes only frontend pack/skill/tool IDs present in the
live catalogs, plus a concise engineer overlay covering design-artifact discovery,
component-system reuse, accessibility, responsive behavior, and visual
verification. It never changes the persona from `engineer`.

Resolution occurs before per-turn tool construction and before the system
prompt is finalized. Delegated children resolve against their delegated task;
active parent capabilities are context, not an unconditional inheritance.
Capability tool mappings filter the per-turn surface and never mutate global
extension state.

## Runtime Profile Effects

For an onboarded workspace:

- session creation selects `agents.default` and injects its domain-persona
  briefing;
- the picker offers every enabled domain agent;
- reserved orchestration roles remain executable, while other JSON execution
  definitions appear only when selected by `agents.default` or
  `agents.enabled`;
- enabled skill packs are prioritized, disabled skills are absent from ambient
  suggestions, and explicit invocation remains policy-gated;
- active capabilities contribute per-turn packs/skills/tool profiles;
- profile tool groups map to concrete extension/tool IDs through one registry;
- briefing gets a concise profile/persona/capability context;
- memory capture adds manifest tags through the existing capture chokepoint.

For an un-onboarded workspace, every resolver returns a no-op and prompt-layer
tests prove the output is unchanged.

## Assisted-Onboarding Safety Contract

- Scan inputs have explicit file-count, byte, depth, and time limits.
- Ignore VCS metadata, dependencies, build output, secrets, and binary content.
- Model calls receive bounded summaries rather than arbitrary repository dumps.
- Structured output uses the shared bounded JSON extraction/validation path;
  greedy regular expressions are forbidden.
- The proposal schema allowlists profile IDs, normalizes arrays, caps strings,
  and rejects unknown write targets.
- Setup can propose only `.brainrouter/workspace.json` and the selected
  instruction file.
- Existing files are patched only after a visible diff and explicit approval.
- Model failures, timeouts, invalid JSON, or unavailable credentials fall back
  to deterministic results without blocking manual setup.

## Knowledge Subsystem Contract

### Identity and authorization

The canonical remote workspace identity is the existing `projects.project_id`
under `org_id`. REST and MCP adapters construct a server-side actor from
authentication, then verify organization, Project, membership, and role. A
foreign or inaccessible identifier returns 404. Request payloads do not set
`orgId`, `userId`, or role.

Desktop resolves the active git remote against accessible Projects and requires
an explicit create/link or selection when there are zero or multiple matches.
Dashboard uses its selected organization and Project. HTTP MCP sessions reconnect
when organization context changes.

### Storage and processing

The knowledge domain owns bases, documents, chunks, retrieval, and parse-job
adapters while reusing the existing Postgres executor/pool, embedding service,
and tenant-fair job runner.

- Bases and documents carry `org_id` + `project_id` with composite consistency
  constraints.
- Ingest v1 accepts bounded plain text/Markdown and persists metadata plus
  normalized, redacted parsed content; it does not persist unredacted raw data.
- Parsing, chunking, and embedding run asynchronously and idempotently.
- Document status (`queued`, `parsing`, `ready`, `failed`) is the UI truth.
- Retry is scoped by job kind, tenant, Project, and base; generic job retry is
  never exposed.
- Knowledge vectors are isolated from cognitive vector-dimension rebuilds.
- Hybrid retrieval fuses FTS and exact cosine results, falls back to FTS when
  embeddings fail, and returns document/chunk provenance and citations.
- Additional formats land one parser at a time after the text pipeline is
  production-safe.

### Serving and distillation

`knowledge_list`, `knowledge_ingest`, and `knowledge_search` are available over
authenticated REST/MCP adapters. Profile recommendation intersects the shared
profile catalog with actually available packs/personas and is never an ACL.
Opt-in distillation writes provenance-linked derived knowledge documents and
prevents recursive self-distillation. Only separately reviewed facts may be
captured into cognitive memory through its current engine.

## Surface Requirements

### CLI

- Bare `/init` runs project setup or shows the editable summary when onboarded.
- `/init config` runs global setup, then chains project setup only after success.
- Startup runs project setup for a globally configured user in a new workspace
  before constructing the session agent.
- `/init --edit` reloads and updates while preserving unknown fields.
- `/init scan` produces a full deterministic proposal and optional instruction
  diff; it does not write before confirmation.
- `/init agent` runs the bounded assisted initializer.
- `/init agentmd` remains the distinct legacy instruction-only alias.

### Desktop

- Add/open workspace can launch setup after trust and successful open.
- Skip writes nothing and exposes a persistent Finish Setup action.
- Workspace Settings edits the entire supported manifest contract.
- Profile, capabilities, skills, and tools are reviewable before save.
- Describe and Set up with AI share the same proposal-confirmation UI.
- Dialog semantics include an accessible title/description, focus containment,
  keyboard navigation, Escape/cancel behavior, busy/error announcements, and
  focus restoration.
- Async calls are guarded by active root/generation and cancellation.

### Knowledge UI

- Dashboard extends the existing Knowledge Library rather than adding a
  duplicate destination.
- Desktop adds a first-class Knowledge panel through the host query bridge;
  credentials, Node primitives, and local paths never cross into the renderer.
- Both surfaces support base selection, ingest, document status/error, scoped
  retry, and citation-bearing search preview.
- Query keys include organization and Project; switches abort or discard stale
  responses.

## Delivery Board

| Phase | Status | Scope | Exit evidence |
|---|---|---|---|
| W0 | Done | Bundled starter skills | Package parity and discovery tests |
| W1 | Done | Manifest + initial presets | Core manifest tests |
| W2 | Done, gaps tracked in W2b | CLI project-onboarding baseline | CLI helper tests |
| W3a | Done | Desktop manifest IPC + shared suggestion | Desktop main-process tests |
| W1c | Implemented | One engineer, capability schema/resolver, legacy normalization, committable manifest | Focused checks + full workspace verify |
| W2b | Todo | Two-flow chain, transactional state machine, editor, complete scan/command semantics | Startup/command/cancel/edit tests |
| W3b | In progress, uncommitted | Baseline desktop dialog | Renderer lifecycle tests + live visual QA |
| W3c | Todo | Shared proposal schema, conversational suggestion, bounded initializer in CLI/Desktop | Deterministic/model/failure/confirmation tests |
| W3d | Todo | Finish Setup + Workspace Settings editor | Round-trip/unknown-field/re-entry tests |
| W5a | Todo | Domain persona overlay registry, excluding any frontend persona | Catalog/shadowing/briefing tests |
| C1 | Todo | `allowed-tools` parsing and effective per-turn intersection | Parser + local/MCP enforcement tests |
| C2/C4 | Todo | Profile plugins and engineering frontend/design flow | Plugin discovery + skill workflow tests |
| W4a | Todo | Persona/capability prompt activation for root + children | Exact no-manifest and positive/negative activation tests |
| W4b | Todo | Skill catalog/packs + explicit tool-profile mapping | CLI/Desktop parity and policy tests |
| W4c | Todo | Briefing + memory tags | Capture/briefing/no-manifest tests |
| W6 | Todo | Client bootstrap deprecation | No client dependency + downstream compatibility tests |
| B1a | Todo | Project/RBAC contract, schema, internal store, scoped base CRUD/list | Role/cross-org/restricted-project/Postgres tests |
| B1b/B2 | Todo | Text ingest, typed parse jobs, status, scoped retry | 202/status/retry/idempotency/fairness tests |
| B1c | Todo | Hybrid retrieval and citation APIs/tools | FTS/vector/fallback/tenancy tests |
| B1d | Todo | Additional document parsers | Per-format bounds/redaction tests |
| B3 | Todo | Availability-aware recommendations and opt-in distillation | Catalog/provenance/no-recursion tests |
| C3 | Todo | Dashboard library expansion + Desktop knowledge panel | SDK, stale-scope, host bridge, UI inventory/live QA |
| Final | Todo | Full suite, live CLI/Desktop/backend/dashboard walkthrough, docs/changelog | Green CI/security review and merged PRs |

## Required Regression Matrix

### Onboarding

1. Fresh user completes global setup, then project setup begins.
2. Global abort prevents project setup.
3. Existing global config plus a new workspace begins project setup.
4. Existing manifest suppresses automatic prompting.
5. Skip/cancel at every project step writes no project files.
6. Save writes engineer plus frontend capability, never a frontend persona.
7. Edit preserves unknown fields.
8. A delayed response for workspace A cannot affect active workspace B.
9. Finish Setup and Settings re-entry operate on the active workspace.
10. Model timeout/invalid output uses deterministic fallback.

### Runtime

1. No manifest produces exactly the previous prompt layers and tool/skill set.
2. Engineering backend task does not activate frontend.
3. UI task or frontend file signal activates frontend while persona stays
   engineer.
4. Disabled frontend never activates.
5. Delegated UI child activates independently; unrelated child does not.
6. Access mode, role scope, and deny rules still override capability/skill
   additions.

### Knowledge

1. Cross-org and inaccessible Project IDs cannot be observed or mutated.
2. Ingest returns queued status and performs no heavy inline parsing.
3. Redaction and size caps run before persistence and again per chunk.
4. Parse retries are scoped and idempotent.
5. Search returns citations and survives embedding failure through FTS.
6. Organization/Project switches cannot display stale data.

## Verification and Shipping

Each PR runs focused tests for touched packages, then the full workspace suite
sequentially with a clean CLI home. Server schema slices include Postgres
integration tests. UI slices run live in the real Desktop/browser surface and
capture visual evidence before commit. Every PR uses a conventional title,
contains no attribution trailer, passes required CI and security review, and is
squash-merged into `release/0.4.17` before the next dependent slice begins.

## Definition of Done

- Both onboarding lifecycles and every re-entry path match this specification.
- All current writers and runtime consumers use the shared core contracts.
- Engineer/frontend legacy data is migrated and no new legacy ID is emitted.
- Assisted setup is bounded, validated, deterministic on failure, and
  confirmation-only.
- Runtime profile/capability/skill/tool/briefing/memory behavior is active in
  both CLI and Desktop with exact no-manifest compatibility.
- Domain packs, tool allowlists, and design-artifact flow are shipped.
- Project-scoped knowledge ingest, jobs, retrieval, recommendations,
  distillation, Dashboard, and Desktop surfaces are shipped and tenant-safe.
- Documentation/changelog/walkthrough are current; all PRs are merged only
  after green CI and review.
