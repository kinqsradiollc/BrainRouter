# Deploying the dashboard to Cloudflare Workers

The dashboard deploys as a real Next.js Worker runtime through
`@opennextjs/cloudflare`. Do not use Next static export for this deployment:
Cloudflare Workers that only serve Static Assets cannot use runtime Variables,
Secrets, triggers, Logpush, or Tail Workers.

## Cloudflare project settings

The dashboard is part of an npm workspace. Its shared deps live in `packages/*`,
so the Cloudflare build must build those packages before OpenNext packages the
dashboard.

> **The Root directory must be the REPOSITORY ROOT, not `brainrouter-dashboard`.**
> `@kinqs/brainrouter-ui` is `"private": true` and is never published, so an
> install rooted at `brainrouter-dashboard/` cannot resolve it and fails with
> `E404` before any build runs. Every other shared dep is published, which is why
> a dashboard-rooted install worked until the shared planner/notes surfaces
> landed — the failure arrived with a dependency, not with a settings change.

Use these settings for a Git-connected Worker:

| Setting | Value |
| --- | --- |
| **Root directory** | *(repository root — leave blank)* |
| **Build command** | `npm run cf:build` |
| **Deploy command** | `npx wrangler deploy --cwd brainrouter-dashboard` |
| **Runtime variables/secrets** | Configure in the Worker runtime panel after this deploy creates `.open-next/worker.js`. |
| **Build variables/secrets** | Use only for values needed during `next build`, such as `NEXT_PUBLIC_*`. |

`cf:build` is the root's `npm run build:cf -w dashboard`, which runs
`build:packages:dashboard` (types, agent-protocol, core, sdk, hooks, ui) and then
`opennextjs-cloudflare build`. The OpenNext build writes, relative to
`brainrouter-dashboard/`:

- `.open-next/worker.js` — the Worker entrypoint.
- `.open-next/assets` — static assets served through the `ASSETS` binding.

`wrangler.jsonc` points at those OpenNext outputs:

```jsonc
{
  "main": ".open-next/worker.js",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  }
}
```

## Environment variables

There are two different places in Cloudflare:

| Location | Use for |
| --- | --- |
| **Build > Variables and secrets** | Values needed while Git builds run, especially `NEXT_PUBLIC_*` values that Next.js may inline into client bundles. |
| **Settings > Variables and Secrets** | Runtime Worker bindings and secrets available to server-side Worker code. |

For presentation-only mode, set this as a build variable:

```txt
NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION=true
```

For the full dashboard, set the API URL as a build variable:

```txt
NEXT_PUBLIC_API_URL=https://api.example.com
```

Only put private secrets in the runtime Variables/Secrets panel, and only read
them from server-side code. Anything prefixed with `NEXT_PUBLIC_` can be exposed
to browser JavaScript.

## Local commands

```bash
cd brainrouter-dashboard

# Build packages and create the OpenNext Worker output in .open-next/
npm run build:cf

# Preview in the Workers runtime
npm run cf:preview

# Deploy through Wrangler
npm run cf:deploy
```

First-time local deploys require:

```bash
npx wrangler login
```

## Notes

- Keep `wrangler deploy` running inside `brainrouter-dashboard/`, where
  `wrangler.jsonc` and `.open-next/` are created.
- `.open-next/` is generated output and should not be committed.
- The BrainRouter server must allow the deployed dashboard origin through CORS
  (`BRAINROUTER_CORS_ORIGIN` on the server side).
