# BrainRouter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%233178c6.svg)](https://www.typescriptlang.org/)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

**Plan the day, run the meeting, write the doc, ship the change — and keep the thread.**

BrainRouter is one workspace a whole team works in. Six things happen to a piece
of work every week, and the useful part is not any one of them: it is that the
sixth still knows what happened in the first.

Engineering is the deepest surface here, not the whole product. The same task
context runs through planning, meetings, documents, implementation, review, and
durable knowledge — so this is one workspace rather than six tools that agree to
share a login.

## The loop

An item enters once and keeps its identity, owner, and evidence all the way
around. Every stage is a real route in the product, not a diagram:

| # | Stage      | What happens                                                             | Route       |
| - | ---------- | ------------------------------------------------------------------------ | ----------- |
| 1 | **Plan**   | Today assembles itself from your items plus whatever your trackers mirror in. | `/planner`  |
| 2 | **Meet**   | The call is recorded, transcribed segment by segment, and summarized; action items come out with owners. | `/meetings` |
| 3 | **Write**  | The decision is written down where the work is, with pages, databases, and backlinks. | `/notes`    |
| 4 | **Build**  | An agent picks the item up with the context, permissions, and repository already in scope. | `/chat`     |
| 5 | **Verify** | Code review, security review, or both — every finding naming the exact lines it came from. | `/reviews`  |
| 6 | **Know**   | Next week the thread is still there, attributable rather than vaguely remembered. | `/knowledge`|

**Know feeds Plan.** That is why it is a loop.

## Four ways in

The loop is the product. These are the doors into it, and they share models,
permissions, connected tools, workflows, and context:

| Surface                       | Use it for                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop**                   | The primary Chat · Code · Track workbench: projects, sessions, files, plans, requirements, tools, terminal, automations, connectors, and reviews. |
| **CLI (`brainrouter`)**       | A TTY-native coding agent with the same runtime, routing, policy, memory, orchestration, workflows, and goal loop.                                |
| **Dashboard**                 | Authenticated workspace: the loop above, plus organizations, account connections, providers, repositories, knowledge, review jobs, and operations. |
| **Brain (`brainrouter-mcp`)** | PostgreSQL-backed MCP and REST services for cognition, tenancy, connectors, review jobs, triggers, and other clients.                             |
| **Shared packages**           | Typed runtime, SDK, hooks, agent protocol, and public contracts used across every interface.                                                      |

## Architecture

```mermaid
flowchart LR
  Desktop[Desktop] --> Core[Shared agent runtime]
  CLI[CLI] --> Core
  Dashboard[Dashboard] --> API[Authenticated REST API]
  MCP[MCP clients] --> Brain[Brain service]
  Core --> Brain
  API --> Brain
  Brain --> PG[(PostgreSQL + pgvector)]
  Brain --> Providers[Model providers]
  Brain --> Connections[OAuth connectors]
  Brain --> Reviews[Review and automation workers]
```

Important boundaries:

- model and integration credentials are stored server-side and sealed with `BRAINROUTER_SECRET_KEY`;
- organizations, projects, workspaces, users, and sources are explicit scope—not a global browser cache;
- account OAuth is the default API credential path, while webhook signing secrets only authenticate inbound events;
- local tools still pass through the runtime permission, approval, sandbox, and path-policy layers;
- review findings remain tied to repository evidence, checks, and attributable vulnerability intelligence.

## Requirements

- Node.js 22+
- npm 10+
- PostgreSQL with pgvector (the development stack is in [`deploy/postgres/`](deploy/postgres/))
- macOS or Windows for the packaged desktop app; source development also works through Electron

## Quick start from source

> **Full guide:** [`deploy/README.md`](deploy/README.md) covers dev setup
> (host or live-reload Docker), building the production stack from source, and
> the dashboard-vs-`.env` configuration split. The essentials:

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install

# Start local PostgreSQL + pgvector.
docker compose -f deploy/postgres/docker-compose.yml up -d

# Configure infrastructure and auth.
cp brainrouter/.env.example brainrouter/.env
# Set BRAINROUTER_DATABASE_URL, BRAINROUTER_SECRET_KEY,
# BRAINROUTER_JWT_SECRET, and the first-boot admin values.

npm run build
```

Run the brain and dashboard:

```bash
# Terminal A — MCP + REST on http://localhost:3747
npm run dev:http -w @kinqs/brainrouter-mcp-server

# Terminal B — dashboard on http://localhost:3000
npm run dev -w dashboard
```

Sign in as the seeded admin (its API key prints once in the brain logs), then configure the organization’s LLM / embedding / reranker providers under **Intelligence → Models & providers**. Providers live in the database; `.env` holds only infrastructure + operational settings, never provider credentials. The embedding vector width is derived from the embedder automatically.

Run a local client:

```bash
# Terminal workbench
npm run cli

# Desktop workbench
npm run start -w brainrouter-desktop
```

## Deploy (build from source)

There is no published server image — the production stack is built from this
repo. Fill secrets and bring it up (Postgres + one-shot migrator + the
service-capable brain):

```bash
cd deploy/stack
cp .env.example .env
docker compose up -d --build          # → brain on http://localhost:3747
```

Pin a version by checking out a release tag before building
(`git checkout v0.4.16 && docker compose … up -d --build`); update with
`git pull && docker compose … up -d --build` (the migrator runs first). See
[`deploy/README.md`](deploy/README.md) and [`brainrouter-docs/HOSTING.md`](brainrouter-docs/HOSTING.md).

## Install published clients

```bash
npm install -g @kinqs/brainrouter-cli
npm install -g @kinqs/brainrouter-mcp-server
```

Published libraries include [`@kinqs/brainrouter-core`](https://www.npmjs.com/package/@kinqs/brainrouter-core), [`@kinqs/brainrouter-sdk`](https://www.npmjs.com/package/@kinqs/brainrouter-sdk), [`@kinqs/brainrouter-hooks`](https://www.npmjs.com/package/@kinqs/brainrouter-hooks), [`@kinqs/brainrouter-agent-protocol`](https://www.npmjs.com/package/@kinqs/brainrouter-agent-protocol), and [`@kinqs/brainrouter-types`](https://www.npmjs.com/package/@kinqs/brainrouter-types).

The CLI setup wizard configures its local model and brain connection. It can run with local tools when the remote brain is unavailable; use `--strict-mcp` when an offline fallback is not acceptable.

## Connections and knowledge

The shared connection flow is:

1. an organization admin configures the provider OAuth app in Dashboard → Connections;
2. a user connects their account;
3. the service seals the user token and exposes status/resources without returning it;
4. server-side sync checkpoints the selected source into the owner’s memory;
5. desktop and dashboard read the same connection and sync state.

Supported OAuth sources include GitHub, GitLab, Slack, Google Drive, Gmail, Notion, and Linear. Additional runtime connectors include filesystem, web, Jira, Confluence, and MCP resources where their credential model applies.

Knowledge and source requests carry organization, project, and workspace scope. Record ownership and source provenance stay attached to the returned evidence. Recall combines keyword, vector, file-path, freshness, reranking, and graph expansion, then returns attributable records instead of an opaque context blob.

## Reviews and automation

- Desktop and dashboard can inspect backend pull-request review jobs and findings; local uncommitted-change review remains a separate workspace action.
- GitHub App installation credentials support repository linking, check-runs, and webhook-triggered review automation.
- Track detects a repository from the active workspace remote and uses the signed-in account connection before any advanced local-token fallback.
- CVE-, security-, advisory-, exploit-, and affected-version prompts automatically receive a bounded briefing from the continuously refreshed NVD catalog, enriched with CISA KEV and FIRST EPSS source/freshness metadata. Security and code reviews also receive exact repository matches produced from OSV plus stored inventory evidence.

See [`brainrouter-docs/setup/github-app-setup.md`](brainrouter-docs/setup/github-app-setup.md) for the GitHub trust boundaries and [`brainrouter-docs/automations.md`](brainrouter-docs/automations.md) for automation behavior.

## Development

```bash
# Build packages before apps that consume their compiled output.
npm run build:packages
npm run build:apps

# Repository-wide verification.
npm run typecheck
npm run test
npm run lint
```

Desktop verification rebuilds shared dependencies automatically:

```bash
npm run test -w brainrouter-desktop
```

Read [`CLAUDE.md`](CLAUDE.md) and the relevant package rules before editing. The durable visual and interaction contract is [`design.md`](design.md).

## Documentation

- [`deploy/README.md`](deploy/README.md) — dev setup + build-from-source Docker deploy (start here to run it).
- [`SETUP.md`](SETUP.md) — operator and maintainer setup/runbook.
- [`BRAINROUTER.md`](BRAINROUTER.md) — brain, memory, REST, and MCP behavior.
- [`SYSTEM_WORKFLOWS.md`](SYSTEM_WORKFLOWS.md) — end-to-end runtime flows.
- [`SECURITY.md`](SECURITY.md) — security policy and trust boundaries.
- [`BENCHMARKS.md`](BENCHMARKS.md) — reproducible evaluation commands and results.
- [`brainrouter-docs/`](brainrouter-docs/) — configuration, architecture decisions, connectors, automation, and deep dives.
- [`ROADMAP.md`](ROADMAP.md) and [`CHANGELOG.md`](CHANGELOG.md) — planned and shipped work.

## License

MIT — see [`LICENSE`](LICENSE).
