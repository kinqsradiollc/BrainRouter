# ADR-009 — Centralized trigger ingress + a single GitHub App bot

> Status: **ACCEPTED — Phase 1 (GitHub App) implemented in 0.4.17; Phases 2–3 proposed.**
> Date: 2026-07-06. Covers the trigger-ingress / `@mention → fleet-job` automation.

## Context

Today the `@mention → fleet-job` automation ("Enable trigger ingress") is a
webhook receiver, but a **per-user, per-host** one:

- **Ingress** is a standalone `node:http` listener
  (`packages/core/src/triggers/server.ts`) that verifies `X-Hub-Signature-256`,
  allowlists repos, dedupes deliveries, and enqueues a fleet job
  (`packages/core/src/triggers/resolvers/github.ts` → `enqueueFleetJob`). It runs
  **in-process** in each user's desktop host (`electron/host/triggerServe.ts`) or
  via `brainrouter serve --triggers`, bound to `127.0.0.1:8787` by default.
- **Outbound auth** (the courtesy post-back comment) uses a **per-workspace PAT**
  resolved by `resolveGithubConfigForWorkspace` (`cli.track.githubToken` /
  connector token / `GITHUB_TOKEN`). So N users = N bot identities, N webhook
  configurations, and long-lived, broad-scoped, plaintext tokens.
- There is **no tenancy and no RBAC**: a workspace is one machine; anyone who can
  edit `config.json` can enable/configure triggers.

This does not scale to a team: each user must expose their own loopback receiver
to GitHub and authenticate as themselves. The desire is "one synced bot, one
place to configure, only the right role can change it."

Two hard constraints shape any redesign:

1. **Ingress ≠ execution.** A webhook must reply in <10s (GitHub retries
   otherwise), and the **fleet runner must stay where the repos + model keys
   live** — it needs the local `.git`, the sandbox (`packages/core/src/exec`),
   and provider keys. The receiver can only *enqueue*; it must never run agents.
   The current code already splits this way (`server.ts` enqueues;
   `FleetJobRunner` drains), so the split is natural.
2. **Local-first must survive.** BrainRouter's default is a zero-infra desktop /
   CLI tool. A public webhook needs an always-on HTTPS endpoint a NAT'd desktop
   cannot provide, so a hosted service can only be **additive**, never the only
   path.

This mirrors how Claude Code's own Code Review GitHub App works (one App per org,
a hosted receiver, owner-gated config, short-lived per-installation tokens).

## Decision

Target **both**: keep the in-process local-first receiver as the default, and add
an optional hosted "team mode." Deliver in three phases; each ships value alone.

### Phase 1 — a single GitHub App bot (IMPLEMENTED, 0.4.17)

Replace the per-workspace PAT for the trigger post-back with a single GitHub App
(`brainrouter[bot]`) authenticating via **short-lived per-installation tokens**.

- `packages/core/src/track/githubSync/githubApp.ts` — dependency-free
  (`node:crypto` RS256, no `jsonwebtoken`): `buildAppJwt` (pure, ~9-min App JWT),
  `resolveInstallationId` + `mintInstallationToken` (one injected-`fetch` REST
  call each), `createInstallationTokenCache` (per-installation cache, refresh 5
  min before expiry), `loadGithubAppCredentials` (inline PEM or `privateKeyPath`).
- Config: `cli.triggers.githubApp` (`appId`, `privateKey` | `privateKeyPath`,
  `installationId?`, `apiBase?`) — no new `BRAINROUTER_*` env vars.
- Wiring: `defaultPostComment` prefers `resolveAppInstallationToken(repo)` and
  **falls back to the PAT** when no App is set or a mint fails — so local-first is
  untouched. The desktop config scrubber (`electron/host/helpers.ts`) strips the
  App private key like the other write-only trigger secrets.

Value on its own: one synced bot identity, per-repo scoped short-lived tokens,
no infra change.

### Phase 2 — thin hosted ingress microservice (PROPOSED)

Extract `server.ts` + `resolvers/github.ts` into a **stateless** webhook service
on the existing brainrouter HTTP server (`brainrouter/src/index.ts` already runs
`--http` with `/api/*` + JWT). It only: verify → parse @mention/rules → **enqueue
into a shared queue** → post the courtesy comment. It never executes a job.
Runners (desktop / CLI / worker) poll the shared queue for *their tenant's* jobs.
The queue moves from the local `~/.brainrouter/fleet/jobs.json` to Postgres (the
store is already on `pg`). This is what makes ONE public webhook URL + ONE App
installation possible instead of N loopback receivers.

### Phase 3 — tenancy + RBAC (PROPOSED, ships with Phase 2)

Introduce the account/tenant model on the existing JWT `/api/auth`, map a GitHub
App installation → tenant, and gate configuration (enabled repos, trigger modes,
who-may-change) behind an owner/admin role — mirroring Claude's "Owner enables
per org, per-repo behavior."

## Consequences

- **Positive.** One bot, one webhook config, short-lived scoped tokens (better
  security than broad PATs), a single place + role to configure. Phase 1 lands
  the identity win with zero infra.
- **Cost / risk.** Phases 2–3 turn trigger automation into a hosted service:
  a public endpoint, HA, tenant→runner routing, and **custody of the App private
  key** (backend-only for cloud — never shipped to a desktop; `privateKeyPath`
  keeps it out of `config.json` even locally). A shared bot is a shared blast
  radius: per-installation tokens + key rotation are mandatory.
- **Compatibility.** The local-first in-process receiver + PAT path remain the
  default and are unchanged; the App and the hosted service are strictly opt-in.

## Alternatives considered

- **GitHub Action instead of a webhook** — no inbound endpoint, but loses the
  live fleet queue + the durable in-process runner, and can't share one bot
  identity cleanly. Rejected as the primary path (could be a future no-infra
  fallback for pure local users).
- **Keep per-user PATs, just centralize the webhook URL** — doesn't solve the
  "many bots" problem and keeps long-lived broad tokens. Rejected.
