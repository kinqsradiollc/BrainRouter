# Running BrainRouter — dev & deploy (from source)

BrainRouter is installed and run **from source in this repo** — there is no
published/registry image. You clone the repo, and either run the backend
directly with Node or build the Docker image locally from the included
Dockerfiles. Everything is backed by **Postgres + pgvector**, and the whole
backend is one door: the `brain` process serves MCP (`/mcp`), the REST API
(`/api/*`), the OpenAI-compatible model gateway (`/v1`), the dashboard, and
`/health` on a single port (default **`3747`**).

> **AI providers, model choices, the embedding vector width, and email are
> configured in the DATABASE via the dashboard — NOT in `.env`** (ADR-012). The
> only things in `.env` are infrastructure: the DB URL, the encryption/JWT
> secrets, the first-admin seed, and CORS. See [Configuration](#configuration).

## Prerequisites

- **Node 22+** and **npm** (workspace monorepo).
- **Docker + Docker Compose** (for the DB, the Whisper sidecar, and container deploys).
- **git** — you build from the checked-out source.
- A **Postgres 16 with `pgvector`** — use the bundled one (`deploy/postgres`) or bring your own (RDS, Neon, Supabase, …).

## Pick your setup

| Goal | Path | Reflects code edits |
| --- | --- | --- |
| **Develop** the backend with live-reload | [`deploy/dev`](dev/README.md) (Docker) **or** `npm --prefix brainrouter run dev:http` on the host | yes (tsx watch) |
| **Deploy** the full backend (build from source) | [`deploy/stack`](stack/README.md) | no — rebuild on change |
| Just a local **Postgres + pgvector** | [`deploy/postgres`](postgres/README.md) | — |
| Just the **Whisper STT** sidecar | [`deploy/stt`](stt/README.md) | — |
| Put it **behind a Cloudflare tunnel** | [`deploy/tunnel`](tunnel/) (add-on to `deploy/stack`) | — |

---

## Develop (from source)

**1. Clone + install.**
```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm ci
```

**2. Start Postgres** (or point at your own):
```bash
docker compose -f deploy/postgres/docker-compose.yml up -d
# → postgres://postgres:postgres@localhost:5432/brainrouter  (pgvector ready)
```

**3. Configure the backend env.** Copy the template and fill the infra values:
```bash
cp brainrouter/.env.example brainrouter/.env
# set BRAINROUTER_DATABASE_URL, BRAINROUTER_SECRET_KEY, BRAINROUTER_JWT_SECRET,
# and BRAINROUTER_ADMIN_PASSWORD (seeds the first admin on first boot).
#   openssl rand -base64 32   # for BRAINROUTER_SECRET_KEY
#   openssl rand -hex 32      # for BRAINROUTER_JWT_SECRET
```
No provider keys go here — you add those in the dashboard after first boot.

**4. Run the backend.** Two options:

- **On the host** (fastest inner loop; `tsx watch` reloads on edit):
  ```bash
  npm --prefix brainrouter run dev:http     # brain on http://localhost:3747
  ```
  The one thing the host can't provide is speech-to-text — start the Whisper
  sidecar in Docker if you need Meetings: `docker compose -f deploy/dev/docker-compose.dev.yml up -d stt`.

- **Fully in Docker with live-reload** (bind-mount + `tsx watch`, plus the STT
  sidecar) — see [`deploy/dev`](dev/README.md):
  ```bash
  cd deploy/dev && cp .env.example .env      # or regenerate from brainrouter/.env
  docker compose -f docker-compose.dev.yml up -d
  ```

**5. Run the dashboard** (Next.js) and, optionally, the **desktop** app (Electron + Vite):
```bash
npm run dev -w dashboard            # http://localhost:3000
npm run dev -w brainrouter-desktop  # Electron dev window
```
Set `BRAINROUTER_CORS_ORIGIN=http://localhost:3000` in `brainrouter/.env` so the
dashboard browser is allowed to call `/api` and `/mcp`.

**6. First boot → configure providers.** The brain prints the seeded admin's API
key **once** in its logs. Sign in to the dashboard as that admin →
**Intelligence → Models & providers**, and add your LLM / embeddings / reranker
providers (endpoint, key, model). They're stored (encrypted) in the DB — nothing
to put in `.env`.

---

## Deploy — build from source

The production stack is built locally from this repo (no registry pull). It
brings up Postgres, a one-shot migrator, and the service-capable brain (plus the
optional gateway / STT / worker / api / ingress / remote-relay services).

```bash
cd deploy/stack
cp .env.example .env          # fill POSTGRES_PASSWORD + the brain secrets
docker compose up -d --build  # builds the image from source, then starts everything
# → brain on http://localhost:3747  (MCP /mcp · REST /api/* · /v1 · /health)
```

**Pin a version.** Because the image is compiled from your working tree, the
"version" is simply the commit you build from. To deploy a specific release,
check it out before building:
```bash
git fetch --tags
git checkout v0.4.16          # or a release branch
docker compose -f deploy/stack/docker-compose.yml up -d --build
```

**Update to newer code.** Pull and rebuild — the migrator applies any new DB
migrations before the brain serves:
```bash
git pull
docker compose -f deploy/stack/docker-compose.yml up -d --build
```

**Single node vs. decomposed.** By default the stack runs the brain as one
service-capable process. It can be split across processes (gateway / api /
worker / ingress / remote-relay) for scale — see [`deploy/stack/README.md`](stack/README.md)
and ADR-006/008/013. Just the brain image on its own DB lives in
[`deploy/brain`](brain/README.md).

**Public hostname.** Add the Cloudflare tunnel sidecar (no inbound ports opened):
```bash
docker compose -f deploy/stack/docker-compose.yml -f deploy/tunnel/docker-compose.tunnel.yml up -d
```
See [`brainrouter-docs/HOSTING.md`](../brainrouter-docs/HOSTING.md) for the three hosting modes.

---

## Configuration

`.env` holds **infrastructure only**. Everything a user would tune lives in the
DB via the dashboard:

| Configured in the dashboard / DB (NOT `.env`) | Where |
| --- | --- |
| LLM / embeddings / reranker providers (endpoint, key, model) | **Intelligence → Models & providers** → `provider_configs` |
| Per-role sub-agent models (extraction, synthesis, reviews, meeting-summary) | **Models & providers → Subagents** → `agentModels` setting |
| Managed models BrainRouter serves as a provider | **Managed Models** |
| Embedding **vector width** | auto-derived from the embedder (no config) |
| SMTP / email | **Email settings** → `/api/admin/email` |

| Kept in `.env` (infrastructure / bootstrap) | Why |
| --- | --- |
| `BRAINROUTER_DATABASE_URL` | needed to reach the DB (chicken-and-egg) |
| `BRAINROUTER_SECRET_KEY` | AES-256-GCM key that encrypts the DB-stored provider/email secrets |
| `BRAINROUTER_JWT_SECRET` | session signing |
| `BRAINROUTER_ADMIN_EMAIL` / `_PASSWORD` | first-admin seed (clear after first boot) |
| `BRAINROUTER_CORS_ORIGIN` | browser origins allowed to call the API |
| `BRAINROUTER_REDIS_URL` | **optional** read cache (CVE catalog, hot GETs) — see below |
| `BRAINROUTER_SYSTEM_ORG_ID`, `_JOB_RUNNER`, `_METRICS`, `_SERVICE`, `_PORT` | deployment topology |

**Optional Redis cache.** The compose stacks bundle a `redis` service and point
the REST/brain services at it via `BRAINROUTER_REDIS_URL` (`redis://redis:6379`),
so hot global reads — the CVE catalog list/detail and other high-traffic GETs —
are served from cache. It is purely an accelerator: **unset the variable (or make
Redis unreachable) and the services fall back to an in-process cache with no loss
of correctness.** The `ioredis` client is an optional dependency baked into the
Docker image; a from-source run without it simply uses the in-process cache.

Beyond those, a large set of **operational tuning knobs** (timeouts, concurrency
caps, reranker/pgvector index params, recall limits, sweepers) are optional
`BRAINROUTER_*` env vars with sensible defaults — set them only when tuning a
deployment. They are documented in
[`brainrouter-docs/configuration.md`](../brainrouter-docs/configuration.md).

## Verify

```bash
curl -fsS http://localhost:3747/health       # {"status":"ok","service":"brain",...}
curl -fsS http://localhost:3747/api/status   # per-component rollup (503 on any outage)
```
