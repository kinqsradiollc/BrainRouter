# GitHub + Core Connectors Implementation Plan

Release target: `release/0.4.17`

Status: GitHub Phase 2 is merged into `release/0.4.17`. The follow-up runtime-expansion branch adds real checkpoint runtimes for the currently enabled connector set beyond GitHub/GitLab/Filesystem/Web.

## Current Branch / PR State

| Item | Status | Notes |
|---|---|---|
| `release/0.4.17` | Phase 0-2 landed | PR #742, PR #744, and PR #746 are merged. |
| `feat/connector-phase1-repo-picker` | Included in PR #746 | Adds host repo discovery queries and target-scoped Track save plumbing. No separate PR is needed. |
| `feat/connector-phase2-oauth-host` / PR #746 | Merged | GitHub OAuth device flow, host/keychain token resolution, and Phase 1 UI/runtime wiring. |
| PR #744 `feat/connector-runtimes-fs-web-gitlab` | Merged | Included through PR #746 merge history; GitHub shows it as merged. |
| `codex/connector-runtime-expansion` | In progress | Adds the non-GitHub runtime expansion described below. |

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
| Slack | Yes | Yes | Channels, messages, and thread replies through a static env bot token. Permission/event flows are not advertised. |
| Jira | Yes | Yes | Issues and comments through a static env token plus `baseUrl`. Permission sync is not advertised. |
| Confluence | Yes | Yes | Pages, body text, and comments through a static env token plus `baseUrl`. Permission sync is not advertised. |
| Notion | Yes | Yes | Database/search pages, page block text, and optional comments through a static env token. |
| Linear | Yes | Yes | Issues, state/team/assignee metadata, and comments through a static env API key. |
| MCP Resources | Yes | Yes | Reads MCP resources through the existing host MCP pool; explicit URI lists require `serverId`. Event flow is not advertised. |
| Google Drive | Yes | Yes | Files, Google Docs export, optional Sheets export, and text-like downloads through a static Google access token. Permission sync is not advertised. |
| Gmail | Yes | Yes | Message search/list, full-message fetch, header extraction, and text/html body decoding through a static Google access token. |

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

### Remaining Catalog-Only Connectors

- Implement generic OAuth brokers per provider before enabling non-GitHub OAuth modes as a runnable credential path.
- Keep catalog-only sources greyed until each has:
  - credential resolution
  - checkpoint semantics
  - offline tests
  - Desktop run wiring
  - error sanitization
- Remaining catalog-only sources after this branch: Asana, ClickUp, Discord, Teams, Dropbox, SharePoint, HubSpot, Salesforce, Zendesk, Airtable, Bitbucket, GitBook, Discourse, S3, Gong, and Fireflies.

## Merge Recommendation

1. Keep PR #746 merged as the 0.4.17 GitHub connector base.
2. Ship `codex/connector-runtime-expansion` as a follow-up PR into `release/0.4.17`.
3. Do not expose a source in the Desktop ready set unless it has a real checkpoint runner, credential resolution, offline tests, and host wiring.
4. Do not treat provider OAuth labels as runnable for non-GitHub sources until provider-specific brokers exist; ready non-GitHub sources currently use static env-token references.

## Verification

Commands run:

```bash
npm run build -w @kinqs/brainrouter-types
npm run build -w @kinqs/brainrouter-core
npm run typecheck -w brainrouter-desktop
npm run build:electron -w brainrouter-desktop
node --test packages/core/dist/tests/filesystem-connector.test.js packages/core/dist/tests/web-connector.test.js packages/core/dist/tests/gitlab-connector.test.js packages/core/dist/tests/github-connector.test.js packages/core/dist/tests/track-github-sync.test.js brainrouter-desktop/dist-electron/githubOauth.test.js brainrouter-desktop/dist-electron/secretStore.test.js
node --test packages/core/dist/tests/api-source-connectors.test.js packages/core/dist/tests/google-connectors.test.js packages/core/dist/tests/mcp-connector.test.js packages/core/dist/tests/filesystem-connector.test.js packages/core/dist/tests/web-connector.test.js packages/core/dist/tests/gitlab-connector.test.js packages/core/dist/tests/github-connector.test.js
npm run build -w brainrouter-desktop
git diff --check
```

Result:

- TypeScript build/typecheck passed.
- Focused connector/OAuth tests passed. Current runtime-expansion connector suite passes 50/50; GitHub/OAuth regression suite passes 34/34.
- Desktop production build passed.
- Vite emitted the existing large-chunk warning only.
- `git diff --check` passed.
