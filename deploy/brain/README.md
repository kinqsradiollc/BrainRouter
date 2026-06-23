# Remote brain — server image + compose (Phase 5)

Runs the BrainRouter **brain** (cognitive memory MCP server) as a network service
backed by Postgres + pgvector, so the CLI and the dashboard can connect to it as
a **remote client** instead of embedding it. Embedded/stdio remains the default;
this is the opt-in scale path (ADR-005).

> Not vendored — the image is built from this repo; the pgvector layer just pulls
> the official image. Point `BRAINROUTER_DATABASE_URL` at any Postgres 14+ with
> the `vector` extension if you'd rather bring your own DB.

## Run

```bash
cd deploy/brain
docker compose up -d --build
# brain → http://localhost:3747   (Streamable-HTTP MCP at /mcp; GET /health; GET /metrics if enabled)
```

First boot seeds an admin when `BRAINROUTER_ADMIN_PASSWORD` is set — the API key
is printed **once** in the logs (`docker compose logs brain`). Set
`BRAINROUTER_JWT_SECRET` for stable sessions in any shared deploy.

Build the image alone (context = repo root):

```bash
docker build -f deploy/brain/Dockerfile -t brainrouter-brain .
```

## Point a client at it

**CLI** — set the remote-brain knob (Phase 1) in `~/.config/brainrouter/config.json`:

```jsonc
{
  "cli": { "brainUrl": "http://localhost:3747/mcp" },
  "servers": { "brainrouter": { "type": "http", "url": "http://localhost:3747/mcp", "apiKey": "br_…", "identity": "brainrouter" } }
}
```

The CLI probes `/health` and falls back to the embedded brain if the remote is
unreachable (Phase 2). With `cli.brainUrl` set, `/atlas build|enrich` auto-sync
the graph to the brain; `/atlas pull` fetches it back (Phase 3d).

**Dashboard** — run it against the same origin and set `BRAINROUTER_CORS_ORIGIN`
on the brain to the dashboard's URL so the browser is allowed to call `/api` and
`/mcp`.

## Env (see `brainrouter/.env.example` for the full set)

| Var | Purpose |
| --- | --- |
| `BRAINROUTER_DATABASE_URL` | **required** — Postgres + pgvector (compose wires this to the `postgres` service) |
| `BRAINROUTER_JWT_SECRET` | stable session signing (required for shared deploys) |
| `BRAINROUTER_ADMIN_PASSWORD` / `_EMAIL` | seed the first admin on first boot |
| `BRAINROUTER_LLM_ENDPOINT` / `_API_KEY` / `_MODEL` | generative LLM for extraction + atlas enrich |
| `BRAINROUTER_METRICS=on` | expose Prometheus `/metrics` |
| `BRAINROUTER_CORS_ORIGIN` | comma-separated browser origins allowed to call the API |
| `BRAINROUTER_PGVECTOR_INDEX` / `_LISTS` / `_HNSW_*` | ANN index tuning |

## Notes
- The container runs `node dist/index.js --http --port 3747`; `HEALTHCHECK` hits `/health`.
- The pool connects + migrates **lazily on first use** and closes cleanly on `SIGTERM`.
- Image size: the build installs the workspace graph with `--ignore-scripts` (skips the desktop's Electron download) and prunes devDeps for the runtime layer. Further slimming (surgical workspace install) is a follow-up.
