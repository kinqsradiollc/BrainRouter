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

## Checklist

### P0 — Safe, small bug fixes (do first)
- [~] D1a: **one of the two duplicate install links removed** (ConnectorSettings OAuth-account copy). Owner/Repository field removal is coupled to D1b (killing the throw) → done together in P1.
- [ ] D1b: kill *"owner is required"* (`githubConnector.ts:93,131,165`) — connector run + Track resolve owner automatically; local-only project ⇒ no-op not error. → **P1** (needs installation-repo enumeration).
- [x] D2: **desktop registers + 30s-heartbeats an `active_sessions` row** for the signed-in user (`electron/host/brainSession.ts`, wired at startup `host.ts` + sign-in/out `queries.ts`). Account page reads it. *(needs desktop relaunch to take effect.)*
- [x] **§3.1 RBAC — removed the client-side `user.isAdmin` redirects** in dashboard `providers/page.tsx` + `integrations/page.tsx` (the real "can't configure org memory repo" blocker; backend already org-scoped). tsc-clean.
- [ ] D3: compute + plumb `workspace_tag`/`project_tag` on capture — **10-file critical-path plumb** (EmitContext + CLI/desktop builders → `memory_capture_turn` schema → `capture` → `captureTurn` → `extractPendingSensory` → extractor `cognitive-extractor.ts:183` sets `record.workspaceTag`/`projectTag` via `workspaceTagFromPath`/`projectTagFromName`). All-or-nothing through the memory hot-path → do as its own tested PR, not a tail-end edit. + Option-A backfill (join `active_sessions.workspace_root`, idempotent Node script).

### P1 — Fully-automatic OAuth sync
- [ ] Connector index run enumerates installation repos via the broker (no manual repo list).
- [ ] Track sync repo fully auto (installations + git-remote match); personal-no-repo edge case verified.
- [ ] Remove dead manual-repo code paths; migrate legacy configs.

### P2 — Tenancy + RBAC
- [ ] Fix the org-config 403: org owner/manager gate (not global-admin-only) on memory-repo / App / projects.
- [ ] Recall scope filter + a Personal·Team·Org scope switcher (API + dashboard).
- [ ] Memory rows correctly scoped (org_id + visibility + tags) end-to-end.

### P3 — Dashboard org/team redesign  (design skill)
- [ ] Org/team setup wizard (create/join → members+roles → link projects/repos → memory config).
- [ ] Personal / Team / Org memory views; shareable + manageable projects (who, what, role).
- [ ] Owner/manager-only controls enforced in UI + API.

### P4 — PR-security-review bot
- [x] **Reviewer "brain"** — `packages/core/src/review/securityReview.ts`: 24-class vuln taxonomy + `buildSecurityReviewContract()` (reuses `REVIEW_OUTPUT_CONTRACT` so `parseReviewFindings` consumes it) + idempotent `formatSecurityReviewComment()` (stable marker, severity sort, blocking count, findings cap, "no issues" path). Exported + 5 unit tests green.
- [ ] Webhook route + `X-Hub-Signature-256` verify (App webhook secret).
- [ ] `pr-security-review` backend role/job: PR checkout → reviewer (security lens) → adversarial verify → post-back.
- [ ] Configure the GitHub App webhook (events: `pull_request`, `issue_comment`; URL + secret) — Chrome, same App.
- [ ] Idempotent PR comment; least-privilege installation token; network-denied reviewer; "no issues" path.

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
