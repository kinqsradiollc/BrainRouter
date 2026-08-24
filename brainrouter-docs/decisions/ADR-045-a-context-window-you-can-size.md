# ADR-045 — A context window you can size, and a ceiling you cannot cross

**Status:** IMPLEMENTED (0.4.22) — M1 cli.contextWindows knob, M2 desktop editor, M3 per-org cap advertised in the gateway /v1/models, M4 client honors the advertised cap (contextWindowFor clamps to it), M5 the legacy contextWindows.json retired (migrated into the knob at boot). All milestones shipped. · **Builds on:** ADR-041 (plug-and-play runtime —
the config/provider seams and the golden-rule that every knob lives in `cli.*`), ADR-010/017 (org /
team / RBAC tenancy), and the per-org recall-settings pattern (`system_settings` KV +
`/api/admin/recall-settings`). · **Supersedes:** nothing.

**Date:** 2026-08-23

> The context window that drives compaction and every per-request assembly is
> `contextWindowForBudget(model)` — a shipped `models.json` table, a live LM-Studio enrichment, a
> hard-coded 128 000 floor, and a hand-edited `~/.config/brainrouter/contextWindows.json` override
> file that **no command and no UI ever writes**. There is no way to set it from the backend config,
> no way to set it from the desktop, and no ceiling a provider can enforce. **Make the window a
> first-class, resolvable setting: settable on the backend (`config.json`) and the desktop
> (Settings), capped for managed models by a server-enforced org/tier ceiling, and clamped for local
> models — all folding to a single `min()` that only ever tightens.**

---

## 1. Where the window comes from today

`contextWindowForBudget(modelId)` (`packages/core/src/context/contextWindow.ts:136`) returns a token
count, falling back to `DEFAULT_CONTEXT_WINDOW = 128_000`. The real resolution, `contextWindowFor`
(`contextWindow.ts:74-107`), is first-hit-wins:

1. `~/.config/brainrouter/contextWindows.json` — exact model id (a flat `{ id: number }` map).
2. the same file, vendor-prefix-stripped (`openai/gpt-5` → `gpt-5`).
3. the live LM-Studio cache (`max_context_length`), when the session booted against that endpoint.
4. the shipped `models.json` table (`ModelEntry.contextWindow`), exact then stripped.
5. `familyFallbacks` regexes.
6. otherwise `undefined` → 128 000.

One value, five consumers, all deriving `window*4` chars / `window` tokens:

- **per-request assembly** — `modelInvocationPhase.ts:90` → `buildRootContextEnvelope` budget (every call).
- **the auto-compact trigger** — `contextPreparationPhase.ts:88` → `min(cli.autoCompactTokens, 0.9×window)`.
- **compaction** — `session.impl.ts:56` (`compactHistory`).
- **child / sub-agent budget** — `orchestration/tools/spawn.ts:489`.
- **the desktop context ring** — `electron/host/queries.ts` (`contextWindowForBudget`).

Two problems this ADR fixes:

- **The one override that exists is an orphan.** `contextWindows.json` is hand-edited only — nothing
  in the product writes it, no desktop control touches it, and it **sidesteps the rule that every
  knob lives in `cli.*` of `config.json`**. A footer hint tells the user to edit a JSON file by hand.
- **There is no ceiling anyone can enforce.** The gateway auth context carries `orgId` + an RBAC
  role and nothing else — **there is no tier concept anywhere** — so a provider cannot cap the window
  a tenant asks a managed model to assemble. The window is whatever the model table says.

The good news, as with ADR-044: the *shapes* this needs already exist. `resolveLocalModelProfile`
(`provider/modelFamily.ts:159`) is a clamp whose invariant is *"a clamp only tightens, never loosens
an already-tighter setting"* (pinned by `local-model-profile.test.ts:71`), and `min(userKnob,
0.9×window)` is already how the auto-compact threshold is computed. This ADR is one resolution
function and three places to set its inputs.

---

## 2. What "set the window" must mean

1. **The backend can set it.** A first-class `config.json` setting, per model, read through
   `getCliKnobs()` — not a hand-edited side file.
2. **The desktop can set it.** A control on the Models settings surface (managed and BYOK), keyed off
   the live `/models` list, writing the same setting.
3. **A provider can cap it.** For managed models, an org/tier ceiling that a tenant setting can lower
   but never raise, enforced **server-side** where the client cannot reach it.
4. **Local models honour it.** The same setting, resolved through the existing clamp so it can only
   tighten below the model's true window (LM-Studio's reported size included).
5. **One discipline binds all four: a ceiling only tightens.** The effective window is never above
   the model's real maximum and never above a tenant's tier cap; a too-small value that cannot hold
   the protected system prompt + latest turn is refused, not silently applied.

---

## 3. Decisions (the part that needs approval)

**D1 · One resolution, `min()` of everything.** Introduce a single resolver — the effective window is

```
requested  = userSetting ?? modelDefault           // the existing contextWindowFor precedence
effective  = min( requested,
                  tierCap      ?? +∞,                // org/tier hard ceiling (managed models)
                  localCeiling ?? +∞ )               // resolveLocalModelProfile-style clamp
```

never above the model's real maximum. `contextWindowForBudget` widens to consult the resolved value
ahead of its existing chain; the five consumers in §1 inherit it unchanged (they already call one
function). The model table stays the default when nothing overrides it — **byte-neutral when unset.**

**D2 · The user setting becomes a real `cli.*` knob — the orphan file is retired.** Add a per-model
map `cli.contextWindows?: Record<modelId, number>` (and an optional global `cli.contextWindowTokens`)
declared through the standard three sites — raw `CliKnobs`, resolved `ResolvedCliKnobs`, a `Record`
sanitizer in `resolveCliKnobs` (the `sanitizeLlmProfiles` pattern) — and exposed for the desktop form.
During a deprecation window the loader reads *both* `contextWindows.json` and the knob, with
`config.json` winning; then the side file is dropped. This ends the golden-rule exception and gives
the setting a real home.

**D3 · The desktop sets it.** A card on the Models settings surface (Managed · BYOK subtabs) lists the
models from `/models` and writes `cli.contextWindows[model]` via the existing `set-cli-knob` /
`set-cli-path` host action. It is a bespoke card, not a schema row — the flat config-schema cannot
express a per-model map. It shows the model's true maximum and the active org cap (if any) as bounds,
so the control cannot be set to a value the resolver would only clamp away.

**D4 · The tier cap is a server-enforced hard ceiling — greenfield, but on the existing pattern.**
Introduce a per-org context cap stored as `contextCap:${orgId}` in `system_settings` (JSONB KV),
served by an admin route cloned from `recallSettings.ts` (`GET/PUT`, gated `requireAnyAuth` +
`requirePermission("providers:manage")`, per-`orgId`), and cached in the engine like
`resolveRecallOverrides`. The blob may carry a `tier` label so a future billing tier can set the cap;
**this ADR establishes the cap mechanism, not a billing system.** Enforcement for managed models is at
the gateway's server-owned-field rewrite — `buildUpstreamChatPayload` (`chatProtocol.ts:197`), the
same chokepoint that already rewrites `model`/`reasoning_effort` and is unreachable by the client.
BYOK and local models cannot be capped by us (the tenant owns the key), but still resolve their own
setting and clamp.

**D5 · Local models resolve through the existing clamp.** `localCeiling` is produced the
`resolveLocalModelProfile` way (`min(base, ceiling)` per cap, never loosening), and LM-Studio's live
`max_context_length` remains a source of the model default. A user's tighter setting always wins over
a larger reported window.

**D6 · Misconfiguration fails loud; a window too small is refused.** A knob value is validated as a
positive finite integer and clamped to `[floor, modelMax]`. The floor is the size below which the
protected layers (system prompt + latest user turn) cannot fit — the resolver ties into the
envelope's existing `cannot-fit` result (`context/envelope/compaction.ts`) rather than shipping a
window that guarantees an unrecoverable turn.

---

## 4. What this is not

- **Not a way to exceed a model's real window.** The resolver only tightens; the model maximum is the
  hard upper bound.
- **Not a billing / entitlement system.** D4 builds the *cap mechanism* and a `tier` label; wiring a
  cap to a paid tier is a separate decision.
- **Not a rate limit.** Request rate is the gateway rate-shaper's job (concurrency / rpm); this is
  input-window size, a distinct concern.
- **Not a per-message or per-turn override.** The setting is per model (and per org for the cap), not
  a knob the model can change mid-conversation.
- **Not an output-token cap.** `maxOutputTokens` already governs completion length; this is the input
  context window.

---

## 5. Dependency-ordered delivery board

Each row is one pull request. M1 stands alone and is the whole backend story; the rest are additive.

- **M1 — the resolver + the backend setting.** `resolveContextWindow` (the `min()` of D1), the
  `cli.contextWindows` knob (three-site + sanitizer), and `contextWindowForBudget` consulting it.
  Byte-neutral when unset. *This is the "backend can set the window" requirement, complete.*
- **M2 — the desktop control.** The Models-settings card (managed + BYOK), writing the same knob,
  bounded by the model max and the org cap.
- **M3 — the server cap.** `contextCap:${orgId}` in `system_settings`, the admin route + engine cache,
  and the `buildUpstreamChatPayload` clamp for managed models.
- **M4 — the tier label + managed default.** A `tier` field on the cap blob and a managed-model
  context-window default (a new field on the managed-model record, which has none today).
- **M5 — retire the orphan.** Migrate `contextWindows.json` readers to the knob and remove the side
  file + its footer hint.

---

## 6. How this will be judged

1. **Backend set, lowered.** Set `cli.contextWindows["<model>"] = 32000` on a model whose real window
   is larger; take a long turn. Compaction must fire **earlier** (the auto-compact threshold is now
   `min(autoCompactTokens, 0.9×32000)`), and the per-request envelope budget must be 32 000 — both
   observable in the context ring and the request trace.
2. **Set above the max, clamped.** Set the knob to a value above the model's true window; the
   effective window resolves to the model max, not the inflated number.
3. **Org cap wins, server-enforced.** With an org cap below a tenant's setting, the effective window
   for a managed model is the cap — and a request crafted to ask for more is clamped at the gateway,
   not honoured. A client cannot raise its own ceiling.
4. **Local honours the tighter value.** A local model reporting a large `max_context_length` still
   uses the user's smaller setting.
5. **Too small is refused.** A window below the protected-layer floor is rejected at config time with
   a clear reason, never shipped as a turn that cannot fit its own system prompt.
