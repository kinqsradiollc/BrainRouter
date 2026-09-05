# ADR-056 — Maps with receipts, and a design gate the agent cannot skip

**Status:** ACCEPTED — implemented on `release/0.4.22` as small stacked PRs (2026-09-05). Merged: A1–A4, B1, B3, B9. In review: A5–A8, B2, B4–B6, B8, and the deterministic half of B7; B7's desktop pick-and-cycle loop is left for an owner-attended first run, as D-B5 requires. Board rows below carry their PR and state. Every "today" claim in §1 was grounded when written and is now history.
in the code paths cited, every "decision" is a proposal. · **Builds on:** ADR-048 (the Atlas graph
the agent reads — this record gives it an *authored* output), ADR-031 (a design skill and the
`frontend` capability it belongs to — this record gives it a deterministic half), ADR-036 (the
finding carries its code — design findings ride the same card), ADR-033 (review lenses — the
architecture delta and the design checks become review *evidence*, not new lenses), ADR-046 (the
runtime vouches for itself — diagrams and design checks emit receipts in that vocabulary), ADR-049
(workspace-scoped artifacts under `.brainrouter/` — the pattern reused for pinned diagrams and
critique snapshots), ADR-055 (the complete browser — live variants and the computed-style engine run
on it), ADR-041 (how a builtin tool, hook, and command are registered). · **Informed by:** a study of
two contemporary open-source tools — an interactive architecture-map renderer that compiles a typed
JSON specification into validated, self-contained HTML with revision-pinned source evidence and
before/after deltas, and a frontend design-quality skill that pairs a command vocabulary with a
deterministic anti-pattern detector, an edit-time hook, and live in-browser variant iteration. No
external project is named or copied; every gap below is stated against our own code. ·
**Related:** `brainrouter-rules/09-docs-skills-and-plugins.md` §7b–7c (the design-skill boundary and
the `design.md` seam — amended by D-B4/D-B6), `brainrouter-rules/06-desktop-and-dashboard.md` §9
(the desktop's own visual contract — explicitly *not* governed by this record).

**Date:** 2026-09-05

> BrainRouter already knows a codebase's shape (Atlas: files, symbols, imports, layers, a tour, a
> blast-radius block the reviewer reads) and already carries a design skill that stops a model from
> emitting the template it was trained into. Both stop one step short. Atlas is an *extracted*
> graph a human opens in one desktop panel; the agent cannot hand anyone a curated, checked,
> shareable map of "how this system works", and a PR that moves a boundary shows up as a diff, not
> as a before/after of the architecture. The design skill is prose the model grades itself against;
> no rule runs without a model, nothing runs when a UI file is edited, and the desktop's real
> Chromium — which can already see, snapshot, and act on a page — is not used to iterate on one.
> This record decides two things: **a diagram is a typed, validated, receipted artifact with
> repository evidence**, produced by the agent from Atlas and delivered to every surface; and
> **design quality has a deterministic half** — a rule engine, a hook, and a browser-backed
> critique — that the model cannot talk its way past.

---

## 1. Where the code is today

| Capability | Today | Gap this record closes |
|---|---|---|
| Codebase graph | `packages/core/src/atlas/` builds `AtlasGraph` (`file:`/`function:`/`class:` nodes, `contains`/`imports` edges, LLM-enriched `summary`, `layers`, `tour`, layer→layer relationships); the desktop `panels/atlas` renders it with `@xyflow/react` + `d3-force` (search, layer filter, tour, impact); `atlas_context` and the ADR-048 taps feed the agent; `buildAtlasChangeContext` writes a text blast-radius block into the code-review prompt | The graph is a *measurement* (2,000+ nodes) and lives in one desktop panel. There is no **authored** artifact — a 8–12-node system story with boundaries, one main path, sequences, data flows, lifecycles — no portable file (HTML/SVG/PNG), no validation that what is drawn is true at a revision, no CLI or dashboard surface, and no architecture *delta* for a PR |
| Diagrams the agent can draw | `skills/design/concept-diagrams` (flat SVG for textbook-style visuals; its own scope note says software architecture belongs elsewhere); Mermaid fences render in the desktop Artifacts panel and the dashboard working-memory page (`Mermaid.tsx`) | Free-hand SVG/Mermaid carries **no evidence, no schema, no receipt**, and its layout is whatever the renderer of the day does. Nothing checks that "API → Redis → Postgres" is a relationship the code has |
| Design skill | `skills/design/hallmark` (ADR-031): default build verb + `audit` (anti-pattern punch list) + `redesign` + `study` (emits a portable `design.md`); attached to the `frontend` capability; `design.md` read at `design.md` → `.brainrouter/design.md` → `docs/design.md` and injected as neutralised data (§7c). Seven further *style* skills under `skills/design/*` (brutalist, minimalist, soft, gpt-taste, taste, stitch, redesign) exist as parallel, partly contradictory rulebooks, and the `design` profile's `skills.enabled` list (`profiles.ts`) still names `taste-skill`/`redesign-skill`/`output-skill` although its pack (`profilePlugins.ts`) already names only `hallmark` | **Every check is the model grading its own output.** No deterministic rule engine (rule ids, severities, suppressions, CI mode), no edit-time hook, no two-assessment critique, no scored technical audit, no product-truth artifact beside the visual one, and a routing problem: eight design skills with no single entry point, and two lists that disagree about which are on |
| Hooks | `packages/core/src/hooks/hooksStore.ts` — `pre-tool`, `post-tool`, `pre-turn`, `post-turn`, `user-prompt-submit`, `pre-compact`, `session-start`, `session-end`, `stop`; hookify `.md` guards; plugins may carry `hooks/hooks.json` (`plugin/discovery.ts`) | The events exist; **no built-in hook runs a design check after an Edit/Write of a UI file**, and nothing carries findings into the next turn the way ADR-048's blast radius does |
| Review | Lenses `code` / `security` / `pentest` (`reviewLens.ts`); findings carry `code_excerpt`/`replacement` (ADR-036) and render in the desktop `ReviewPanel`, the dashboard `ReviewCodeFrame`, and PR inline cards; the bot runs deterministic producers beside the model (ADR-039 seam) | No **deterministic design producer** on changed UI files and no **architecture delta** producer; both would ride the existing evidence seam at zero model cost |
| Browser | ADR-055: main-owned Chromium tabs, 40 `browser_*` tools, vision (`cli.browser.vision`), snapshot v2 with shadow DOM, `page.find`, action receipts, human hand-back | Nothing uses it to **iterate on a page's design** (pick an element, generate N variants, accept one) or to run **computed-style checks** (contrast, overflow, occlusion) that static parsing cannot see |
| Prototypes | `packages/core/src/prototype/` — async HTML prototype written incrementally, rendered by the desktop in a sandboxed `<webview>` once byte-stable | The same surface can render a diagram artifact; nothing measures a *built* page against the prototype it was meant to reproduce |
| Internal visual gates | `brainrouter-desktop/scripts/planner-visual-gate.mjs`, `verify-visual-release.mjs`, the style contract in rules 06 §9 | Internal to BrainRouter's own surfaces by design — **not** a user-facing capability and not to become one (§3) |
| Distribution | Root `skills/` library shipped by generated copy (ADR-031 D2), plugin manifests with hooks, HTTP marketplaces (ADR-053), command-catalog parity between CLI and desktop (`command/parity.ts`) | The seams a new skill, hook, tool, and slash command need already exist — this record adds no packaging format |

---

## 2. Decisions

The record has two tracks. They share nothing at the code level and are stated together because
they share a premise: **a claim the model makes about structure or quality must be checkable by a
program, and the check must produce a receipt the surfaces can show.**

### Track A — Maps with receipts

**D-A1 · A diagram is a typed artifact, not a picture.** A new core subsystem
`packages/core/src/diagram/` owns a JSON intermediate representation with five kinds —
`architecture` (components, boundaries, connections), `workflow` (lanes, phases, nodes, edges),
`sequence` (participants, messages, activations), `dataflow` (stages, nodes, flows), `lifecycle`
(states, transitions) — each with a JSON schema in `packages/types` (`schema_version`,
`additionalProperties: false` at every level, a fixed component vocabulary
`frontend | backend | database | cloud | security | messagebus | external`). Every node and edge
may carry `sources[]` — `{ path, lines?, revision }` — and an `authored | verified` flag. The IR is
the unit of storage, diff, and review; HTML/SVG/PNG are *renderings* of it.
*Acceptance:* a document with one unknown field fails validation with a path-prefixed diagnostic;
fixtures for all five kinds round-trip; the schema is served in the runtime catalog (ADR-046 S6).

**D-A2 · Rendering is deterministic and self-contained.** `renderDiagram(ir, { theme })` compiles
the IR to one HTML file with inline SVG, dark/light themes from tokens, pan/zoom, search, focus,
and relationship tracing implemented in the file — **no network, no external runtime, no viewer
state in the canonical export**. The renderer runs in Node only (rules 01: never in the renderer
bundle). Delivery emits a **receipt**: the artifact-check list (schema, geometry — no edge through
an unrelated node, no label masking a route — legend, viewport fit at 1440×900/1920×1080), SHA-256
and byte count of both the specification and the artifact, and `evidence: verified | unverified`.
A non-zero check never overwrites a previous artifact.
*Acceptance:* golden HTML for each fixture; the same IR renders byte-identically across runs; a
receipt with a failed check leaves the prior file untouched.

**D-A3 · Atlas seeds; the agent authors; the repository verifies.** `draftDiagramFromAtlas(graph,
{ scope })` maps layers → components, layer relationships → labelled connections, service ports
→ `external` nodes and boundaries, and attaches `sources` from node `filePath`/`lineRange`. The
draft is a *draft*: the agent curates to ≤12 primary nodes and one main path (the authoring
contract lives in the skill). `verifyDiagramEvidence(ir, repoRoot)` resolves `revision` with git,
checks every `sources[].path` exists at that revision (and the line range is in bounds), and marks
each node `verified` or reports the failure by path. It runs inside the existing gitdir/worktree
grant (ADR-042) and **never infers a relationship from file proximity** — an unverifiable edge stays
`authored`, visibly.
*Acceptance:* a temp-repo test proves a moved file flips `verified → unverified` with a diagnostic
naming the path; a draft from the Atlas fixture yields components equal to its layers.

**D-A4 · The architecture delta is review evidence.** `compareDiagrams(base, head)` canonicalises
both IRs (sorted keys, normalised repository URL/revision) and reports **added / removed / changed
/ moved / rerouted** facts per component, boundary, and connection, rendered as Before · Delta ·
After panes. For a pull request, the bot renders the delta when both revisions carry a pinned
diagram (`.brainrouter/diagrams/<slug>.json`) and attaches it as a deterministic evidence block —
beside `buildAtlasChangeContext`, through the ADR-039 producer seam — to the review summary, the
desktop `ReviewPanel`, and the dashboard review page. It is **not a lens**: no model call, no
findings, never a merge gate.
*Acceptance:* a fixture pair with one moved component and one relabelled connection yields exactly
one `moved` and one `changed` fact; a PR without a pinned diagram attaches nothing and says so.

**D-A5 · One artifact, every surface.** *Tools:* `diagram_draft` (read tier — Atlas seed),
`diagram_validate`, `diagram_render`, `diagram_compare` (write tier — they write under the
session artifact store, ADR-049's `.brainrouter/` pattern when pinned). *CLI/desktop command:*
`/diagram <kind> "<what>"` renders and prints the receipt; `/diagram pin <slug>` copies the IR into
`.brainrouter/diagrams/`; the command enters the shared catalog so `parity.ts` keeps both heads
honest. *Desktop:* the artifact opens in the sandboxed prototype `<webview>` with an **Open in
Atlas** cross-link (node `sources` → Atlas file node) and PNG/SVG export. *Dashboard:* a read-only
viewer on the repository and review pages, plus a 1200×630 PNG share image for PR comments and
release notes. *Knob:* `cli.diagram.theme` (`auto | dark | light`) — the only one.
*Acceptance:* the command catalog parity test passes with the new command in both lists; the
desktop opens a rendered fixture with no console error; the dashboard viewer renders the same file
the CLI produced, by hash.

**D-A6 · Mermaid is an input, not an output.** `flowchart`/`graph` → `workflow` or `architecture`,
`sequenceDiagram` → `sequence`, `stateDiagram` → `lifecycle`: topology and labels are read, then a
fresh IR is authored; Mermaid styling is never transcribed. Optional, last.

### Track B — A design gate the agent cannot skip

**D-B1 · A deterministic design detector in core.** `packages/core/src/design/detect/` owns a
**rule registry** — `{ id, category: slop | quality | design-system, severity, advisory?,
description, guideline }` — and two engines: a *static* engine over HTML/CSS/JSX-emitted markup
(parsers as Node-only dependencies) and a *browser* engine that runs the same rule ids over
computed styles in the in-app browser (contrast against composited backgrounds, text overflow and
occlusion, first-viewport horizontal overflow, hidden-at-rest content). Findings use the review
finding shape — `file`, `line`, `snippet`, `rule`, `severity`, `category`, and where a fix is
mechanical, `code_excerpt`/`replacement` (ADR-036) — so they render on the existing cards. The
first catalogue is authored in-house from the field's consensus (side-stripe borders, gradient
text, nested cards, overused faces, flat type hierarchy, glow halos, gray-on-colour, tiny text,
skipped headings, justified body copy, decorative marquee/pulse, eyebrow-above-heading, numbered
section labels, buzzword copy …) and is versioned like the tool catalog (ADR-046). *Design-system
rules* (`design-system-font | -color | -radius | -font-size`) derive their allowed sets from the
workspace `design.md` frontmatter tokens — the tokens become **normative** for the detector, which
is the §7c reader gaining a second consumer, not a second format. Suppressions live in
`.brainrouter/design-detector.json` (`ignoreRules`, `ignoreFiles`, `ignoreValues` each with a
`reason`); they are workspace data, committed, never a `cli.*` knob.
*Acceptance:* a fixture page containing every rule's tell yields exactly that rule set and nothing
else; a clean fixture yields zero; a `design.md` with three font tokens turns a fourth face into
one `design-system-font` finding; the renderer bundle contains none of the parser dependencies.

**D-B2 · The detector runs where the edit happens.** A built-in hook — registered through the
`hooks` service, not a shell script — fires on `post-tool` for Edit/Write of UI files (immediate
tier: fast rules only, ≤5 findings, ≤8 kB, 5 s budget) and on `stop` (full pass, 30 s budget).
Findings enter the *next* turn through the stop-context channel ADR-048 already uses for blast
radius; the hook **never denies** a write. It is **opt-in per workspace**: `cli.design.hook`
(`off | immediate | full`, default `off`; the desktop Settings row and `/design hooks on|off|status`
write the same knob), and it is only offered when the `frontend` capability is active.
*Acceptance:* with the knob on, editing a `.tsx` fixture injects ≤5 findings into the following
turn and none into the current tool result; with it off, nothing runs; a hook that overruns its
budget is cut and reported, never blocking.

**D-B3 · One design skill with a routed vocabulary, not ten rulebooks.** `hallmark` becomes the
single `design` entry point — its SKILL.md gains a **Commands table** and one reference file per
verb, the shape it already has for `study`/`audit`. The vocabulary is chosen for distinct
*mechanics*, not breadth: `shape` (plan before code), `critique` (D-B5), `audit` (five scored
dimensions — accessibility, performance, theming, responsive, implementation integrity — the last
one *running the detector and verifying each finding in context*), `polish`, `harden` (errors,
i18n, overflow, edge cases), `onboard` (first-run, empty states), `adapt` (devices), `optimize`
(UI performance), `clarify` (copy), `distill`, `bolder` / `quieter`, `typeset` / `layout` /
`colorize` / `animate`, `document` (derive `design.md` from the project's own code — the twin of
`study`, which derives it from a reference), and `product` (D-B6). A **mode** — *persuade*
(marketing), *operate* (app UI), *read* (docs), *experience* (showcase) — is chosen per surface, not
per product, and recorded in the surface brief. The seven style skills are
demoted to **worlds** the one skill can route to (`references/genres/`), and the `design` profile's
`skills.enabled` list is brought into agreement with its pack — `hallmark` only for visual craft;
`a11y-skill` stays (accessibility is not visual craft) and `concept-diagrams`/`output-skill` stay
where the education profile also uses them (ADR-031 §3's finding, finally closed). The boundary of rules 09 §7b is restated
in the new frontmatter: this vocabulary governs the *user's* project; BrainRouter's own surfaces
stay under `brainrouter-rules/06`. Slash: `/design <verb> [target]` in CLI and desktop.
*Acceptance:* every verb has a reference file and a routing test; the design profile's pack
and its `skills.enabled` list agree on one visual-craft skill; the command-catalog parity test passes; the §7b boundary
test still finds its sentence.

**D-B4 · `critique` is two assessments that cannot see each other.** A design review (hierarchy,
clarity, emotional resonance — heuristic scores) and a detector/browser evidence pass run as two
**isolated subagents** on the existing fanout seam; the detector's output enters synthesis only
after the design review finishes, so deterministic findings do not anchor judgment. When no
subagent seam is available the run degrades sequentially and its first line **must** say so. A
run persists a snapshot under `.brainrouter/design/critiques/<slug>/<timestamp>.json` so the next
critique shows a trend, and it ends with the targeted questions — nothing after them.
*Acceptance:* a test with the fanout seam disabled produces the degraded banner; a test with it
enabled shows the detector pass started after the review pass ended; two runs on the same target
produce a trend line.

**D-B5 · Live variants on the browser we own.** In the desktop, `/design live`: the user picks an
element in the in-app browser (the agent-cursor and `page.find` machinery of ADR-055), names an
action (`bolder`, `quieter`, free text) and a count; the agent writes N variants **into the source
file** inside a `display: contents` wrapper carrying `data-brainrouter-variants`, the dev server's
HMR swaps them in, the user cycles and accepts one; accept strips the losers, discard restores.
Framework state survives because the framework renders; the winner is real code in the diff. The
desktop main process is the relay (browser control port ↔ agent), so **no localhost server, no
SSE, no injected script** beyond the variant cycler. The CLI, having no browser, gets the same
verbs with `--variants N` writing the wrapper and printing the accept command. A no-HMR fallback
re-fetches the source through the existing file tools.
*Acceptance:* on the e2e fixture app, pick → 3 variants → accept leaves one clean node in the
source and a receipt naming the file and lines; discard leaves the file byte-identical.

**D-B6 · Product truth beside visual truth.** A `product.md` (audience, purpose, operating
context, constraints, voice, *evidence on hand* — and the standing rule that no metric,
testimonial, customer, or benchmark is invented) is read by the **same reader module** as
`design.md` (`designArtifact.ts` becomes `workspaceArtifacts.ts`; same path precedence, same
neutralised-and-fenced injection, one prompt block from the `frontend` capability). `/design
product` gathers only material gaps and writes it. This is not a second design format — §7c holds:
tokens stay in `design.md`, product truth stays out of it.
*Acceptance:* the artifact reaches the model as fenced data; the resolver never touches disk; a
test proves the prompt block appears only when the capability is active.

**D-B7 · Fidelity is measured, not asserted.** `design_fidelity` compares an approved comp (a
prototype capture or a supplied image) with a screenshot of the build: structure (SSIM over blurred
grayscale with a small translation search), colour (palette match), detail (high-frequency energy
per region), and section bands — per region, with a verdict `match | drift | missing |
contradicted`, a side-by-side PNG and heatmap stored as session artifacts. It reuses the browser's
screenshot and vision path. It is a *measurement the model reads*, not a gate.
*Acceptance:* comp vs itself ≥ 99; comp with a region erased marks that region `missing`; a
recoloured comp is `contradicted` overall.

**D-B8 · The bot runs the static detector on changed UI files.** For a PR, the review bot runs the
static engine over the diff's UI files (respecting the workspace suppressions at the head revision)
and attaches findings as a deterministic evidence block — advisory, never gating, deduplicated
against re-runs by rule id + line, filterable in the dashboard Review Console. Zero model cost.
*Acceptance:* a PR fixture with two anti-patterns yields two advisory cards and a green check-run;
a suppressed rule yields none and the summary names the suppression.

### Ownership

| Concern | Owner | Notes |
|---|---|---|
| Diagram IR schemas, `DesignFinding` shape, rule catalogue types | `packages/types` | schemas served in the runtime catalog; drift gate (ADR-046) |
| `diagram/` (validate, render, draft, verify, compare) · `design/detect/` (registry, engines, suppressions) | `packages/core` | Node-only; curated entrypoints only (rules 01/06 §1) |
| Tools `diagram_*`, `design_detect`, `design_fidelity` | `packages/core` tool registry (ADR-041 D8 handler registry) | tiers as stated; catalog regen |
| Built-in design hook · `cli.design.hook`, `cli.diagram.theme` | `packages/core` hooks service · `config/` | knobs in `cli.*` only; no env vars |
| `/diagram`, `/design` commands | shared command catalog (`command/`) | parity test covers both heads |
| Skill vocabulary, references, worlds, `product.md` reader | root `skills/design/hallmark`, `workspace/` | licence travels (ADR-031 D3) |
| Diagram viewer, Open-in-Atlas, live variants, Settings row | `brainrouter-desktop` | host↔renderer over existing channels only |
| Viewer + share image, Review Console filters | `brainrouter-dashboard` + `brainrouter` server routes | `requireAnyAuth`, org-scoped, awaited |
| Delta + design evidence producers | review bot (`brainrouter/src/reviews`) | ADR-039 producer seam; advisory |

### Alternatives considered

1. **Vendor the two reference implementations** (as a skill wrapping their CLIs, the way `hallmark`
   was vendored). *Rejected.* The value in both is executable — a renderer/validator and a rule
   engine — and an external CLI's receipts sit outside the runtime that is supposed to vouch for
   them (ADR-046); the design tool is built for distribution into a dozen harness folders, which is
   dead weight when BrainRouter *is* the harness; and the multi-tool coupling would give the review
   bot, the dashboard, and the CLI three different truths. Prose is vendorable (ADR-031 D2c); a
   runtime is not.
2. **Mermaid as the diagram output.** *Rejected.* No schema, no evidence, no receipt, no delta, and
   non-deterministic layout across renderers. Kept as an *input* (D-A6).
3. **Extend the Atlas panel into a diagram editor.** *Rejected.* Atlas is a measurement of the whole
   tree; a map is a curated story of twelve nodes. The panel stays the explorer; the viewer reuses
   its graph library for *display* only, and the two are cross-linked (D-A5).
4. **More prompting instead of a detector.** *Rejected* — it is ADR-031's own premise inverted: the
   model grading its own output is the failure this track exists to end; no repeatability, no CI
   mode, and a model call per check.
5. **A browser extension or localhost relay for live iteration.** *Rejected.* The desktop already
   owns a Chromium with an agent control port (ADR-055); a second bridge would duplicate the
   session, permission, and SSRF posture that browser already has.
6. **All twenty-plus verbs at once.** *Rejected.* Verbs earn a row by distinct mechanics; the rest are
   arguments to `polish`/`layout`.

### Compatibility, security, failure semantics

- **Nothing here changes a default.** The hook is off, the diagram command is additive, the skill
  keeps its four existing verbs as aliases, the seven demoted skills remain in the library.
- **Evidence never widens access.** `verifyDiagramEvidence` reads through the ADR-042 gitdir grant;
  the bot reads the head revision it already has; the browser engine runs only on a tab the session
  already owns and never on a credential field (ADR-055 P2).
- **Untrusted input stays data.** `product.md`, `design.md`, and a pinned diagram from a repository
  are neutralised and fenced exactly as §7c does for `design.md`; a rule catalogue or suppression
  file from a repository can suppress, never add, rules.
- **Failure is visible.** A failed render keeps the previous artifact and returns the diagnostic; a
  hook that overruns is cut and reported; a critique without isolation announces it; an
  unverifiable source stays `authored`.
- **BrainRouter's own surfaces are out of scope** (§3): the detector may be *run* on them for
  information, but rules 06 §9 and ADR-026 remain the only authority for them.

---

## 3. What this is not

- Not a hosted diagram editor or a drawing suite — the artifact is one file with no server.
- Not a replacement for Atlas — Atlas measures; a diagram argues, with receipts.
- Not a merge gate — deltas and design findings are advisory evidence; `security` remains the only
  gating lens.
- Not a redesign of the desktop or dashboard — their monochrome contract (ADR-026, rules 06 §9)
  is not subject to the user-project design vocabulary, by the §7b boundary.
- Not a rule catalogue copied from anywhere — authored, versioned, and owned here.
- Not twenty-three commands; not a Chrome extension; not another skill-packaging format.

---

## 4. Dependency-ordered delivery board

Rows are one PR each into the current release branch; a row is done when its acceptance line in
§2 holds. Tracks A and B are independent; rows within a track are ordered.

**Track A — maps**

- **A1 — IR + schemas + validator** (D-A1) — `packages/types` schemas, `packages/core/src/diagram/validate`; fixtures for five kinds; catalog drift gate. — **✅ merged #1662**
- **A2 — Deterministic renderer + receipt** (D-A2) — HTML/SVG compile, artifact checks, SHA-256 receipt; golden tests; Node-only import boundary test. — **✅ merged #1662**
- **A3 — Tools + `/diagram` command** (D-A5 first half) — `diagram_validate`/`diagram_render`; command in the shared catalog; parity test; CLI prints the receipt. — **✅ merged #1663**
- **A4 — Atlas seed + repository evidence** (D-A3) — `draftDiagramFromAtlas`, `verifyDiagramEvidence`; temp-repo tests; `diagram_draft` tool. — **✅ merged #1664**
- **A5 — Desktop viewer** (D-A5) — sandboxed `<webview>` artifact, Open-in-Atlas, PNG/SVG export, `/diagram pin`. — **🔵 in review #1667**
- **A6 — Architecture delta as review evidence** (D-A4) — `compareDiagrams`, Before·Delta·After render, producer on the bot seam, desktop `ReviewPanel` + dashboard review page blocks. — **🔵 in review #1666**
- **A7 — Dashboard viewer + share image** (D-A5) — read-only viewer on repository/review pages; 1200×630 PNG. — **🔵 in review #1677 (share image is SVG — no rasteriser dependency; PNG is an owner call)**
- **A8 — Mermaid import** (D-A6) — optional; last. — **🔵 in review #1678**

**Track B — design**

- **B1 — Detector core** (D-B1) — registry, static engine, `design.md`-derived design-system rules, suppressions file, `design_detect` tool, `/design audit --static`; per-rule fixtures. — **✅ merged #1668**
- **B2 — Browser engine** (D-B1) — computed-style rules over the in-app browser; desktop only, CLI falls back to static and says so. — **🔵 in review #1675**
- **B3 — Built-in hook + knob + Settings row** (D-B2) — `post-tool` immediate tier, `stop` full pass, next-turn injection; budget tests. — **✅ merged #1669**
- **B4 — One skill, routed vocabulary** (D-B3) — Commands table, per-verb references, modes, seven worlds, `profiles.ts` ↔ pack agreement, `/design <verb>`; parity + boundary tests. — **🔵 in review #1670**
- **B5 — `critique` two-assessment orchestration + snapshots** (D-B4) — fanout seam, degraded banner, `.brainrouter/design/critiques/`. — **🔵 in review #1672**
- **B6 — `product.md` via the shared artifact reader** (D-B6) — reader rename, prompt block, `/design product`. — **🔵 in review #1671**
- **B7 — Live variants in the desktop browser** (D-B5) — screenshot-driven; the owner watches the first run before merge. — **◐ deterministic half (wrap / accept / discard, `design_variants`, `--variants N`) in review #1676; the desktop pick-and-cycle loop awaits the owner-attended first run**
- **B8 — Fidelity measurement** (D-B7) — `design_fidelity`, side-by-side + heatmap artifacts. — **🔵 in review #1674**
- **B9 — Bot static-design evidence + Review Console filter** (D-B8) — advisory cards, dedup, suppression honoured at head. — **✅ merged #1673**

Rules updates ride the rows that change them: 09 §7b (vocabulary restated in frontmatter, B4),
09 §7c (`design.md` tokens normative for the detector; `product.md` beside it, B1/B6), 05 (new
knobs, B3), 06 (viewer and Settings row, A5/B3), a new 09 §7d for the diagram artifact (A5).

**Build notes (2026-09-05).** The IR field is `schemaVersion` (the package convention), where the text above says `schema_version`. The hook's `stop` tier runs inside turn finalization rather than as a registered `hooks`-service script; the budgets and the next-turn channel are as specified. Dashboard surfaces (B9's producer filter, A7's diagrams card) were built and typechecked but not rendered in-session — the dashboard preview needs a backend session. The seven style skills carry `routed-by: hallmark` and stay out of every catalog while remaining resolvable by name.

---

## 5. How this will be judged

1. **A map is checkable.** Asked for an architecture map of `packages/core/src/review`, the agent
   produces an IR that validates, an HTML that opens offline with no request, a receipt with the
   SHA-256 of both, and every `sources` entry verified at HEAD — the same receipt from the CLI, the
   desktop, and the dashboard, by hash.
2. **A moved boundary is visible.** A PR that moves a component between two pinned diagrams
   produces exactly one `moved` fact in the review evidence, on all three review surfaces, with no
   model call.
3. **A tell is caught without a model.** The per-rule fixture set yields its exact rule ids and
   zero others; the same page in the browser engine adds only computed-style findings; a
   `design.md` token set makes drift a finding.
4. **The gate is bounded and honest.** The hook injects ≤5 findings into the next turn within its
   budget, never blocks a write, and is silent when off; a critique without isolation says so on
   line one; an unverifiable source stays `authored`.
5. **The user's project is the only subject.** No row changes a BrainRouter surface's own styling;
   rules 06 §9's contract test still passes; the §7b boundary sentence is still found by its test.
6. **Nothing regressed.** Command-catalog parity, tool-catalog drift, and the renderer
   import-boundary tests stay green; the renderer bundle gains no Node-only dependency.
