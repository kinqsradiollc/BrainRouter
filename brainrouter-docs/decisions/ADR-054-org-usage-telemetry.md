# ADR-054 — Org usage telemetry (the priced per-automation dashboard view)

**Status:** IMPLEMENTED (0.4.22) — P1 the bounded aggregate + priced view (`mergeOrgUsage`/`priceOrgUsage`), P2 the ingest route + opt-in `cli.usageTelemetry` + best-effort client push, P3 the `/api/admin/usage-automation` route + the dashboard `UsageAutomationPanel`. Satisfies ADR-052 §5.3. · **Builds on:** ADR-052 D2 (P2a per-automation
attribution `readAutomationUsage`, P2b `orgPricingSettings` / `effectiveModelRate`), the
`system_settings` KV pattern, and the admin RBAC middleware. · **Unblocks:** ADR-052 §5.3 — "the
dashboard names the automation behind any token spike, priced at the org's real rates." · **Informed
by:** the gap found completing ADR-052 P2a; no external project is named or copied.

**Date:** 2026-08-31

> ADR-052 P2a made per-automation attribution real — but it lives in the CLI's **local** usage store
> (`readAutomationUsage`), surfaced in the CLI `obs` view. §5.3's acceptance is a **dashboard** view
> at the org's contracted rates, and the dashboard/brain server never sees that local usage. This
> ADR decides the small telemetry pipe that carries per-automation token aggregates to the server,
> and the priced view that reads them — reusing P2b's pricing so "at the org's real rates" is free.

---

## 1. Where the code is today

- **Attribution is local.** `recordDailyUsage` (`packages/core/src/usage/`) writes per-day,
  per-automation token totals to a workspace-local file; `readAutomationUsage` reads them; the CLI
  `obs` command shows them. The brain server has none of it.
- **Pricing already resolves per org.** ADR-052 P2b's `effectiveModelRate(settings, model, listIn,
  listOut)` turns list price into the org's contracted rate. A priced view needs only token totals +
  this function.
- **The server already stores small per-org blobs.** The `system_settings` KV
  (`emailAuth.getSetting/setSetting`) holds `recallSettings:<org>`, `pricingSettings:<org>`, etc.
  A per-org usage aggregate is the same shape.

---

## 2. Decisions

**D1 · A per-org usage aggregate, server-side.** The server keeps a compact per-org, per-automation
token aggregate (prompt/completion tokens, calls, turns, and the dominant model) under
`usageAutomation:<orgId>` in the `system_settings` KV — bounded (top-N automations, a rolling
window), so it never grows without limit. A pure `mergeOrgUsage(existing, delta)` folds a pushed
delta into it; `priceOrgUsage(aggregate, pricing, listRates)` turns it into per-automation
`{ tokens, estCostUsd }` at the org's contracted rate via `effectiveModelRate`. Both pure and
unit-tested.

**D2 · A thin telemetry pipe, best-effort and opt-in.** The client (agent/CLI meter) POSTs its
per-automation delta to `POST /api/usage/automation` on flush — authed, small, and **best-effort**:
a failed push never affects a turn (usage is advisory, not a correctness path). Gated by a knob
(`cli.usageTelemetry`, default off) so a self-hosted or privacy-sensitive deployment sends nothing.

**D3 · The priced dashboard view.** `GET /api/admin/usage-automation` (RBAC `providers:manage`)
returns the org's per-automation totals priced through P2b's settings; a dashboard panel renders the
table, so a runaway loop is identifiable by name **and** by cost at the org's real rates — §5.3.

---

## 3. What this is not

- **Not a metrics platform.** A bounded per-org aggregate answers "which automation, how much, what
  cost" — not arbitrary time-series analytics. A real warehouse is a separate decision.
- **Not spend enforcement.** This is attribution + truthful pricing (ADR-052's stance); budgets that
  *stop* work are out of scope.
- **Not always-on.** Telemetry is opt-in; the CLI `obs` view remains the zero-egress local answer.
- **Not per-request PII.** Only token counts, an automation id, and a model id leave the client —
  never prompt or completion content.

---

## 4. Delivery board

- **P1 — The aggregate core** (D1) — ✅: `mergeOrgUsage` + `priceOrgUsage` (pure, bounded), unit-tested.
- **P2 — The pipe** (D2) — ✅: `POST /api/usage/automation` ingest + the `cli.usageTelemetry` knob + the
  best-effort client push on flush.
- **P3 — The priced view** (D3) — ✅: `GET /api/admin/usage-automation` + the dashboard panel.

---

## 5. How this will be judged

1. A loop that burns tokens shows up in the dashboard **by automation name**, with a cost computed at
   the org's contracted rate — ADR-052 §5.3.
2. A telemetry push that fails (offline, server down) never fails or slows a turn.
3. With `cli.usageTelemetry` off, the client sends nothing and the CLI `obs` view still works.
4. The server aggregate stays bounded no matter how many automations report.
