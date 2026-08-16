# ADR-015 — GitHub Repository Linking: Authorization Across Plans + Local-First Sync

**Status:** Partially implemented (verified 2026-08-16: P0/P1a/P1b/P2/P4 shipped — including `repoUrl` finally consumed; pending: P1c repoTag-scoped capture and the P3 desktop repo-linking surface; §D1 superseded by ADR-016 and P5 delivered by ADR-017's unified GitHub App; note `ingestRepoFiles` currently has no production caller) · **Extends** ADR-009 (trigger-ingress
GitHub App), ADR-010 (multi-tenancy), ADR-014 (projects / repos). **Does not commit** until the
program below is agreed and each phase is verified.

## Context — what actually exists today (grounded audit)

Three independent read-only investigations of `brainrouter/`, `packages/core/`, and
`brainrouter-desktop/` established the following. **The headline: "link a repo to memory" is
cosmetic everywhere, and the desktop + cloud are two disconnected worlds.**

### 1. Cloud (dashboard → backend) is org-scoped, Team/Enterprise-only, and BYO-App
- Dashboard calls the backend HTTP API → Postgres `integration_configs` (org-scoped GitHub App:
  `appId`/`appSlug`/`installationId` + sealed `privateKey`). See
  `brainrouter/src/api/routes/admin/integrations.ts`, `.../tenancy/githubRepos.ts`.
- The **only** model is **bring-your-own GitHub App**: an org admin creates an App on github.com,
  uploads the private key, installs it. There is **no hosted/OAuth "Connect GitHub" flow**, no
  `client_secret`, no shared App.
- Gated by the `githubApp` entitlement (`brainrouter/src/tenancy/entitlements.ts`): free/pro plans
  **403**; only Team/Enterprise can configure it.

### 2. Desktop already has the personal "authorize" mechanism — buried as a "connector"
- Desktop **never touches the backend HTTP API.** It is Electron IPC → local `config.json`, **no org
  model**, user is implicitly admin. (`brainrouter-desktop/electron/host/queries.ts`, `src/settings.tsx`.)
- Desktop's **GitHub connector** already supports three credential modes — **static PAT**, **OAuth
  device flow** (`brainrouter-desktop/electron/githubOauth.ts`, scope `repo read:org`, **no callback
  URL needed**), and **gh CLI** — plus a repo picker (`src/settings/github/GithubRepoPicker.tsx`) and
  an `includeFiles` config field. Tokens are stored in the OS keychain.
- This device-flow connector **is** the personal/local authorize surface the product was "missing" —
  it just isn't presented as "link repos to memory," and it isn't wired to the memory index.

### 3. Linking is cosmetic; the local match layer is missing (but the hooks exist)
- `Project.repoUrl` is **written but never read** anywhere (`grep` across all three trees). No clone,
  no ingest, no matching, no behavior.
- Track↔GitHub sync (`packages/core/src/track/githubSync/`) moves **issues/PRs only** — never file
  content. No connector ingests repo content into memory.
- Desktop resolves git root/branch/diffs (`resolveWorkspaceGit`, `electron/host.ts:247`) but
  **deliberately never reads the remote URL**.
- Memory sources are scoped by `workspaceTag` = **hash of the local path**, not repo identity
  (`packages/types/src/memory/source.ts`; `ingestSource()` at `brainrouter/src/memory/source/ingest.ts:23`).
- `ingestSource()` (`kind: file|transcript|tool_output`) exists and dedups by content hash — but
  **nothing scans a workspace's code into it**; only transcripts + tool output are captured.

## Decisions

**D1 — Authorization is per-plan best-fit, one concept / three backends.** We unify the *concept*
("Connect GitHub" + "Linked repositories") and the UX language, **not** the storage. Each plan uses
the mechanism that fits its deployment:

| Plan / deployment | Authorize surface | Mechanism | Storage |
|---|---|---|---|
| **Personal / free (desktop, local)** | Settings → GitHub | **OAuth device flow** or PAT or gh CLI (all exist) | OS keychain + local `config.json` |
| **Team / Enterprise (cloud)** | Integrations → GitHub | Org **App**, BYO (built in this session) | Postgres `integration_configs` |
| **Hosted multi-tenant** *(deferred, P5)* | Integrations → GitHub | **One shared BrainRouter App** + OAuth callback | Postgres, per-org installation |

Rationale: device flow needs no public callback → the only thing that works for `localhost`/desktop;
the org App is right for teams that want their own bot identity/audit; the hosted App is a pure UX
upgrade for cloud and is deferred to avoid standing up a callback host + client secret + multi-tenant
token store before the core value (repo↔memory) exists.

**D2 — Sync is local-first: match by git remote, ingest from the local checkout.** For the desktop
MCP the repo is already on disk, so file content comes from the **local checkout** (no auth needed for
files); the connector token is used only for *remote* repos and issues/PRs. Server-side remote pull is
deferred (P5).

**D3 — "Desktop parity" ≠ porting the App-key form.** The App-key/private-key form is the cloud/org
surface. Desktop parity means: surface the existing connector as a first-class **"link repos to
memory"** experience and build the **match + ingest** layer beneath it.

**D4 — Repo identity = normalized git remote URL.** The join key between "a linked repo" and "a local
checkout" (and between desktop and cloud `Project.repoUrl`) is the canonicalized remote URL:
lowercase host, strip trailing `.git`, unify `git@host:owner/repo` ↔ `https://host/owner/repo`. A
stable `repoTag = hash(normalizedRemoteUrl)` scopes memory by *repo*, surviving a moved/renamed folder
or a second clone — unlike today's path-hash `workspaceTag`.

## Architecture

```
                         ┌─────────────────────────── one concept ───────────────────────────┐
                         │  "Connect GitHub"  +  "Linked repositories"  +  repoTag identity   │
                         └───────────────┬───────────────────────────────┬───────────────────┘
   DESKTOP (local)                       │                               │        CLOUD (org)
   keychain + config.json   device-flow / PAT / gh                  org App (BYO)   integration_configs
        │                                                                                  │
        ▼                                                                                  ▼
   resolveWorkspaceGit + remote URL ── normalize ──► repoTag ──match──► Project.repoUrl (now consumed)
        │                                              │
        ▼                                              ▼
   local checkout files ── ingestSource(kind:file) ──► memory scoped by repoTag (+ projectId on cloud)
```

- **Shared foundation (core):** a `normalizeRepoUrl()` / `repoTag()` util in `packages/core` reused by
  desktop, CLI, and backend. Source records gain a `repoTag` (and, on cloud, `projectId`) alongside the
  existing `workspaceTag`.
- **Local match (desktop):** extend `resolveWorkspaceGit` to also read `git config --get
  remote.origin.url`; expose `gitRemoteUrl`/`repoTag` on the session-info query; match against linked
  repos; tag captured sources by `repoTag`.
- **Local ingest (desktop):** a **bounded, opt-in** "Index this repo into memory" action — walk
  `listWorkspaceFilesCached()` (already git-aware, ignores `.git`/`node_modules`/`dist`), read via
  `fsRead` (200 KB cap), ingest via `ingestSource(kind:file)` (AST-chunked, content-hash dedup).
  Incremental re-index on demand/commit.
- **Cloud consume `repoUrl`:** when a CLI/desktop session's `repoTag` matches a `Project.repoUrl`,
  associate that session's memory with the project (`projectId` tag) and surface it in the dashboard.

## Phased plan (each phase verified locally; no commits until you approve)

| Phase | Scope | Key files | Status |
|---|---|---|---|
| **P0** | `normalizeRepoUrl()`/`repoTag()`/`sameRepo()`/`matchLinkedRepo()` in core | `packages/core/src/track/git/repoIdentity.ts` | ✅ **done** — 6 tests |
| **P1a** | `resolveWorkspaceGit` reads `origin` remote → `remoteUrl`/`repoIdentity`/`repoTag` | `packages/core/src/git/workspaceGit.ts` | ✅ **done** — 9 tests |
| **P1b** | Desktop host `git-info` query surfaces the identity to the app/agent | `brainrouter-desktop/electron/host/queries.ts` | ✅ **done** — renderer+electron tsc |
| **P2** | Bounded, idempotent local-file ingest → memory (`kind:file`, scoped by `repoTag`) | `brainrouter/src/memory/source/ingestRepo.ts` | ✅ **done** — 4 tests |
| **P1c** | Scope turn-capture (transcripts) by `repoTag`, not just path-hash | `brainrouter/src/memory/capture/*`, `SourceDocument` | ▫ pending |
| **P3** | Desktop "GitHub / Repositories" settings surface (device-flow connect, linked repos, link-current-workspace, index toggle) — **screenshot-driven with the user** | new `src/settings/github/*`, NAV in `src/settings/shared/types.ts`; new host `action:index-repo` | ▫ pending (needs running app) |
| **P4** | Cloud consumes `Project.repoUrl` (repoTag↔repoUrl match → `projectId` memory scope) | `brainrouter/src/api/routes/tenancy/{projects,githubRepos}.ts`, recall scoping | ▫ pending (proof needs a linked repo) |
| **P5** *(deferred)* | Hosted BrainRouter App (one-click cloud connect) + server-side remote pull | new callback host + token store |

## Non-goals / deferred
- Hosted/shared BrainRouter GitHub App + OAuth callback infra (P5).
- Server-side clone/pull of remote repo content (P5) — local-first (D2) covers the desktop MCP case.
- Unifying desktop-local-config and cloud-Postgres storage — kept separate by design; only the concept
  and the `repoTag` identity are shared.

## Security / privacy
- Local-code ingest is **opt-in and bounded** (file count/size caps, respects ignore rules); nothing is
  auto-scanned without the user's action.
- Secrets stay where they already live: desktop → OS keychain; cloud → sealed `integration_configs`.
  No new `.env` knobs (per project policy).
- `repoTag` is a hash of a public remote URL — not sensitive; safe to store/log.
