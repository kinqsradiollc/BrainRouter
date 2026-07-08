# ADR-017 — Production Flows: Auto-OAuth Sync, Tenanted Memory, and the PR-Security Bot

**Status:** Proposed (design; phased) · **Extends** ADR-016 (server-side connectors + desktop backend
client), ADR-010 (tenancy/RBAC), ADR-009 (trigger ingress + GitHub App), ADR-015 (repo linking + local
sync). **No commits merged until each phase is green.** Verify backend via `tsc` + `build` + `vitest`
(no local Postgres) and curl against the running dev backend; desktop/CLI via `tsc` + `build`.

> Section markers `⟨audit⟩` are finalized from the parallel flow audit (workflow `brainrouter-prod-flow-audit`).

## Context

The GitHub App is now unified (ADR-016 C2): one App (`brainrouter-memory-…`, device-flow, installations)
brokers per-user OAuth server-side, and Track sync proxies GitHub through the sealed token. Dogfooding
surfaced that the product is **not yet production-grade** across four axes — automation, sessions,
tenancy, and the bot:

1. **Sync is not automatic.** The connector/Track configure still asks for a manual `owner` and
   `repository`, and the connector run throws *"GitHub connector owner is required"*. Two redundant
   links ("Install on more repositories ↗", "Manage which repositories the app can access ↗") ask the
   user to do what OAuth should do automatically.
2. **Sessions are invisible.** A signed-in desktop shows **no active sessions** on the Account page —
   the client never registers/heartbeats an `active_sessions` row tied to the signed-in user.
3. **Tenancy is half-wired.** In the dashboard, a user **cannot configure the memory repo for their
   org** (the config is gated to a *global* admin, not the org **owner/manager**). Org/team setup and
   the personal/team/org **memory views** need a full redesign. `workspace_tag` / `project_tag` land
   **null**, so per-repo / per-workspace scoping and recall filtering silently degrade.
4. **The bot doesn't act.** The App can post back (ADR-009 Phase 1), but there is no automatic
   **security review** on a PR / `@mention`. We want the bot to review PRs like a security engineer
   (strix-style breadth) and comment, driven by a backend role — not a human trigger.

Edge cases that must be first-class: a **personal project with no GitHub remote** (memory must work
with no repo/sync), and **team/org sharing** (a project's memory is shareable + manageable — which
project, by whom, at what visibility).

## Decision

Make every sync **automatic over OAuth**, make **sessions + tags** correct end-to-end, promote tenancy
to **production-grade RBAC** (org owner/manager configures; personal/team/org memory is scoped and
viewable), and add a **backend PR-security-review role** the GitHub App drives automatically. One App,
one broker, one memory plane — no manual repo/owner anywhere.

### D1 — Fully-automatic OAuth repo flow  ⟨audit⟩
- Remove the manual **Owner / organization** field (`ConnectorSettings.tsx:359-361`) and **de-duplicate**
  the install link that renders **twice** — "Manage which repositories the app can access ↗"
  (`:363-367`) and "Install on more repositories ↗" (`:412-416`) are the same `githubInstallUrl`. Keep a
  single "Manage on GitHub" affordance — installation is the *only* step GitHub requires a human for.
- **Audit asset (missed by CONNECTOR map):** installation enumeration is **already built** on the backend:
  `GET /api/orgs/:orgId/github/repos` mints an installation token and calls `GET
  /installation/repositories` (`tenancy/githubRepos.ts:88-125`); `autoResolveInstallationId` probes
  `GET /app/installations` (`:21-31`). **Reuse this**, not a new `/user/installations` desktop client.
- **Git-remote match is already built:** `resolveWorkspaceGit(root)` returns `repoIdentity`
  (`normalizeRepoUrl`) + `repoTag` from the workspace remote (`git/workspaceGit.ts:85-105`, tested
  `workspace-git.test.ts:73`). Track sync resolves the connector repo by matching this against the
  installation-repo list — no manual `owner`/`repository`.
- Kill the three *"owner is required"* throws (`githubConnector.ts:93,131,165`): derive owner from the
  installation/remote; if genuinely unresolvable and there is no remote, treat it as a **local-only
  personal project** — memory-index every accessible installation repo (or none), and sync is a **no-op,
  not an error**.
- **CLI/agent caveat (map is right):** the CLI/agent token client (`runCheckpoint.ts` static-token path)
  has **no keychain/broker access** and cannot auto-enumerate. It keeps an explicit `owner` OR routes
  through the same backend `/api/orgs/:orgId/github/repos` endpoint. Do not regress this to a hard throw.

### D2 — Sessions register + heartbeat  ⟨audit⟩
- **Root cause (confirmed):** desktop never calls `session_register` — `attachFederation` lives only in
  `brainrouter-cli/src/runtime/federation/federationRegistration.ts:102`, and the desktop host has **zero**
  federation/`session_register` references. `GET /api/sessions` then returns empty for the signed-in user.
- The desktop registers + heartbeats (~30s) an `active_sessions` row via `session_register` /
  `session_heartbeat` over the http MCP transport. **Prefer Option A (full `attachFederation` reuse)** — it
  gives heartbeat + re-register-on-sweep for free (the 2-min staleness window otherwise drops the row).
- **Gap to resolve first:** `attachFederation`/`resolveFederationSessionKey` are **not exported from
  `@kinqs/brainrouter-core`** (they live in the CLI package). Either (a) lift the federation lifecycle into
  `packages/core` and export a barrel, or (b) the desktop calls `session_register`/`session_heartbeat`
  directly (one-shot + its own 30s timer). The SESSIONS map's "just import from core/federation" is
  **wrong today** — the barrel does not exist.

### D3 — `workspace_tag` / `project_tag` correctness  ⟨audit⟩
- Compute the tags at **capture** time (`repoTag` from the workspace remote; a stable workspace tag)
  and **plumb them through** the MCP `memory_*` path → upsert, so `source_documents` /
  `cognitive_records` are scoped. Backfill existing null rows where the workspace is known.

### D4 — Tenanted memory + RBAC redesign  ⟨audit⟩
- **RBAC (audit correction):** the DASHBOARD map's premise is only *partly* true. `/api/admin/providers`
  and `/api/admin/integrations` are **already** org-scoped — both `router.use(requireAnyAuth,
  requirePermission(...))` (`admin/providers.ts:19`, `admin/integrations.ts:17`), and `requirePermission`
  passes org owners via `can(role, cap)` while global admins bypass (`middleware/tenancy.ts`). The **only**
  genuinely global-admin-locked endpoint is the *legacy* DB OAuth-App creds at
  `connectors/github.ts:279-285` (`if (!req.isAdmin) 403`). The org-owned App path already lives at the
  org-scoped `/api/orgs/:orgId/github/*` router (`tenancy/githubRepos.ts`, mounted `index.ts:220`) and is
  gated by `triggers:manage`. **So the fix is not "open the global endpoint to org owners" — it is
  (a) point the dashboard at the org-scoped routes, and (b) remove the client-side `user.isAdmin`
  redirects** in `providers/page.tsx` / `integrations/page.tsx` that hide already-authorized pages.
- Real 403 to close: keep `/api/admin/connectors/github/app` global-admin-only (deployment fallback), and
  make the dashboard's org-memory-repo config call the org-scoped `/api/orgs/:orgId/github/*` +
  `/api/orgs/:orgId/integrations` surfaces instead.
- **Memory scope model:** rows carry `org_id` + `visibility` (personal / team / org) + `workspace_tag`
  + `project_tag`. Recall filters by the caller's scope; a **scope switcher** (Personal · Team · Org)
  drives what memory is shown.
- **Dashboard redesign:** a coherent org/team **setup wizard** (create/join org → add members with
  roles → link projects/repos → configure memory) and **memory views** split by scope. Teams are
  **shareable + manageable**: a project's memory can be shared to a team/org, and an owner/manager can
  see/change who has access and at what role.
- **Personal-no-repo edge case:** a personal project with no remote lives in the user's personal org at
  `visibility=personal`, `project_tag` from a stable local id; fully functional, never blocked on a repo.

### D5 — GitHub App PR-security-review bot  ⟨audit⟩
- **Reuse:** the App **installation token** (`githubApp.ts` JWT + token cache), the tool-aware
  **read-only reviewer** agent (the code-review system), and the **`memory_jobs`** runner.
- **New:**
  - A **webhook route** `POST /api/github/webhook` verifying `X-Hub-Signature-256` (HMAC-SHA256 with
    the App webhook secret) for `pull_request` (opened/synchronize) and `issue_comment` (`@brainrouter
    review` mention).
  - A backend **`pr-security-review` role/job**: check out the PR (isolated worktree), run the reviewer
    agent with a **security lens** (our own vuln taxonomy — injection/SSRF/SSTI/XXE/RCE/IDOR/CSRF/
    path-traversal/insecure-deser/proto-pollution/mass-assignment/authz-JWT/secrets/prompt-injection),
    produce structured findings (title · severity · CWE · file:line · why/repro · remediation ·
    confidence), and **post a PR review** via the installation token. Findings are adversarially
    verified before posting (no false-positive spam); the reviewer is **network-denied** except the
    repo it checked out.
  - **Safety:** installation-scoped least privilege; never echo secrets; comment is idempotent
    (update-in-place per PR head SHA); a hard cap on findings + a "no issues found" path.

- **⟨2026-07-08 as-built⟩ Single-shot diff review + inline `suggestion` comments.** The shipped bot
  (`prSecurityReview.ts`) runs a **single LLM turn over the PR's unified diff** — no checkout, no
  filesystem tools. The reviewer contract is therefore **self-contained and diff-focused**
  (`buildSecurityReviewContract`); it must **not** instruct the model to "verify with read-only tools"
  it doesn't have, or a compliant model suppresses every finding as "unverifiable" (the bug that made
  the first live run report a clean bill on a diff full of injection). Output shape now matches a
  human PR review:
  - A **grouped PR review** (`POST /pulls/{n}/reviews`, `event: COMMENT`) whose body tallies the new
    findings and points at the pinned summary.
  - One **inline review comment per finding**, anchored to the exact new-file line(s) — `addedLinesByPath`
    parses the diff so a bad anchor can never 422 the whole review; `resolveInlineAnchor` decides the
    range and whether a suggestion is safe. Each carries a severity·CWE header, impact, a **GitHub
    ```suggestion block** (one-click *Apply suggestion*, from the finding's `replacement`), a collapsed
    "prompt to fix with AI", and a resolve/tune footer.
  - The **pinned summary** issue-comment (marker-keyed, idempotent) stays as the whole-PR status.
  - **Idempotency across pushes:** each inline comment embeds a per-finding marker (`brs-finding:…`);
    a re-run skips findings already surfaced, so the review says "N **new** findings" instead of
    stacking. Grouped-review 422 falls back to posting comments individually.

- **⟨2026-07-08 as-built⟩ Multi-LENS reviews + gating check-runs + full CI (Strix parity → superset).**
  The bot is no longer security-only. The security path was refactored into a **lens abstraction**
  (`review/reviewLens.ts` — one parameterized `runPrReview(input, deps, lens)` + shared renderers), so a
  new review kind is a *data object*, not a copy of the executor. Two lenses ship, each fanning out from
  one `pull_request` webhook as its own job:
  - **Security lens** (`SECURITY_LENS`, `buildSecurityReviewContract`) — the vulnerability taxonomy.
  - **Code-review lens** (`CODE_REVIEW_LENS`, `buildCodeReviewContract`) — the repo's own five-axis
    `code-review-and-quality` framework, scoped to the four NON-security axes (correctness, readability,
    architecture, performance) + test coverage; it explicitly DEFERS security to the security lens so the
    two never double-report. Distinct markers (`brs-finding` / `brc-finding`, `brainrouter-security-review`
    / `brainrouter-code-review`) keep the two from clobbering each other's comments or dedup.
  - **Gating check-run per lens** (`POST /repos/{repo}/check-runs`, named `BrainRouter security review` /
    `BrainRouter code review`): `blocking` (critical/high, not pre-existing) ⇒ `failure`; findings but none
    blocking ⇒ `neutral`; clean ⇒ `success`. Needs the App's **`checks: write`**; degrades to a no-op
    (review + comments still post) without it. Branch protection can then REQUIRE these checks.
  - **Deterministic CI** (`.github/workflows/ci.yml`) adds two jobs beside build+test: **Lint & Typecheck**
    and **Security Audit (deps)** (reports high/moderate; blocks only on `--audit-level=critical`, since a
    high-severity gate would be a permanent red X on unfixable transitive advisories). Ephemeral worktrees
    (`.worktrees/**`, `.claude/worktrees/**`) are eslint-ignored so agent-fleet checkouts don't break lint.
    Together with the bot's two check-runs, a PR must pass: Build & Test · Lint & Typecheck · Security Audit
    · BrainRouter security review · BrainRouter code review.
  - Tests: core review 13, backend executor 13 (+ webhook 10, executor-inventory 7) — all green.

- **⟨2026-07-08 as-built⟩ Check-runs LIVE + on-demand re-run + linked-repo gating.**
  - **Checks: write** accepted on the installation → both check-runs post & gate live (verified on the
    test PR: `BrainRouter security review` + `BrainRouter code review`, each with GitHub's native Re-run,
    grouped under the App in the PR Checks tab). Branch protection can now require the 5 checks.
  - **On-demand re-run:** a `/review` (or `@brainrouter review`) PR comment re-triggers both lenses via the
    `issue_comment` webhook; the executor resolves the head SHA from the PR when the comment carries none.
    The summary comment now shows a Strix-style **Re-run / Manage** action row (`REVIEW_ACTION_FOOTER`).
  - **Linked-repo gating:** the bot reviews ONLY repos in the org's `github_app` integration
    `config.linkedRepositories` allowlist (`isRepoLinkedForReview`) — like the rest of BrainRouter's per-repo
    scoping. Back-compat default: field ABSENT → review all (don't silently stop a working bot); PRESENT →
    only listed repos. The allowlist is set from the dashboard (reuses the admin-integration PATCH).
  - **Bot login:** `brainrouter[bot]` (and `brainrouter-memory[bot]`) is RESERVED by GitHub for the
    `@brainrouter` account; this org-owned App can't take it. The check-run *titles* already read cleanly
    ("BrainRouter security review"). Getting `brainrouter[bot]` requires owning the App under `@brainrouter`.

### D6 — RBAC roles + tenanted resource hierarchy  ⟨2026-07-08 correction⟩

**Bug this corrects.** ADR-017 §3 (merged in #812) removed the client-side `isAdmin` redirect on
`/integrations` wholesale. That over-corrected: the page *also* hosts the **deployment-level** "GitHub
OAuth App" credential card, which is *correctly* global-admin-only (`connectors/github.ts`
`if (!req.isAdmin) 403`). A normal user now sees that card and hits repeated 403s. The right model is
**per-section gating**, not "whole page open" nor "whole page admin-only":
- **Deployment admin** (global `isAdmin`) configures the ONE shared GitHub **App credentials** — or, with
  the unified broker, they are **bundled via env** and the card is legacy/hidden.
- **Org Owner/Admin** links which **repositories** the org syncs to memory.
- **Any member (Developer+)** can **Connect GitHub** (device flow) and use the shared App.
- **Viewer** sees linked repos + memory read-only; no configuration.
- The dashboard must **hide/disable** controls the caller can't use and show an "ask an org admin" state
  — never render an admin-only form to a normal user and let it 403.

**Canonical resource + role hierarchy (target model — from the product spec):**
```
User
 ├─ Private Memory · Private Persona · Personal Sessions
 └─ Team Memberships → Role per Team

Team (= Org)
 ├─ Members → Owner · Admin · Developer · Viewer
 ├─ Team Memory · Persona · Artifacts
 ├─ Projects → Repositories · Project Memory · Persona · Artifacts · Project Access Control
 ├─ RBAC · Invitations · Domain Allowlist
 └─ Enterprise Plan

Enterprise Plan
 └─ Member/Project limits · Shared Memory/Artifacts · Team Persona · Hosted MCP · Advanced Connectors
    · Audit Logs · Admin Controls · Domain Allowlisting · Support / SLA
```

**Role → capability matrix (replaces the current owner/manager/member trio):**

| Capability | Owner | Admin | Developer | Viewer |
|---|:-:|:-:|:-:|:-:|
| Billing / plan / delete org | ✓ | | | |
| Manage admins · transfer ownership | ✓ | | | |
| Configure org GitHub App + linked repos · connectors · domain allowlist | ✓ | ✓ | | |
| Manage members (invite/remove; set role ≤ Developer) | ✓ | ✓ | | |
| Create/manage projects + project access control | ✓ | ✓ | ✓\* | |
| Connect GitHub (device flow) · use connectors | ✓ | ✓ | ✓ | |
| Read/write own + team/project memory (per project ACL) | ✓ | ✓ | ✓ | |
| Read team/project memory + artifacts | ✓ | ✓ | ✓ | ✓ |

`\*` Developers manage only the projects they own or were granted. **Deployment-level App credentials stay
global-admin-only** (or bundled). A personal-org owner is always Owner of their own scope. Legacy mapping:
`manager → admin`, `member → developer`.

## Checklist

### P0 — Safe, small bug fixes (do first)
- [~] D1a: **one of the two duplicate install links removed** (ConnectorSettings OAuth-account copy). Owner/Repository field removal is coupled to D1b (killing the throw) → done together in P1.
- [ ] D1b: kill *"owner is required"* (`githubConnector.ts:93,131,165`) — connector run + Track resolve owner automatically; local-only project ⇒ no-op not error. → **P1** (needs installation-repo enumeration).
- [x] D2: **desktop registers + 30s-heartbeats an `active_sessions` row** for the signed-in user (`electron/host/brainSession.ts`, wired at startup `host.ts` + sign-in/out `queries.ts`). Account page reads it. *(needs desktop relaunch to take effect.)*
- [x] **§3.1 RBAC — removed the client-side `user.isAdmin` redirects** in dashboard `providers/page.tsx` + `integrations/page.tsx` (the real "can't configure org memory repo" blocker; backend already org-scoped). tsc-clean.
- [ ] D3: compute + plumb `workspace_tag`/`project_tag` on capture — **10-file critical-path plumb** (EmitContext + CLI/desktop builders → `memory_capture_turn` schema → `capture` → `captureTurn` → `extractPendingSensory` → extractor `cognitive-extractor.ts:183` sets `record.workspaceTag`/`projectTag` via `workspaceTagFromPath`/`projectTagFromName`). All-or-nothing through the memory hot-path → do as its own tested PR, not a tail-end edit. + Option-A backfill (join `active_sessions.workspace_root`, idempotent Node script).

### P1 — Fully-automatic OAuth sync
- [x] **Connector index run enumerates installation repos via the broker** (`canResolveRepositories` guard; desktop `listAccessibleRepositories` → `GET /api/connectors/github/repos`). No hard "owner required" for OAuth; static/CLI path preserved. Owner field removed from the UI. **Merged (#814).**
- [x] **Track sync repo fully auto** (git-remote match, done earlier) + connector auto-enumeration. Personal-no-repo → no-op.
- [ ] Remove remaining dead manual-repo code paths; migrate legacy configs (follow-up).

### P2 — Tenancy + RBAC
- [ ] Fix the org-config 403: org owner/manager gate (not global-admin-only) on memory-repo / App / projects.
- [ ] Recall scope filter + a Personal·Team·Org scope switcher (API + dashboard).
- [ ] Memory rows correctly scoped (org_id + visibility + tags) end-to-end.

### P2.5 — RBAC rebuild (D6 — roles + per-section gating)
- [ ] Expand roles `owner/manager/member` → **`owner/admin/developer/viewer`**; update `capabilitiesFor()` + `ROLE_CAPABILITIES` + tenancy queries/migration (map `manager→admin`, `member→developer`).
- [ ] `/integrations` **per-section gating**: deployment App-credential card = global admin (or hidden when bundled); org GitHub App + repos = owner/admin; connect/use = developer+. **Kills the 403 spam.**
- [ ] Backend `requirePermission` honors the 4 roles; personal-org owner passes for their own scope.
- [ ] Dashboard hides/disables controls by the caller's org role (not global `isAdmin`); shows "ask an org admin" instead of raw 403s.
- [ ] Project Access Control: per-project role grants (Developer scoping) — schema + enforcement.

### P3 — Dashboard org/team redesign  (design skill)
- [ ] Org/team setup wizard (create/join → members+roles → link projects/repos → memory config).
- [ ] Personal / Team / Org memory views; shareable + manageable projects (who, what, role).
- [ ] Owner/manager-only controls enforced in UI + API.

### P4 — PR-security-review bot
- [x] **Reviewer "brain"** — `packages/core/src/review/securityReview.ts`: 24-class vuln taxonomy + `buildSecurityReviewContract()` (self-contained, diff-focused — NOT the tool-using `REVIEW_OUTPUT_CONTRACT`) + `formatSecurityReviewComment()` pinned summary + `formatInlineFinding()`/`buildReviewIntro()`/`inlineFindingMarker()` for inline comments. Exported + unit tests green (12).
- [x] Webhook route + `X-Hub-Signature-256` verify (`integrations/githubWebhook.ts`; enqueues `pr-security-review` on `pull_request` opened/synchronize/reopened).
- [x] `pr-security-review` backend executor (`integrations/prSecurityReview.ts`): installation token → fetch PR diff → single-shot security review → **grouped PR review with inline `suggestion` comments** + idempotent pinned summary. DI'd + 7 unit tests green.
- [x] GitHub App configured live (App `4237068`, installation `145021499`): Pull-requests + Issues R/W accepted, `pull_request`+`issue_comment` events, webhook URL+secret — verified end-to-end on a test PR (3 findings, applyable suggestions).
- [x] Idempotent post-back (marker-keyed summary + per-finding `brs-finding` dedup across pushes); least-privilege installation token; "no issues" path; grouped-review 422 → per-comment fallback.
- [ ] Adversarial verify pass before posting (single-shot bot posts directly today; verification pass is a follow-up).
- [ ] `@mention` review trigger via `issue_comment` (event subscribed; executor path TBD).

## Risks & mitigations
- **Auth changes can lock users out** → no `token_version`/JWT-middleware changes ship untested; reuse existing tested primitives (`rotate-key`, `requireAnyAuth`, installation tokens).
- **Webhook = public attack surface** → strict HMAC verify, event allowlist, installation-scoped tokens, no secret echo, reviewer network-denied.
- **False-positive PR spam** → adversarial verification + confidence threshold + findings cap + idempotent update-in-place.
- **Disk pressure (~98% full)** → no mass worktree fan-out; the review job uses one isolated worktree, cleaned up.
- **Tag backfill** → idempotent, workspace-known rows only; never guess a repo.

## Rollout
Sequential PRs into `release/0.4.17` (or a dedicated `feat/prod-flows` branch), one checklist group per PR,
each `tsc`+`build`+`vitest`-green and curl-verified. The GitHub App webhook is configured last, once the
route + job are green, so the bot only starts acting when the backend can handle it.
