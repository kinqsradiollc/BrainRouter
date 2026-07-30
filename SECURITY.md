# Security Policy

## Supported versions

BrainRouter ships a shared runtime and public packages plus the desktop, CLI,
brain service, and dashboard applications. Security fixes land on the current
minor (`0.4.x`). Older minors are not routinely backported; upgrade to the
latest patch to stay covered.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (<https://github.com/kinqsradiollc/BrainRouter/security/advisories/new>).
2. Describe the issue, affected component (desktop, CLI, brain/MCP server,
   dashboard, connector, review runtime, or a published package), and a minimal
   reproduction.

We aim to acknowledge a report within a few days and to ship a fix or mitigation
before any public disclosure. Please give us a reasonable window to remediate.

## What's in scope

- The MCP/HTTP server (`brainrouter/`) — auth, the REST API, MCP tool handlers.
- The CLI agent (`brainrouter-cli/`) — sandboxing, command approval, patch
  application, federation.
- The desktop app (`brainrouter-desktop/`) — Electron boundaries, local tool
  permissions, account integration, and renderer/host IPC.
- The dashboard (`brainrouter-dashboard/`) — auth flows and data exposure.
- OAuth connectors, webhook ingress, review/pentest automation, and the
  published runtime/SDK/types packages.

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
  user and active organization. Organization RBAC gates management/review
  capabilities; project membership and workspace/source scope narrow data
  further. Cross-user and cross-organization access is rejected.
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
- **Secrets** — provider, integration, and connector credentials are sealed at
  rest with `BRAINROUTER_SECRET_KEY`. Provider/OAuth secrets are write-only and
  never returned by status/read APIs. Account OAuth authorizes outbound API
  calls; separately configured signing secrets verify inbound webhook payloads.
- **Connector egress** — server-side connector sync injects sealed credentials
  into bounded provider clients. Constrained proxy routes validate provider
  hosts and allowed paths instead of forwarding arbitrary URLs.
- **Storage** — all SQL is parameterized; schema migrations use fixed internal
  identifiers, never request input.

## Dependency hygiene

Run `npm audit` from the workspace root and inspect the production dependency
tree before release. Do not copy a stale advisory exception forward: record the
exact affected version/path, reachability, mitigation, and removal condition in
the release review when an advisory cannot be fixed immediately.

Security and code-review agents consume bounded context from BrainRouter's
persisted CVE catalog and exact organization/repository inventory matches. NVD,
CISA KEV, FIRST EPSS, and OSV content is treated as untrusted reference data,
carries source/freshness metadata, and never overrides repository evidence or
agent policy. Catalog presence, product-name text, or a CVE mentioned in a diff
does not by itself establish exposure.
