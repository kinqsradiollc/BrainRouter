# ADR-047 — Providers as data, agents as engines, playbooks you can hand someone, and a vetted install

**Status:** ACCEPTED — approved by the owner (2026-08-24); not yet implemented. · **Builds on:** ADR-041 (the live
`ProviderRegistry` (D1), opt-in native wire adapters (D2), the external-agent subagent providers of
parity wave W3, and the product-wide registry discipline), the plugin/marketplace system
(`packages/core/src/plugin/`), the schedule runtime, and the skills + workflows surfaces. ·
**Informed by:** a study of a widely-adopted open-source agent harness (2026-08); no external
project is named or copied — this ADR adopts *shapes*, grounded in our own code. ·
**Supersedes:** nothing.

**Date:** 2026-08-24

> A comparison against a studied reference harness found four capability gaps that are cheap for us
> precisely because the seams they need already shipped: (1) adding an OpenAI-compatible provider
> requires a **code module**, where a data file should do; (2) an installed coding-agent CLI can
> already run as a *subagent worker* but not as the **model engine** of the main loop; (3) our
> automation pieces — skills, schedules, workflows, model profiles — cannot be **packaged into one
> parameterized, schedulable, shareable unit**; (4) a plugin installs with **no vetting** — no
> allowlist hook, no advisory-database check. Four decisions close them. Bundled local inference is
> an explicit non-goal — endpoint-based local models (LM Studio, Ollama) remain our local story.

---

## 1. Where the code is today

- **Providers are code.** Every provider is a directory module registered in `BUILTIN_PROVIDERS`
  (`packages/core/src/provider/providers/index.ts:29` — "write a `ProviderDefinition`, then register
  it below"). The catalog is live and mutable at runtime (ADR-041 D1), but *adding* the twentieth
  OpenAI-compatible vendor still means a new code directory, a barrel edit, and a release — for what
  is, in substance, a name, an endpoint, an env-key, and a wire format. The `openai-compatible`
  module already proves the shape is generic.
- **Agents are workers, not engines.** ADR-041 W3 shipped external-agent subagent providers —
  external CLI agents run as *workers* over the `SubprocessPort` seam, on the interrupt cascade
  (`packages/core/src/orchestration/tools/registry.ts:34`). But the **main loop's** model slot still
  only accepts an API-shaped provider. A user whose seat is a coding-agent subscription (rather than
  an API key) can delegate to it, but cannot *drive with* it.
- **Automation is real but unpackaged.** We have skills (`brainrouter-cli/src/prompt/skillCatalog.ts`),
  durable schedules with a ticker (`brainrouter-cli/src/runtime/background/scheduleTicker.ts`),
  deterministic workflows (`run_workflow`), and named model profiles (`cli.llmProfiles`). What we do
  not have is the composite: *one artifact* that binds a prompt/skill to typed parameters, a model
  profile, a tool/extension set, and an optional schedule — and that can be handed to a teammate or
  installed from a marketplace.
- **Plugins install unvetted.** The marketplace system exists end-to-end
  (`packages/core/src/plugin/marketplace.ts`, `update.ts`; `brainrouter-cli/src/entry/pluginCommand.ts`)
  with manifest validation and atomic install — but nothing between "resolve" and "install" asks
  *should this org allow this plugin at all* or *does an advisory database know something about it*.
  The studied harness gates extension installs on an org-controlled allowlist URL and an open
  vulnerability/malware advisory lookup; we gate on schema validity only.

---

## 2. Decisions (the part that needs approval)

**D1 · Declarative providers — a provider catalog you extend with data, not code.** Introduce a
data-defined provider entry (name, endpoint, env-key, wire format, model-listing route, quirk flags)
loaded into the same live `ProviderRegistry` as the code modules — the code path stays for providers
with real behavioral differences; the data path covers the long tail of OpenAI-compatible vendors.
Ship a starter set as packaged data files, let users add entries in config, and keep the golden rule:
model *lists* still come from each endpoint's `/models`, never hardcoded. Misdeclared entries fail
loud at load (ADR-041 discipline). *Acceptance: add a new OpenAI-compatible vendor with zero code
changes and route a turn through it.*

**D2 · Agents as engines — the W3 seam promoted to the model slot.** An installed coding-agent CLI
becomes selectable as the main loop's engine: a provider whose `ProviderDefinition` fronts the
existing external-agent adapter instead of an HTTP API — the same `SubprocessPort` execution, the
same interrupt cascade, surfaced through the normal model picker. Scope honestly: engine-mode agents
support the capabilities they support (streaming text, tool pass-through where their protocol allows
it) and *declare* what they cannot; the router treats them as uncached explicit picks
(`withFallbacks:false` semantics) so the fallback chain never silently swaps a subscription seat for
an API bill. *Acceptance: pick an installed agent CLI as the model, run a turn with a tool call, Stop
interrupts it.*

**D3 · Playbooks — one packaged, parameterized, schedulable automation unit.** A `playbook` is a
single typed artifact: a prompt or skill reference + declared parameters (typed, prompted-for or
passed) + a model profile + a bounded tool/extension set + an optional schedule + an optional
structured-output schema for its result. Running one composes surfaces that already exist (skill
runner, `llmProfiles`, tool policy, the schedule ticker, workflows for multi-step bodies) — the
decision is the *artifact and its lifecycle*, not new machinery: create → run (`/playbook run name
--param x=y`) → schedule → share (a file today; the plugin marketplace as the distribution channel,
D4-vetted). Playbook output lands on the completion inbox like any background run. *Acceptance: one
playbook file runs parameterized on demand and on a schedule, and installs from a marketplace
manifest.*

**D4 · A vetted install — allowlist + advisory check at the plugin gate.** Two hooks in the existing
install path (between resolve and install, `plugin/marketplace.ts`): (a) an optional org **allowlist**
— when configured (per-org on the server, mirroring the recall-settings pattern; a `cli.*` knob
locally), only listed plugins/marketplaces install, and the refusal names the policy; (b) an
**advisory lookup** against an open vulnerability/malware database for the plugin's distribution
(best-effort, fails *open* by default with a warning, fails *closed* when the org policy says so).
Both apply to playbook installs (D3) since playbooks ship through the same channel. No new
infrastructure — a fetch to an existing public advisory API plus one policy read. *Acceptance: an
org with an allowlist cannot install an unlisted plugin; a plugin with a known advisory warns (or
blocks, per policy) with the advisory cited.*

---

## 3. What this is not

- **Not bundled local inference.** The studied harness ships llama.cpp/MLX in-process; we explicitly
  do not (owner decision, 2026-08-24). Local models remain endpoint-based — LM Studio and Ollama are
  already first-class providers, and the context-window work (ADR-045) already honours their live
  metadata. Revisit only if endpoint-based local proves insufficient.
- **Not a protocol migration.** The reference harness is protocol-first (one agent protocol for all
  surfaces). Ours share `packages/core` in-process; adopting an external agent protocol is a separate
  architectural decision this ADR deliberately does not open.
- **Not a fallback change.** D2 engines are terminal picks; the router never fails over *to* or
  *from* a subscription engine implicitly.
- **Not a new automation runtime.** D3 composes the skill runner, schedules, workflows, and profiles
  that exist; if a playbook needs machinery none of them have, that is a gap in *them*, not a reason
  for a parallel engine.
- **Not a marketplace redesign.** D4 adds two checks to the existing install path; discovery,
  manifests, and atomic install stay as shipped.

---

## 4. Dependency-ordered delivery board

Each row is one pull request; rows are independent except P4a→P4b.

- **P1 — Declarative provider entries** (D1): the data shape + loader into `ProviderRegistry` +
  packaged starter set + config-defined entries + load-loud validation.
- **P2 — Engine-mode external agents** (D2): `ProviderDefinition` fronting the W3 adapter, model-picker
  surfacing, capability declaration, router terminal-pick semantics.
- **P3 — The playbook artifact** (D3): typed schema + `/playbook` create/run/schedule + completion-inbox
  landing; marketplace packaging follows P4.
- **P4a — Allowlist gate** (D4): org/server + local policy read in the install path, named refusals.
- **P4b — Advisory lookup** (D4): best-effort advisory fetch, warn/block per policy, cited findings.

---

## 5. How this will be judged

1. A new OpenAI-compatible vendor goes from "not supported" to "routing turns" by adding **one data
   entry** — no TypeScript, no release.
2. A user with only a coding-agent subscription (no API key) completes a tool-using turn with that
   agent as the **engine**, and Stop lands.
3. A playbook written by one user runs — parameterized, then scheduled — on another user's machine
   after a marketplace install, and its result arrives on the completion inbox.
4. An org that allowlists two plugins finds every other install refused **by name of the policy**,
   and a plugin with a published advisory cannot install silently.
