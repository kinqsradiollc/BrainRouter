# Security Policy

## Supported versions

BrainRouter ships as four npm packages (`@kinqs/brainrouter-cli`,
`@kinqs/brainrouter-mcp-server`, `@kinqs/brainrouter-sdk`,
`@kinqs/brainrouter-types`) plus the in-repo dashboard. Security fixes land on
the **current minor** (`0.4.x`) and are published together. Older minors are not
backported — upgrade to the latest patch to stay covered.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (<https://github.com/kinqsradiollc/BrainRouter/security/advisories/new>).
2. Describe the issue, affected component (MCP server, CLI, dashboard, or a
   published package), and a minimal reproduction.

We aim to acknowledge a report within a few days and to ship a fix or mitigation
before any public disclosure. Please give us a reasonable window to remediate.

## What's in scope

- The MCP/HTTP server (`brainrouter/`) — auth, the REST API, MCP tool handlers.
- The CLI agent (`brainrouter-cli/`) — sandboxing, command approval, patch
  application, federation.
- The dashboard (`brainrouter-dashboard/`) — auth flows and data exposure.
- The published SDK/types packages.

Out of scope: issues that require a pre-compromised host, a malicious local
operator with filesystem access, or a self-hosted misconfiguration that the
documented defaults do not produce.

## Server hardening (HTTP API)

The MCP server's HTTP surface is defense-in-depth by default:

- **Authentication** — every `/api/*` router requires a valid session
  (JWT or API key); admin-only routers additionally require an admin claim. The
  JWT secret is **fail-closed**: in production the server refuses to boot on the
  development fallback secret.
- **Authorization / scoping** — reads and writes are scoped to the authenticated
  user; cross-user access is rejected.
- **Input validation** — a shared `validate()` middleware (zod) rejects
  malformed input with a structured `400` before it reaches a handler.
- **Transport headers** — `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, a restrictive `Permissions-Policy`, `frame-ancestors`
  CSP, `Cross-Origin-Resource-Policy`, and HSTS in production.
- **CORS** — a strict origin allowlist (configurable via
  `BRAINROUTER_CORS_ORIGIN`); only allowed origins are reflected, disallowed
  preflights get a `403`.
- **Rate limiting** — a strict per-IP limit on credential endpoints plus a
  generous global limit across `/api` (tunable via
  `BRAINROUTER_RATE_LIMIT_MAX` / `BRAINROUTER_RATE_LIMIT_WINDOW_MS`).
- **Request-body limit** — JSON bodies are bounded (default 16 MB, configurable
  via `BRAINROUTER_MAX_BODY_SIZE`); overflow returns a clean `413`.
- **Error handling** — one terminal handler emits a consistent `{ error, code }`
  envelope and never leaks a stack trace or internal message to clients in
  production.
- **Secrets** — API keys are returned only to their authenticated owner (at
  signup / signin / key rotation) or to an admin performing a reset; they are
  never echoed on repeated reads such as `GET /api/auth/me`.
- **Storage** — all SQL is parameterized; schema migrations use fixed internal
  identifiers, never request input.

## Dependency hygiene

`npm audit` runs clean for the server and published packages. One known
advisory persists in the **dashboard build toolchain only**:

- **`postcss < 8.5.10`** (GHSA-qx2v-qp2m-jg93, moderate) is pulled transitively
  by `next`, which pins it exactly. PostCSS runs at **build time** on the
  dashboard's own stylesheets and never processes untrusted input or ships to
  the browser bundle, so it is **not exploitable** in this project. It does not
  affect the server or any published package. We will drop the pin once Next.js
  relaxes its `postcss` constraint or ships a patched release.
