# Memory & Persona Scoping (ADR-014 Phase C)

How a user's knowledge stays separated — and shared — across **solo**, **team**, and **org**
contexts. The one rule: **`org_id` partitions, `visibility` shares.**

## The unit

The tenancy unit is the **Team** (the `organizations` row, keyed by `org_id`). Every user always
has a **personal Team** (`org_personal_<userId>`, plan `free`) — the local-first, no-permission-wall
default. Joining a shared Team adds a membership with a role. The **active Team** for a request is the
`X-BrainRouter-Org` header (fallback: the user's `default_org_id`).

## Memory records

Each `cognitive_records` row carries `org_id` + `visibility ∈ {private, org}`:

| Situation | `org_id` | `visibility` | Visible to |
|---|---|---|---|
| Solo private note | personal Team | `private` | only the user |
| A member's private note inside a Team | the shared Team | `private` | only that user |
| Knowledge shared with the Team | the shared Team | `org` | **every member** of that Team |

Recall enforces this in `memory/recall/filters.ts` (`orgVisibilityAllows`): a member only ever sees
**their own** records plus records **shared** (`visibility='org'`) with their **active** Team. There is
a hard cross-Team boundary — Team A never sees Team B, even for the same user.

**A user who is solo AND on a team** therefore keeps two disjoint pools: their personal-Team memory
(always private to them) and, per shared Team, their private notes + the Team's shared knowledge.
Switching the active Team header switches which pool recall draws from. Nothing bleeds across.

Sharing a record with a Team is a `visibility` change (`private → org`) — gated by the plan's
`sharedMemory` feature (team+). Free/pro (solo) plans have no shared pool.

## Workspaces (inside your own memory)

Tenancy is a wall. Workspace is not — it is an **ordering**. Within the memory you are allowed to
see, recall ranks by where a record came from and never drops it for having come from somewhere
else:

| Tier | Meaning |
|---|---|
| `session` | captured in this conversation |
| `workspace` | captured in this checkout, under any of its identities |
| `untagged` | captured with no workspace at all (older records) — it belongs everywhere |
| `other-workspace` | captured in a different repository — ranked last and labelled, **never hidden** |

Every hit carries its tier as `scopeMatch`, and a foreign line in the rendered context is marked
*(another workspace)*. A lesson from another repository is sometimes exactly what you need; the
reader just has to be told it is from somewhere else, so it reads as context rather than as
instructions about this one.

**A checkout has more than one identity.** Chat turns are tagged with a hash of the folder path;
an ingested repository is tagged with a hash of its git remote, so it survives a moved folder or a
second clone (ADR-015). The client sends **both** (`workspaceTags`), and recall treats either as
`workspace`. Sending only one is how a repository's own ingested files used to be labelled as
another repository's.

The client fills this in — the model cannot know its session key or its workspace's hashes. The
dispatcher adds them to every `memory_search` and `memory_recall` sent to BrainRouter's own brain
(never to a third-party server's tool of the same name), and the per-turn briefing sends them too.

**Other coding agents** reach the brain as an ordinary MCP server and send no scope of their own.
For those, the brain asks the client for its declared workspace folders (MCP `roots`) — once per
connection, with a short timeout, refreshed when the client reports its roots changed — and applies
them as the same preference. A client that declares no roots, or does not answer, simply gets
today's unscoped ranking. A remote brain cannot read the client's git remote, so this gives the
folder identity only; that is the one a CLI session in the same checkout also carries.

Two mechanisms, deliberately separate:

- **Preference** — `workspaceTags` on `memory_search` / `memory_recall`. Orders and labels.
  Implemented once, in `memory/scope.ts`, and applied inside the recall pipeline.
- **Hard filter** — `filters.workspaceTag` / `filters.workspaceTags` on `memory_recall`. Drops
  another workspace's records (untagged ones still surface). Opt-in, for a caller that truly wants
  one repository only.

## Persona

Persona follows the same partition, in two layers:

1. **Personal persona** — `core_identity(user_id)`, distilled from the user's own `persona`/
   `instruction` memories. This is who *you* are; it never mixes with a Team.
2. **Team consensus persona** — `org_identity(org_id)`, distilled from the Team's **shared**
   (`visibility='org'`) `persona`/`instruction` memories — team SOPs, conventions, shared identity.
   Gated by the plan's `orgPersona` feature (team+).

The persona **cache** is keyed by `(userId, orgId)` so `you-in-Team-A` and `you-in-Team-B` never collide.
When acting in a Team context, the injected persona is your **personal persona + the Team overlay**;
acting solo, it's just your personal persona.

## Providers, projects, artifacts

The same `org_id` scoping already governs provider configs, integrations, and (Phase D) artifacts.
Projects (Phase E) scope further *within* a Team. In every case: a query without the caller's `org_id`
in its `WHERE` is a tenancy bug.
