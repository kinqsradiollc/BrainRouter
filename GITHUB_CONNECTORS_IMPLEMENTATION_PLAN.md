# GitHub + Core Connectors Implementation Plan

Release target: `release/0.4.17`

Status: implemented through GitHub Phase 2 plus real core runtimes for Filesystem, Web, and GitLab. Phase 3 hardening remains.

## Current Branch / PR State

| Item | Status | Notes |
|---|---|---|
| `release/0.4.17` | Phase 0 landed | Contains connector-as-source-of-truth for GitHub Track sync via PR #742. |
| `feat/connector-phase1-repo-picker` | Included in Phase 2 branch | Adds host repo discovery queries and target-scoped Track save plumbing. No separate PR exists. |
| `feat/connector-phase2-oauth-host` | Active integration branch | Contains Phase 1 + Phase 2 host/keychain OAuth work, plus this UI/runtime wiring. |
| PR #744 `feat/connector-runtimes-fs-web-gitlab` | Merged locally into Phase 2 | Adds core checkpoint runtimes and offline tests for Filesystem, Web, and GitLab. If Phase 2 is pushed, #744 can be closed or treated as superseded. |

## Implemented

### GitHub Phase 0: Connector Source Of Truth

- Track sync resolves repositories from GitHub connector records, not a separate hand-maintained Track panel.
- Active Track target is a connector/repo pair.
- Multiple connectors can reference the same repo without silently dropping the second identity.
- Missing/paused active connector returns an explicit error instead of silently falling back.
- Legacy `cli.track.github*` migration is idempotent and covered by tests.

### GitHub Phase 1: Repo Picker Plumbing + UI

- Host queries:
  - `github-connector-orgs`
  - `github-connector-repos`
- Settings now has a real GitHub repo picker:
  - loads viewer/org groups through the host
  - pages repos lazily
  - filters by text, private, archived, and fork status
  - writes selected `owner/name` values into the connector config
- Owner/org is now a hint used for all-repo mode or legacy owner-scoped operation; selected full repo names can span orgs.

### GitHub Phase 2: OAuth Device Flow

- Electron main owns GitHub OAuth device-flow requests and polling.
- Tokens are stored through the main-process secret store; renderer never receives token values.
- Host resolves `credential.mode: "oauth"` through the secret bridge.
- Settings can start/cancel/reconnect/disconnect OAuth for an existing GitHub connector.
- `cli.github.oauthClientId` has a dedicated Advanced setting.

### Core Connector Runtime Support

| Connector | Runtime | Desktop Run Button | Notes |
|---|---|---|---|
| GitHub | Yes | Yes | Issues, PRs, files, permissions, Track sync. |
| Filesystem | Yes | Yes | Relative roots are resolved against the workspace in Desktop; core still validates absolute roots. |
| Web | Yes | Yes | Same-origin crawl, optional static header token from env ref. |
| GitLab | Yes | Yes | Issues and merge requests through static token env ref; file ingest is explicitly unsupported for now. |
| Slack, Google Drive, Jira, Confluence, and catalog-only sources | Catalog only | No | Stay greyed until real runners and auth flows exist. |

## Remaining Work

### Phase 3: Secret Hardening

- Move static GitHub PATs out of `cli.track.githubToken` / env-only references into the same secret-store path used by OAuth.
- Add Test connection:
  - `GET /user`
  - scope readout
  - org visibility check
- Add Rotate / Revoke flows.
- Scrub connector runtime auth errors before persisting `lastError`.

### Phase 4: Multi-Identity Polish

- Make every Track picker and status row display connector name + repo, not just repo.
- Add docs for the identity model:
  - `dynamic` is single active `gh` account
  - `oauth` and keychain-backed `static` are the multi-account paths
- Consider GitHub App installation identity as a future connector mode.

### Non-GitHub Future Connectors

- Implement generic OAuth brokers per provider before enabling non-GitHub OAuth modes.
- Add real runners for Slack, Google Drive, Jira, Confluence, Notion, Linear, and the remaining catalog sources only when each has:
  - credential resolution
  - checkpoint semantics
  - offline tests
  - Desktop run wiring
  - error sanitization

## Merge Recommendation

1. Push the updated `feat/connector-phase2-oauth-host` branch.
2. Use it as the single integration PR into `release/0.4.17`.
3. Close or supersede PR #744 after confirming its files are present in the integration PR.
4. Do not merge catalog-only OAuth enablement for non-GitHub connectors until provider-specific OAuth brokers exist.

## Verification

Commands run:

```bash
npm run build -w @kinqs/brainrouter-types
npm run build -w @kinqs/brainrouter-core
npm run typecheck -w brainrouter-desktop
npm run build:electron -w brainrouter-desktop
node --test packages/core/dist/tests/filesystem-connector.test.js packages/core/dist/tests/web-connector.test.js packages/core/dist/tests/gitlab-connector.test.js packages/core/dist/tests/github-connector.test.js packages/core/dist/tests/track-github-sync.test.js brainrouter-desktop/dist-electron/githubOauth.test.js brainrouter-desktop/dist-electron/secretStore.test.js
npm run build -w brainrouter-desktop
git diff --check
```

Result:

- TypeScript build/typecheck passed.
- Focused connector/OAuth tests passed: 66/66.
- Desktop production build passed.
- Vite emitted the existing large-chunk warning only.
- `git diff --check` passed.
