// Public entrypoint for the `triggers` subsystem (MC-B1) — the inbound
// automation ingress: external webhook deliveries → per-provider signature
// verification (mandatory, fail-closed) → neutral `TriggerEvent`s → an
// injectable sink. Consumers import `@kinqs/brainrouter-core/triggers`; the
// file layout stays an internal detail.
//
// MC-B1 ships the opt-in node:http listener (`brainrouter serve --triggers`,
// default-deny via `cli.triggers.enabled`), the provider registry with the
// built-in GitHub adapter (`X-Hub-Signature-256`, HMAC-SHA256, timing-safe),
// the `owner/name` glob repo allowlist (default empty = nothing allowed) and
// bounded+redacted raw-payload persistence. MC-B2 wires the GitHub resolver
// (label/@mention → fleet job → PR-emit); MC-B7 registers gitlab/jira
// adapters behind the same registry.
export * from './triggerTypes.js';
export * from './registry.js';
export * from './allowlist.js';
export * from './eventStore.js';
export * from './server.js';
export * from './providers/github.js';
