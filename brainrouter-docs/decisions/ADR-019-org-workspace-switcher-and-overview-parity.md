# ADR-019 — App-wide organization/workspace switcher + Overview parity

- **Status:** Accepted (2026-07-17) — build **D1 first**, then D2.
- **Date:** 2026-07-17
- **Approved decisions:** (1) persistence = **hybrid** (localStorage + server default sync); (2) delivery = **D1 first**, D2 as a follow-up; (3) opt-outs = **Settings/Profile + org creation** stay account-level, everything else scopes to the switcher.
- **Supersedes (partially):** the per-page org selectors added in #879 (teams/meetings) — those become consumers of the global context.
- **Relates:** ADR-017 (org/team tenancy), ADR-014 (enterprise completion), ADR-018 (meetings).

## Context

The dashboard has **no single place to choose which organization you are working in**. Today:

- Every scoped page (`overview`, `repositories`, `meetings`, `issues`, `reviews`, `pentests`, `track`, `projects`, `chat`, `integrations`, `teams`) **independently** calls `adminApi.listOrgs()`, derives an active org (`find(isDefault) ?? orgs[0]`), and passes `orgId` per call to `authFetch` (`X-BrainRouter-Org`).
- A few pages (Teams; Meetings after #879) grew their **own per-page** org dropdown; most just silently use your **default** org — which for most users is the hidden **personal** workspace.
- Net effect (the user's words): *"we have to go through everything all in one place… it's harder to sort things out."* To work inside a real org like **KINQS** you either change your default or fiddle per page.

The backend already models this cleanly: `getDefaultOrgId` / `setDefaultOrg` (`POST /api/orgs/:orgId/default`) and the `X-BrainRouter-Org` header honored by `attachOrgContext` on every scoped route. **The plumbing exists; the UI never exposes one control that drives it.**

Separately, the current `/overview` ("Workspace overview") is functional but visually lighter than the reference security-dashboard styling the user wants to match — richer stat tiles, an issues-over-time chart, a severity donut, and a **"What's New in Cyber"** CVE feed (BrainRouter already has that data at `/vulnerabilities`).

## Decision

Two coupled changes, delivered as an explicit, phased program.

### D1 — Global organization/workspace context + top-of-sidebar switcher

1. **`OrgWorkspaceProvider`** (new React context, mounted in `components/LayoutWrapper.tsx` above every page): loads the caller's orgs once, holds the **active org**, and exposes `{ orgs, activeOrg, activeOrgId, setActiveOrg, refreshOrgs }`. A `useActiveOrg()` hook is the single read point.
2. **Workspace switcher at the TOP of the sidebar** (replacing the logo-only `sidebar-org-row`): shows the active org's avatar + name + a chevron; the dropdown lists every org (name, your role, "Personal workspace" label on the personal org), a check on the active one, and a **"Create workspace"** action (existing create-org flow). Matches the reference `KINQS ⌄` switcher.
3. **Persistence (hybrid):** the active org is stored in `localStorage` for instant restore **and** synced to the server default via `POST /api/orgs/:orgId/default` so desktop/CLI/other browser sessions agree. On load: `active = local ?? server default ?? first`. If the persisted org is one you're no longer a member of → fall back to default/personal.
4. **Every scoped page reads `activeOrgId` from the context** and passes it to `authFetch`, replacing per-page `listOrgs()`+derive. **One selection scopes the whole app** — repositories, meetings, issues, PR reviews, pentests, track, projects, knowledge, etc.
5. The per-page selectors from #879 are **subsumed**: Teams and Meetings consume the global context instead of resolving their own. The inline *"Create team in &lt;org&gt;"* / meeting share-target picker **stays** (it targets a team within the active org — a share choice, not a context switch). Personal workspace remains one switchable context.

### D2 — Overview parity with the reference dashboard

Rebuild `/overview` into a richer landing, scoped to the active org from D1:

- A `"Good morning, <name>"` header with a range control (e.g. Last 30 days).
- **Stat tiles**: open issues, PRs reviewed, security posture/score, new items — using existing review/issue data.
- **Charts** (via the repo's `dataviz` system + monochrome tokens): an **issues-over-time** area chart (by severity) and an **open-issues-by-severity** donut.
- A **"What's New in Cyber"** panel surfacing the newest CVE detections already available on `/vulnerabilities` (title, severity, CVSS, "today"), with a subtle globe/marker accent.
- Styling adopts the reference's card/spacing/chart rhythm **within BrainRouter's existing monochrome design tokens** — no new design language; charts use the `dataviz` palette.

## Scope / phasing

- **Phase 1 — context + switcher (the core ask):** `OrgWorkspaceProvider`, the sidebar switcher, persistence, and wire the highest-traffic pages (`overview`, `repositories`, `meetings`, `issues`, `reviews`) to it.
- **Phase 2 — full migration:** move the remaining scoped pages onto the context; delete per-page org derivation; retire the #879 per-page selectors.
- **Phase 3 — Overview redesign (D2)** + "What's New in Cyber".

Each phase is its own PR (into `release/0.4.17`), passing CI + the security-review bot.

## Consequences

- **+** One obvious control switches the whole workspace; every surface follows a single selection.
- **+** Removes duplicated per-page org resolution; the meetings/teams selectors stop being special cases.
- **+** Server-synced default means desktop/CLI/other sessions agree on "where am I working."
- **−** Every scoped page must consume the context (touches many files) — mitigated by phasing.
- **−** Behavior change: pages that today silently show your *default* org will now follow the switcher; a couple of surfaces are intentionally **cross-org / account-level** and must **opt out** (see open questions).
- **Edge:** active org you were removed from → graceful fallback; switching org must reset per-page selection/detail state (as the meetings page already does on org change).

## Alternatives considered

- **Keep per-page selectors (status quo):** rejected — it *is* the pain cited.
- **URL-param org (`/o/:orgId/...`):** shareable/bookmarkable but a large routing change; a context + the existing `X-BrainRouter-Org` header is lighter and matches today's model. (Could layer URL sync on later.)
- **Server-session active org only (no local):** slower first paint / an extra round-trip before anything renders; the local + server-default hybrid is snappier and still cross-device-consistent.

## Open questions (please confirm on approval)

1. **Persistence:** persist the active org as the **server default** (affects desktop + CLI too) — or dashboard-**local only**? (Recommended: hybrid, server-synced.)
2. **Delivery:** D1 + D2 in **one PR**, or **D1 first** (switcher) then **D2** (Overview redesign) as a follow-up? (Recommended: D1 first — it's the functional ask — then D2.)
3. **Opt-outs:** any surfaces that must stay **cross-org / account-level** and ignore the switcher — e.g. account Settings/Profile, the org-management/Teams admin list, billing? (Recommended: Settings/Profile + org creation stay account-level; everything else scopes.)
