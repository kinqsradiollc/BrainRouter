# BrainRouter setup and operations

This runbook covers a source checkout. It is organized around the current architecture: PostgreSQL + pgvector, database-backed provider and connector configuration, a shared brain service, and desktop/CLI/dashboard clients.

## 1. Prerequisites

| Requirement | Minimum | Check |
| --- | --- | --- |
| Node.js | 22 | `node -v` |
| npm | 10 | `npm -v` |
| Git | current | `git --version` |
| PostgreSQL | 14+ with pgvector | `psql --version` |
| Docker | optional local database/stack | `docker version` |

The packaged desktop targets macOS and Windows. Electron source development requires the same Node/npm toolchain.

## 2. Install the workspace

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install
```

This is an npm workspace. Install once at the repository root; do not run independent installs in every package unless a package-specific recovery step says to.

Build shared packages before applications that consume their compiled output:

```bash
npm run build:packages
```

## 3. Start PostgreSQL + pgvector

For local development:

```bash
docker compose -f deploy/postgres/docker-compose.yml up -d
docker compose -f deploy/postgres/docker-compose.yml ps
```

The default development URL is:

```text
postgres://postgres:postgres@localhost:5432/brainrouter
```

Use a real password and a managed/secured database for shared or production deployments. The complete production compose stack is documented in [`deploy/stack/README.md`](deploy/stack/README.md).

## 4. Configure the brain service

```bash
cp brainrouter/.env.example brainrouter/.env
```

Set at least:

```bash
BRAINROUTER_DATABASE_URL=postgres://postgres:postgres@localhost:5432/brainrouter
BRAINROUTER_SECRET_KEY=<32-byte base64-or-hex-key>
BRAINROUTER_JWT_SECRET=<strong-random-signing-secret>
BRAINROUTER_ADMIN_EMAIL=you@example.com
BRAINROUTER_ADMIN_PASSWORD=<first-boot-password>
```

Generate development secrets without putting them in shell history:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

`BRAINROUTER_SECRET_KEY` seals provider, integration, and connector credentials at rest. `BRAINROUTER_JWT_SECRET` signs browser/account sessions and is required in production. The admin password is a first-boot seed; clear it from the deployment environment after the account exists.

For a global `brainrouter-mcp` installation, run `brainrouter-mcp init`. It creates `~/.config/brainrouter/server.env`; the same required infrastructure values apply.

### Providers are configured after sign-in

LLM, embedding, reranker, and judge providers are normal database records—not the primary `.env` configuration path. After the server and dashboard are running:

1. sign in as the seeded admin;
2. select the active organization;
3. open **Settings → Intelligence**;
4. add an LLM provider and make it default;
5. optionally add embedding, reranker, and judge providers.

Keys are write-only in the UI and remain sealed server-side.

## 5. Run the product

### Brain service

```bash
npm run dev:http -w @kinqs/brainrouter-mcp-server
```

Default endpoints:

- `GET http://localhost:3747/health`
- `GET http://localhost:3747/api/status`
- `POST http://localhost:3747/mcp`
- authenticated REST under `http://localhost:3747/api/*`

### Dashboard

```bash
npm run dev -w dashboard
```

Open <http://localhost:3000>. The development server accepts localhost CORS origins; production must set `BRAINROUTER_CORS_ORIGIN` to the deployed dashboard origin.

### CLI

```bash
npm run cli
```

On first run, the terminal wizard writes `~/.config/brainrouter/config.json` and workspace preferences under `<workspace>/.brainrouter/`. Use `/init` to repeat onboarding, `/config` for runtime settings, and `/login` for brain profiles.

### Desktop

```bash
npm run start -w brainrouter-desktop
```

This command rebuilds the shared types/core dependencies, the Electron host, and the renderer before launching. Use `npm run start:fast -w brainrouter-desktop` only after a successful current build.

## 6. Configure account connections

Dashboard and desktop consume the same server-side connection records.

1. In Dashboard → **Connections**, choose an OAuth provider.
2. An organization admin configures its OAuth application. Client secrets are write-only.
3. Each user chooses **Connect** and completes the provider authorization.
4. Select resources and run/schedule sync.
5. Verify the same provider status appears in desktop settings.

Supported OAuth providers include GitHub, GitLab, Slack, Google Drive, Gmail, Notion, and Linear. Account OAuth is the default for API sync. A webhook signing secret is separate: it authenticates inbound events and is only needed when an inbound webhook automation is enabled.

GitHub has additional installation credentials for repository linking, check-runs, and pull-request automation. Follow [`brainrouter-docs/setup/github-app-setup.md`](brainrouter-docs/setup/github-app-setup.md).

## 7. Organization, project, and workspace scope

- The active organization travels in `X-BrainRouter-Org` for REST/SDK requests.
- Dashboard projects are organization-owned and can be restricted by membership.
- Desktop/CLI workspaces use a stable workspace tag.
- A `.brainrouter/project.json` marker can group local workspaces under one project tag.
- Knowledge and sources expose organization/project/workspace filters. Switching organization must replace, not reuse, cached scoped results.

Example local project marker:

```json
{
  "name": "brainrouter"
}
```

## 8. Validation

Use the smallest relevant check while iterating, then run the full gate before shipping.

```bash
# All workspace typechecks.
npm run typecheck

# Full test suites (packages and apps with tests).
npm run test

# Full production builds in dependency order.
npm run build

# Repository lint.
npm run lint
```

Useful focused checks:

```bash
npm run test -w @kinqs/brainrouter-core
npm run test -w @kinqs/brainrouter-mcp-server
npm run test -w @kinqs/brainrouter-cli
npm run test -w brainrouter-desktop
npm run typecheck -w dashboard
npm run build -w dashboard
```

The server integration tests create temporary PostgreSQL databases. Set `BRAINROUTER_TEST_PG_ADMIN_URL` when the default local admin URL is not appropriate.

## 9. Production build and run

```bash
npm run build

# Built brain service
npm run start:http -w @kinqs/brainrouter-mcp-server

# Built dashboard
npm run start -w dashboard
```

For Cloudflare/OpenNext dashboard verification:

```bash
npm run cf:build
```

Desktop packages:

```bash
npm run dist:mac -w brainrouter-desktop
npm run dist:win -w brainrouter-desktop
```

Signing and notarization require platform credentials; unsigned local builds do not grant permission to publish artifacts.

## 10. Upgrade

```bash
git pull --ff-only
npm install
npm run build:packages
npm run typecheck
npm run test
npm run build:apps
```

The brain applies numbered PostgreSQL migrations on startup. Back up the database before upgrading a shared deployment.

## 11. Troubleshooting

### Brain fails with a missing database URL

Set `BRAINROUTER_DATABASE_URL` (or `DATABASE_URL`) in `brainrouter/.env`, `~/.config/brainrouter/server.env`, or the service environment. SQLite is not a fallback.

### Secret-backed settings will not save

Set a valid 32-byte `BRAINROUTER_SECRET_KEY` and restart the brain. Existing saved secrets require the same key; rotating it without a migration makes them unreadable.

### Dashboard cannot reach the API

Check both endpoints and the browser origin:

```bash
curl http://localhost:3747/health
curl http://localhost:3747/api/status
```

For production, verify `BRAINROUTER_CORS_ORIGIN` exactly matches the dashboard origin.

### Dashboard chat says no model is configured

Sign in, select the intended organization, and configure a default LLM provider in **Settings → Intelligence**. Chat resolves the active organization’s provider rather than reading a browser key.

### Desktop imports fail after shared-core edits

Rebuild shared dependencies first:

```bash
npm run build:deps -w brainrouter-desktop
npm run typecheck -w brainrouter-desktop
```

### Track reports no account connection

Confirm the desktop is signed in, GitHub is connected in the same organization, and the workspace has an unambiguous `git remote`. Local PAT fields are an advanced fallback, not the normal account path.

### OAuth works but webhook automation does not

OAuth authorizes outbound API calls. Inbound webhooks additionally require a public callback URL and the matching signing secret. Configure it only for the enabled inbound trigger.

### PostgreSQL test databases remain after interruption

Integration tests normally clean up. Remove only known temporary databases named `br_test_*`; do not drop the main `brainrouter` database.

## 12. Reset and data safety

These actions are destructive. Back up first.

Reset only build output:

```bash
rm -rf brainrouter/dist brainrouter-cli/dist brainrouter-dashboard/.next brainrouter-desktop/dist brainrouter-desktop/dist-electron
npm run build
```

Reset local PostgreSQL data:

```bash
docker compose -f deploy/postgres/docker-compose.yml down
docker volume rm brainrouter-pg
docker compose -f deploy/postgres/docker-compose.yml up -d
```

Reset CLI settings only:

```bash
mv ~/.config/brainrouter/config.json ~/.config/brainrouter/config.json.backup
```

Reset desktop application state with the bundled script:

```bash
npm run reset:desktop -w brainrouter-desktop
```

Workspace-local state lives under `<workspace>/.brainrouter/`; remove it only when you intentionally want to discard local sessions, workflow runs, Track data, plans, UI-test artifacts, and other workspace state.

## 13. Reference paths

| Area | Path |
| --- | --- |
| Brain environment template | `brainrouter/.env.example` |
| Brain migrations | `brainrouter/src/memory/store/postgres/migrations/` |
| Dashboard | `brainrouter-dashboard/` |
| Desktop host and renderer | `brainrouter-desktop/electron/`, `brainrouter-desktop/src/` |
| CLI config/runtime | `brainrouter-cli/src/config/`, `brainrouter-cli/src/runtime/` |
| Shared runtime | `packages/core/` |
| Public SDK/types | `packages/sdk/`, `packages/types/` |
| Production stack | `deploy/stack/` |
| Detailed configuration | `brainrouter-docs/configuration.md` |
| Design contract | `design.md` |
