# ADR-031 — A design skill, and the capability it belongs to

**Status:** PROPOSED — planning only. Nothing here is built.
**Depends on:** ADR-021 (workspace profiles, capabilities, skill packs).

*Separate from ADR-030 deliberately. That one is about reading documents; this one is about how
generated interfaces look. Folding two unrelated decisions into one record makes both harder to
revisit later, and they will be revisited on different timescales.*

---

## 1. The question that prompted this

*"I want to use this design skill for engineering, but I am not sure what profile it would be used
for."*

**It is not a profile, and that is already decided.** `profiles.ts:14-20` states it and a test
enforces it:

> ENGINEERING IS DELIBERATELY ONE PROFILE. Frontend, backend, and technical writing are task-time
> CAPABILITIES inside it, not separate profiles. […] There is a test asserting no `frontend`/`backend`
> profile is ever added.

So the answer is **the `frontend` capability**, and that answer is better than a profile would be:

| Profile | `frontend` capability | Effect |
|---|---|---|
| `engineering` | available, **recommended, enabled by default** | the skill is simply there while building software — which is what was asked for |
| `design` | available, not enabled | it turns on when someone is doing design work in a design workspace |

A profile would have forced a choice at workspace-creation time and a re-onboard the first time a
task crossed the line. A capability activates for the task. Nothing new needs inventing to place this
skill; the shape it needs already exists.

---

## 2. What the skill does

Four verbs, and the reason it is interesting is the second and fourth rather than the first:

| Verb | |
|---|---|
| *(default)* | build new UI — picks a macrostructure for the brief, applies a rule set, and runs its own checks before returning |
| `audit <target>` | score existing code against a catalogue of anti-patterns; a punch list, no edits |
| `redesign <target>` | keep the copy, information architecture and brand; throw out the structure and rebuild |
| `study <screenshot \| URL>` | extract the *structure* of a design — macrostructure, type pairing, colour anchor — and emit a portable `design.md`. Explicitly refuses pixel-clones and paid templates. |

It is one `SKILL.md` (~560 lines) plus a `references/` directory — **the same shape our bundled
skills already have**, so there is no new loader, no new packaging format, and no new UI. It is MIT
licensed and published to npm as `hallmark`, by Together AI.

The premise it is built on is worth stating because it is the reason to want it: an LLM asked for a
UI produces the on-distribution default it was trained into, and two different briefs come back
looking like colour-swaps of one template. Our own frontend work has exactly that failure mode, and
no amount of prompting inside a turn fixes it — the correction has to be a rule set the model is
handed *before* it starts.

---

## 3. The finding this investigation turned up

**The `design` profile enables five skills that do not exist.**

`profiles.ts` lists `a11y-skill`, `taste-skill`, `concept-diagrams`, `redesign-skill` and
`output-skill` as enabled for that profile. `packages/core/skills/` contains five categories —
`agent`, `api`, `codebase`, `lifecycle`, `qa` — and **none of those five skills is among them**. Only
`planning-skill` and `handover-skill`, which the design pack borrows from `agent/`, are real.

> Someone choosing the Design preset today gets a profile that names five skills the loader cannot
> find.

That is the same defect ADR-029 F1 named for block kinds, in the profile system: a thing offered that
is not there. It was not introduced by this investigation and it is not the skill's fault — but it
changes what adopting the skill means, because three of the five gaps are exactly what it covers:

| Missing skill | Covered by |
|---|---|
| `taste-skill` | the default verb and its checks |
| `redesign-skill` | `redesign` |
| `output-skill` | `study`, which emits a portable `design.md` |

`a11y-skill` and `concept-diagrams` are **not** covered and would remain missing. Accessibility is a
different discipline from visual craft, and pretending one skill covers both is how a profile ends up
lying about what it can do.

---

## 4. Decisions to make

### D1 · Attach it to the `frontend` capability, not to a profile

Per §1. It then reaches `engineering` by default and `design` when enabled, and nothing about the
profile system changes.

### D2 · Vendor, depend, or write our own

| | |
|---|---|
| **Depend on the npm package** | updates arrive for free; a runtime dependency on a third party for a file the agent reads at turn time, and our skills are currently all first-party files on disk |
| **Vendor a copy** *(recommended)* | a skill is a text file, not a library — it has no API to drift. Copying it in keeps the loader path unchanged and the content reviewable in our own diff. The cost is that we own updating it. |
| **Write our own, informed by it** | most control, most work, and we would be re-deriving a rule set someone has already tuned against real output |

**Vendoring is recommended because the artifact is prose.** The thing that makes a dependency worth
its cost — someone else fixing bugs in code you run — does not apply to a document the model reads.

### D3 · The licence travels, and it needs somewhere to live

The skill is MIT, © Hallmark contributors. **None of our bundled skills currently carries a
third-party notice**, so vendoring creates an obligation the repository has no home for yet.

> **This is not paperwork.** We publish to npm, ship a desktop binary on three platforms, and offer a
> hosted product. An MIT notice that exists in one checkout and not in the artifacts is a licence
> breach in every one of them.

Whatever is decided, the notice must survive `npm publish`, the Electron package, and the Docker
image — which means it is a packaging question, not a documentation one.

### D4 · Adapt it to our conventions, or take it as-is

Taking it as-is is the honest default: it was tuned as a whole, and cherry-picking rules from a rule
set is how you get a rule set that no longer works. But two of our own constraints will collide with
it and need a decision rather than a surprise:

- **our desktop is monochrome by design**, and a skill whose premise is twenty-one themes and a
  colour anchor will propose things that do not belong in it;
- **`brainrouter-rules/` is already our conventions handbook**, and two documents telling the agent
  how to write UI is how they drift apart.

The likely resolution is that the skill governs work *the agent does for a user's own project*, and
`brainrouter-rules/` continues to govern work on BrainRouter itself — but that boundary has to be
written down or the agent will apply the wrong one.

### D5 · `study` produces a `design.md`, and we already have a place for it

The `study` verb emits a portable design document. That is the same artifact the pending
design-artifact work for the frontend capability needs, so these should be decided together rather
than producing two formats for one purpose.

---

## 5. Out of scope

- Accessibility. `a11y-skill` stays missing after this and should be its own piece of work.
- Diagramming (`concept-diagrams`), for the same reason.
- Any change to how profiles or capabilities are modelled — §1 is a placement question, and the
  existing model answers it.

---

## 6. How this will be judged

Not by whether the skill is installed. **The test is two different briefs.**

Ask for a landing page for a sourdough app and a landing page for an extraction API, in a workspace
with the capability on. If the two come back as recognisably different structures rather than one
template in two colours, the skill is doing what it exists to do. If they come back as siblings, we
have added a file and changed nothing.

Second, and easier to forget: **picking the Design preset must stop naming skills that are not
there** — either because they exist by then, or because the profile stops claiming them.
