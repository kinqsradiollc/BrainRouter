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
