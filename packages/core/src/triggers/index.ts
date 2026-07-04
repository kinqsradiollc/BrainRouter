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
// bounded+redacted raw-payload persistence. MC-B3 adds the per-workspace
// automation-rule registry (`.brainrouter/automations/*.md`, on/when/do) that
// routes verified events to actions. MC-B2 wires the GitHub resolver
// (label/@mention → fleet job with PR-emit delivery → comment back, with a
// persisted delivery-id redelivery cache); MC-B7 registers gitlab/jira
// adapters behind the same registry.
export * from './triggerTypes.js';
export * from './registry.js';
export * from './allowlist.js';
export * from './eventStore.js';
export * from './server.js';
export * from './rules.js';
export * from './postback.js';
export * from './providers/gitlab.js';
export * from './providers/github.js';
export * from './providers/jira.js';
export * from './providers/slack.js';
export * from './resolvers/external.js';
export * from './resolvers/github.js';
export * from './resolvers/slack.js';
// MC-B4 — proactive CI-failure nudge (workflow_run failure on an open PR →
// one idempotent offer-to-fix comment that loops back through the mention
// path). Gated behind `cli.triggers.ciNudge` (default false).
export * from './ciNudge.js';
// MC-B6 — suggested-tasks scanner (read-only REST scan: failing checks /
// merge conflicts / review threads awaiting the author / labeled issues →
// one-click starters with a ready-to-run prompt).
export * from './suggestedTasks.js';
