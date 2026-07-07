# ADR-014 — Enterprise Completion Program (tenancy, memory/persona, sharing, email, hosting)

**Status:** Accepted (program) · **Supersedes nothing** · **Extends** ADR-010 (multi-tenancy),
ADR-012 (providers DB-only), ADR-013 (memory/auth split).

## Context

ADR-010 gave BrainRouter organizations, four roles (`owner > admin > member > viewer`),
seven capabilities, per-user personal orgs, and org-scoped **memory** (`cognitive_records.org_id`
+ `visibility ∈ {private, org}`, enforced in recall via `orgVisibilityAllows`). Provider and
integration configs are already org-scoped (`provider_configs.org_id`, `integration_configs.org_id`).

A grounded audit of the codebase found the enterprise story is ~40% complete. What is **missing**:

- **Plan tiers are decorative.** `organizations.plan ∈ {single, team, enterprise}` is stored but
  gates nothing — no seat limits, no feature flags, no "which repos may a plan use".
- **Persona is user-only.** `core_identity` has no `org_id`/`visibility`; a user in two orgs shares
  one persona, and there is no team/org consensus persona.
- **Artifacts are session-only.** `CognitiveRecord` (in `packages/types`) lacks `org_id`/`visibility`;
  capture tools can't mark work org-shared; there is no MCP tool to share to an org or browse it.
- **No projects.** "Project"/"repo" exist only as free-text tags (`workspace_tag`, `project_tag`);
  no entity tables, no per-project access control.
- **No email.** No verification, no invitation emails (invitees must pre-exist), no domain allowlist,
  no password reset.
- **Hosting is under-documented.** No Cloudflare-tunnel path, no client health-check fallback, no
  single knob to point the same build at localhost vs tunnel vs hosted.
- **No admin console** over all orgs/plans/seats.

## Decision — the tenancy model (the spine)

**One codebase, three deployments** (self-hosted localhost, self-hosted behind a Cloudflare tunnel,
hosted multi-tenant). The isolation invariant is the same everywhere: **every tenant-scoped row
carries `org_id`, and every query filters on it.**

**Solo ↔ team ↔ org, resolved by `org_id` + `visibility`:**

| Context | `org_id` | `visibility` | Who sees it |
|---|---|---|---|
| Solo private work | user's **personal org** | `private` | only the user |
| A member's private work inside an org | the **shared org** | `private` | only the user |
| Work shared with the team | the **shared org** | `org` | every member of that org |

- Every user always has a **personal org** (`org_personal_<userId>`, plan `single`) — the local-first,
  no-permission-wall path. Solo memory/persona lives here.
- Joining a team/enterprise org adds a membership. The user's private memory in that org stays theirs
  (`visibility=private`); shared memory (`visibility=org`) is visible to all members.
- The **active org** is chosen by the `X-BrainRouter-Org` header (fallback: `users.default_org_id`).
  A user acting "on their own" simply has no/personal active org.

**Persona follows the same rule.** `core_identity` gains `(org_id, visibility)`:

- personal persona = `(user_id, org_id=personal, visibility=private)` — distilled from the user's own memory;
- **org consensus persona** = `(org_id=shared, visibility=org)` — distilled from org-shared
  `instruction`/`persona` records (team SOPs, shared identity);
- injection in org context = personal persona **+** org overlay; cache key becomes `(userId, orgId)`.

This directly answers "how are memory/persona organized when a user is solo *and* in a team": they are
**never merged across orgs** — `org_id` partitions them, `visibility` decides sharing within an org.

## Model refinement — Team-centric (the "clean" model)

The tenancy unit is **the Team**. A user joins one or more Teams; a Team owns its members, RBAC,
memory, persona, artifacts, projects/repos, invitations, and domain allowlist. The **plan attaches to
the Team** and controls what it may use. Solo work is just a Team of one (the personal Team).

**Mapping to the code:** the existing `organizations` row **is** the Team — it already owns members
(`org_members`), memory (`cognitive_records.org_id`), providers, integrations, and RBAC. We keep the
internal key `org_id` (a rename to `team_id` would be a large, value-free migration and would ripple
through every scoped query); "Team" is the product/UX name for the same unit. A deeper *teams-within-a-
team* hierarchy (org > team > project) remains an optional later layer — the flat model ships first.

```
User ──joins──▶ Team (= organizations row, keyed by org_id)
                 └─ owns: members + RBAC, memory, persona, artifacts, projects/repos, invites, allowed_domains
Team.plan ──gates──▶ what the Team may use  (free | pro | team | enterprise | self_hosted_enterprise)
```

## Decision — plan entitlements (the gate)

Plans stop being labels and become an **entitlement matrix** (single source of truth in
`brainrouter/src/tenancy/entitlements.ts`):

| Feature / limit | free | pro | team | enterprise | self-hosted ent. |
|---|---|---|---|---|---|
| Seats (members) | 1 | 1 | 10 | ∞ | ∞ |
| Projects / repos | 3 | 25 | 50 | ∞ | ∞ |
| Shared team memory | ✗ | ✗ | ✓ | ✓ | ✓ |
| Team consensus persona | ✗ | ✗ | ✓ | ✓ | ✓ |
| Email invitations | ✗ | ✗ | ✓ | ✓ | ✓ |
| Hosted MCP access | ✗ | ✓ | ✓ | ✓ | ✓ |
| Advanced connectors | ✗ | ✓ | ✓ | ✓ | ✓ |
| Team-owned GitHub App | ✗ | ✗ | ✓ | ✓ | ✓ |
| Restricted (per-member) projects | ✗ | ✗ | ✗ | ✓ | ✓ |
| Email-domain allowlist | ✗ | ✗ | ✗ | ✓ | ✓ |
| SSO realm | ✗ | ✗ | ✗ | ✓ | ✓ |
| Audit logs | ✗ | ✗ | ✗ | ✓ | ✓ |

`free` is the solo/local-first default (the pre-ADR-014 `single` tier — migration `010` backfills it and
`normalizeOrgPlan` maps any stray legacy value). An `EntitlementChecker` + `requireFeature(feature)` /
seat-limit middleware gate the relevant routes. "Only certain repos for team/enterprise" = the
**projects limit** + the **restricted-projects** feature. Values are defaults; they live in code so a
self-host operator can fork them.

## Decision — the phased program

Delivered as independent, CI-green phases. Each ships behind the existing DB-only / settings-not-.env
rules; no new `BRAINROUTER_*` provider vars; LLM-output JSON via `memory/util/llm-json.ts`; models from
`/models`. Migrations start at `010`.

### Phase A — Foundations & isolation hardening
- Lift `CognitiveRecord` (packages/types) to include `org_id?` + `visibility?` (schema already has them).
- `entitlements.ts` (matrix + checker) + `requireFeature` / seat-limit middleware.
- Confirm/annotate the org-isolation invariant (`org_id` in every tenant-scoped `WHERE`); add `org_id`
  to `active_sessions` to stop cross-org federation.
- **Answers:** plan-gated repos/seats groundwork.

### Phase B — Email + verification + invitations + domain allowlist
- `src/services/email/` — `IEmailService` + `SmtpEmailService` (nodemailer) + `NoopEmailService`;
  config in DB/settings (host/port/user/pass/from), **never `.env`**; owner-editable in the dashboard.
- `users.email_verified` + verification tokens (hash stored, raw emailed, single-use, 24h).
- `org_invites` (org_id, email, role, token-hash, expiry) + invite-by-email that **sends a link**;
  `/invite/:token` accept flow that provisions/joins the user (invitation-secret pattern).
- `organizations.allowed_domains` (enterprise) — gate invite + join to `@company.com`.
- Password reset. **Answers:** email service, invitations, enterprise domain allowlist.

### Phase C — Persona/memory tenancy
- `core_identity` gains `(org_id, visibility)`; persona cache keyed by `(userId, orgId)`.
- `distillOrgPersona(orgId)` over org-shared `instruction`/`persona` records; injection overlays
  personal + org persona with the active-org id attached.
- `MEMORY_SCOPING.md`. **Answers:** solo-vs-team-vs-org memory & persona.

### Phase D — Artifact sharing + MCP org tools
- Capture tools accept `visibility`; `org_id` threaded from request/MCP context.
- New MCP tools: `memory_share_to_org` (promote private→org, `memory:share` gated),
  `memory_org_browse` (list org-shared artifacts, not session-limited), `memory_org_recall`.
- Dashboard "Shared with org" panel + a visibility toggle on artifacts.
- **Answers:** sharing what you've worked on to a team/org, incl. via MCP.

### Phase E — Projects + per-project access control
- `workspaces` / `repos` / `projects` entities (backfill from tags) + `project_members(project_id,
  user_id, role)`; org members inherit access unless a project is **restricted** (enterprise).
- Plan-gated project/repo caps. Dashboard project admin.
- **Answers:** not everyone sees every project; plan-restricted repos.

### Phase F — Admin management console
- `GET /api/admin/orgs` (system-admin): every org, plan, seats-used/limit, projects, owner.
- Per-org drill-down + `org_audit_log` (member/plan/ownership changes).
- Dashboard "Admin → Organizations" surface. **Answers:** admin can view all created plans/orgs.

### Phase G — Hosting & deployment
- `deploy/tunnel/` Cloudflare-tunnel compose example; document `BRAINROUTER_SYSTEM_ORG_ID`.
- Client **health-check fallback**: prefer `localhost:3747` if healthy → configured tunnel URL → hosted;
  one `cli.brainUrl` knob, decision logged once. **Answers:** localhost / Cloudflare / hosted, one build.

## Consequences

- Large surface, but every phase is isolated and reversible; the isolation invariant is testable.
- Plan values are opinionated defaults in code — a self-host operator can change them without a schema
  change (they are not per-row).
- Email is optional: with `NoopEmailService` the system runs exactly as today (invite-by-existing-user);
  configuring SMTP unlocks verification/invitations/reset. No feature regresses when email is absent.
- Persona schema change is additive (`org_id` nullable = today's behaviour).
