# Deploying the dashboard to Cloudflare Workers

The dashboard is a fully client-rendered Next.js app — there are no API routes,
server components, or server actions; all data comes from the BrainRouter HTTP
API through the SDK. That means it **exports to static HTML** and is served by a
Cloudflare Worker using [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
— no SSR runtime, no cold starts, global edge caching.

## Cloudflare project settings

All of the dashboard's shared deps (`@kinqs/brainrouter-types` / `-sdk` /
`-hooks`) are **published to npm**, so you can build straight from the dashboard
subdirectory — **Recommended**:

| Setting | Value |
| --- | --- |
| **Root directory** | `brainrouter-dashboard` |
| **Build command** | `npm run build:cf` |
| **Build output directory** | `out` |
| **Environment variables** | `NEXT_PUBLIC_API_URL=https://your-api` (+ `NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION=true` for the marketing-only preview) |

> The default `npm run build` (plain `next build`) **won't** work — it produces a
> `.next` server build, not a static export. Use **`build:cf`** (which sets
> `CLOUDFLARE_BUILD=1` → `output: "export"` → `./out`).

### Alternative: build the whole monorepo from the repo root

If you'd rather build everything from source (no reliance on the published
packages), set **Root directory = `/`**, **Build command = `npm run cf:build`**
(builds `types → sdk → hooks` then the dashboard static export), **Output =
`brainrouter-dashboard/out`**.

(For a Worker via `wrangler` instead of Pages: from `brainrouter-dashboard/`, run
`npm run build:cf` then `wrangler deploy` — its `wrangler.jsonc` serves `./out`.)

## How it's wired

- **`next.config.ts`** — `output: "export"` is enabled only when
  `CLOUDFLARE_BUILD=1`, so the normal `next build` / `next start` (server build)
  is untouched for local dev and other targets. The Cloudflare build writes
  static HTML + assets to **`./out`**.
- **`wrangler.jsonc`** — an assets-only Worker (no `main` entrypoint) that serves
  `./out`. `/overview` resolves to `/overview.html`; unknown paths get
  `404.html`.

## Build-time environment (important)

A static export **inlines `NEXT_PUBLIC_*` at build time** — there is no server to
read env vars at runtime. Set them when you build:

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | BrainRouter HTTP API the dashboard calls (e.g. `https://api.example.com`). |
| `NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION` | `true` for a marketing-only preview (no backend, only `/` + `/about`); unset/`false` for the full app. |

## Commands

```bash
# Build the static bundle into ./out
NEXT_PUBLIC_API_URL=https://api.example.com npm run build:cf

# Preview the Worker locally (build + wrangler dev)
npm run cf:preview

# Deploy (build + wrangler deploy) — needs `wrangler login` once
NEXT_PUBLIC_API_URL=https://api.example.com npm run cf:deploy
```

First-time setup: `npx wrangler login`, then set `name`/route/custom domain in
`wrangler.jsonc` (and a `[env.production]` block if you want staging vs prod).

## Notes

- **Why not OpenNext / SSR Workers?** Nothing in the app needs a server. If a
  future feature adds API routes or server components, switch to
  [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) — drop
  `output: "export"`, add `main`, and keep the same Worker.
- **CORS**: the BrainRouter server must allow the dashboard's origin
  (`BRAINROUTER_CORS_ORIGIN` on the server side).
