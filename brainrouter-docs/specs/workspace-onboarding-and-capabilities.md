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
- selected research, data, study, and writing profile packs contribute one
  same-ID JSON execution policy for their domain persona; pack selection adds
  inventory, while the agent selection remains the execution gate;
- engineering keeps its single `engineer` persona and the task-scoped frontend
  capability contributes skills and tools, never a second persona or executor;
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

## Bootstrap Compatibility Boundary

BrainRouter CLI and Desktop project setup use the shared package-local
workspace contracts and bundled starter skills. Their onboarding paths do not
call `list_template_docs`, `get_template_doc`, or `get_skill`, so creating or
editing a workspace remains available without a live brain connection.

The server tools are deprecated only as a first-party onboarding dependency:

- `get_skill`, skill search, and skill CRUD remain the server-backed library
  for non-onboarding workflows;
- `list_template_docs` and `get_template_doc` remain compatible for downstream
  clients that serve project-specific documentation through the brain;
- no tool is removed or silently redirected by this deprecation.

## Knowledge Subsystem Contract

### Identity and authorization

The canonical remote workspace identity is the existing `projects.project_id`
under `org_id`. REST and MCP adapters construct a server-side actor from
authentication, then verify organization, Project, membership, and role. A
foreign or inaccessible identifier returns 404. Request payloads do not set
`orgId`, `userId`, or role.

The shared actor contract grants knowledge read access to every organization
role and write access to developer, admin, and owner roles. Project resolution
uses one exact tenant-bound query: organization administrators may access every
Project in that organization, while other members may access open Projects and
restricted Projects where they have explicit membership.

The internal base service generates identifiers and timestamps on the server,
normalizes bounded names and descriptions, and scopes every base query by
organization plus Project. Missing, foreign, and concurrently deleted bases use
the same not-found result; an identifier alone is never sufficient for access.

The authenticated REST adapter exposes scoped base CRUD at
`/api/knowledge/projects/:projectId/bases` and retrieval at
`POST /api/knowledge/projects/:projectId/search`. It derives the actor from
bearer and active-organization middleware, forwards only operation-specific
content fields, and omits organization and creator identities from responses.
Stable failures map to 400, 403, 404, and 409 without weakening the domain
service's ID isolation.

Authenticated HTTP MCP sessions expose `knowledge_list`,
`knowledge_base_create`, `knowledge_ingest`, `knowledge_status`, and
`knowledge_retry`, plus citation-bearing `knowledge_search`, only when the
server has pinned user, organization, and role context. Stdio sessions do not
advertise or execute knowledge tools without equivalent trusted tenant
context. Tool inputs cannot override actor identity, role, or administrator
status. Document lifecycle tool results also omit content, hashes, tenant
ancestry, creator identity, queue errors, and generic job identifiers.

Desktop resolves the active git remote against accessible Projects and requires
an explicit create/link or selection when there are zero or multiple matches.
Dashboard uses its selected organization and Project. HTTP MCP sessions reject
requests and require reconnect when their authenticated user, organization,
role, or administrator context changes.

### Storage and processing

The knowledge domain owns bases, documents, chunks, retrieval, and parse-job
adapters while reusing the existing Postgres executor/pool, embedding service,
and tenant-fair job runner.

- Bases and documents carry `org_id` + `project_id` with composite consistency
  constraints.
- The schema also carries that ancestry through chunks and embeddings, rejects
  cross-project attachment at the database boundary, deduplicates persisted
  content within each base, and keeps knowledge vectors independent from
  cognitive-vector rebuilds.
- Ingest v1 accepts bounded plain text/Markdown and persists metadata plus
  normalized, redacted parsed content; it does not persist unredacted raw data.
- The internal document store uses the complete base/organization/Project
  ancestry for identifier and content-hash reads, bounded status listings, and
  lifecycle updates. Persisted-content dedupe remains per base.
- Text preparation applies byte bounds before expensive work, normalizes line
  endings, redacts secrets before hashing or persistence, and atomically creates
  the document with a tenant-scoped versioned parse job. The job payload carries
  ancestry and document identifiers only, never source content.
- The parse job is internal-only, validates the complete ancestry and parse
  version, creates deterministic content-hashed chunks, and transactionally
  replaces chunks before marking the document ready. A repeated ready job is a
  no-op; failures expose only a safe document status message.
- After chunks are ready, the job resolves an immutable embedding provider for
  the owning organization, bounds and validates same-dimension vectors, and
  idempotently upserts model/dimension-tagged rows through the complete chunk
  ancestry. Provider absence preserves FTS readiness; provider failures expose
  no upstream detail and use the queue's bounded retry path. Lease heartbeats do
  not grow the visible progress log.
- Parsing, chunking, and embedding run asynchronously and idempotently.
- Document status (`queued`, `parsing`, `ready`, `failed`) is the UI truth.
- Retry is scoped by job kind, tenant, Project, and base; generic job retry is
  never exposed. The internal status view omits document content, hashes,
  tenant ancestry, creator identity, job identifiers, and queue errors. Retry
  serializes on the exact document version, reuses active work, and creates a
  new audit job only when no pending or running parse exists.
- Knowledge vectors are isolated from cognitive vector-dimension rebuilds.
- Hybrid retrieval fuses FTS and exact cosine results, falls back to FTS when
  embeddings fail, and returns document/chunk provenance and citations.
- Additional formats land one parser at a time after the text pipeline is
  production-safe. Inline HTML is supported with a 1 MiB UTF-8 input cap;
  executable/metadata/template content and all tag attributes are discarded,
  extracted text is redacted before persistence, and URLs or host paths are
  never fetched. Authenticated REST PDF ingest accepts canonical base64 only,
  validates a PDF signature within the first 1,024 bytes, caps decoded input at
  2 MiB, performs bounded local text extraction, and persists only normalized,
  redacted text before queuing the standard ID-only parse job. The dedicated
  authenticated `knowledge_ingest_pdf` MCP tool reuses that exact service
  boundary with session-pinned identity and a content-free response.
  Authenticated REST DOCX ingest uses a distinct canonical-base64 contract with
  a 4 MiB compressed cap, validates ZIP entry count, paths, compression
  methods, declared and actual expansion, compression ratios, package parts,
  CRCs, XML depth, and safe entities, and never follows package relationships.
  Only normalized, redacted main-document text is persisted; DOCX MCP parity
  remains a separate slice with the same no-raw-content rule.

### Serving and distillation

Base list/create are available through authenticated REST and MCP adapters; the
MCP tool names are `knowledge_list` and `knowledge_base_create`. Authenticated
REST and MCP expose accepted text ingest, content-free processing status, and
exact-scope retry; the document MCP tools are `knowledge_ingest`,
`knowledge_ingest_pdf`, `knowledge_status`, and `knowledge_retry`.
Authenticated REST retrieval and the `knowledge_search` MCP tool expose the
same bounded, citation-bearing hybrid result contract. Profile recommendation
intersects the shared profile catalog with actually available packs/personas
and is never an ACL.
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
| W2b | Done | Two-flow chain, transactional state machine, editor, complete scan/command semantics | Startup/command/cancel/edit tests |
| W3b | Done | Baseline desktop dialog | Renderer lifecycle tests + live visual QA |
| W3c | Done | Shared proposal schema, conversational suggestion, bounded initializer in CLI/Desktop | Deterministic/model/failure/confirmation tests |
| W3d | Done | Finish Setup + Workspace Settings editor | Round-trip/unknown-field/re-entry tests |
| W5a | Done | Domain persona overlay registry, excluding any frontend persona | Catalog/shadowing/briefing tests |
| C1 | Done | `allowed-tools` parsing and effective per-turn intersection | Parser + local/MCP enforcement tests |
| C2/C4 | Done | Profile plugins, scoped specialist executors, and engineering frontend/design flow | Plugin discovery + skill/executor workflow tests |
| W4a | Done | Persona/capability prompt activation for root + children | Exact no-manifest and positive/negative activation tests |
| W4b | Done | Skill catalog/packs + explicit tool-profile mapping | CLI/Desktop parity and policy tests |
| W4c | Done | Briefing + memory tags | Capture/briefing/no-manifest tests |
| W6 | Done | Client bootstrap deprecation | Offline core proposal coverage + downstream template-doc compatibility tests |
| B1a | Done | Project/RBAC contract, schema, internal store, REST base CRUD, MCP base list/create | Migration + role/access + scoped CRUD + authenticated adapter tests |
| B1b/B2 | Done | Text ingest, typed parse jobs, status, scoped retry | Safe ingest + atomic enqueue + idempotent chunk/status/optional embedding + authenticated REST and MCP ingest/status/retry |
| B1c | Done | Hybrid retrieval and citation APIs/tools | FTS/vector/fallback/tenancy tests |
| B1d | In progress | Bounded inline HTML, REST/MCP PDF, and REST DOCX ingest shipped; DOCX MCP remains | Per-format bounds/redaction/no-fetch tests |
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
