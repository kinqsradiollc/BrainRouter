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

The `design` profile enables `a11y-skill`, `taste-skill`, `concept-diagrams`, `redesign-skill` and
`output-skill`, and **`packages/core/skills/` — the set that actually ships — contains none of them.**

They are not missing from the repository. **All five are in the tracked root `skills/` library**
(`skills/design/…`, `skills/api/a11y-skill`). They are missing from the *bundle*, which is a
different and more interesting problem:

| Location | Contents | Ships |
|---|---|---|
| `skills/` — the library, tracked | **54 skills** | **nowhere** |
| `packages/core/skills/` | **13** copies | in `@kinqs/brainrouter-core`'s npm `files` |
| `brainrouter-cli/skills/` | **13** copies | in the CLI's npm `files` |
| `brainrouter/skills/` | **0** — the directory does not exist | yet `"skills"` is in its npm `files` list |

So:

> **41 of our 54 skills reach nobody, and the 13 that do exist three times, hand-copied.**

I checked whether the copies have drifted: they are byte-identical today, in both places. That is
the good news and the reason to act now — this is a duplication that has not yet cost anything, and
every one of this codebase's recent bugs of this shape (two merge implementations, two neutralisers,
two SSRF guards) was byte-identical right up until it was not.

The profile is therefore not lying about skills that were never written. It is naming skills that
exist, that someone wrote, and that the distribution mechanism never carried. Three of them are what
this ADR's skill covers:

| Named by the design profile | In the library | Covered by the new skill |
|---|---|---|
| `taste-skill` | yes | the default verb and its checks |
| `redesign-skill` | yes | `redesign` |
| `output-skill` | yes | `study`, which emits a portable `design.md` |
| `concept-diagrams` | yes | no — a different discipline |
| `a11y-skill` | yes | no — accessibility is not visual craft |

Which means the smaller half of this ADR is adding a skill, and the larger half is **fixing how a
skill gets from the library to a person.** Adding one more file to a library that ships nothing would
change nothing at all.

---

## 4. Decisions to make

### D1 · Attach it to the `frontend` capability, not to a profile

Per §1. It then reaches `engineering` by default and `design` when enabled, and nothing about the
profile system changes.

### D2 · One library, generated copies, and a test that they match

The copies are not the problem — **npm needs real files**, a symlink does not survive `npm pack` and
does not exist on Windows, and both packages genuinely have to carry the skills they offer. The
problem is that the copies are made *by hand*, so nothing notices when one is edited and the other is
not.

> **`skills/` at the root is the single source. Every other copy is generated from it and verified
> against it.**

Concretely, and in the order that matters:

1. **A build step copies** the selected set into `packages/core/skills/` and `brainrouter-cli/skills/`
   — same mechanism the repo already uses to place other assets before packing.
2. **A test asserts the copies are byte-identical to their source**, and fails if they are not. This
   is the load-bearing half. A generated copy with no check is a hand copy that also has a script.
3. **The selection is declared once** — which of the 54 each package carries — rather than being
   implied by whatever happens to be in the directory.

Doing (1) without (2) would be the same class of mistake this ADR is documenting: a mechanism that
looks like it guarantees agreement and only actually guarantees it on the day someone runs it.

### D2b · Ship more than thirteen

Separately from the mechanism: **41 skills in the library reach nobody.** Deciding which of them
belong in the bundle is a product judgement per skill, not something to settle in one line here — but
the five the design profile already names are not a judgement call. It names them; they should exist.

`brainrouter/package.json` also lists `"skills"` in its `files` while `brainrouter/skills/` does not
exist. Harmless today, and exactly the kind of entry that quietly ships nothing when someone later
assumes it works.

### D2c · The new skill enters the library, not the bundle

Once the above exists, adopting the design skill is unremarkable: it becomes an entry in `skills/`
like the other 54, selected into whichever packages carry it. **Vendoring rather than depending on
the npm package is right for the same reason it is right for the rest of the library** — a skill is
prose, not code. The thing that makes a dependency worth its cost, someone else fixing bugs in code
you run, does not apply to a document the model reads.

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

Three tests, and the first is the one that decides whether any of this mattered.

**1 · Two different briefs.** Ask for a landing page for a sourdough app and a landing page for an
extraction API, in a workspace with the capability on. If they come back as recognisably different
structures rather than one template in two colours, the skill is doing what it exists to do. If they
come back as siblings, we have added a file and changed nothing.

**2 · Picking the Design preset offers skills that are there.** Today it names five that the shipped
bundle does not contain. Either they ship, or the profile stops claiming them — an offer the product
cannot honour is worse than an absence (ADR-029 F1), and that rule does not stop at block kinds.

**3 · Editing a skill in one place changes it everywhere, or fails loudly.** Change a line in
`skills/`, build, and the copies in `packages/core` and `brainrouter-cli` must either follow or break
the build. Verify it by *breaking* it — edit one copy by hand and confirm the check fails. A sync
mechanism nobody has watched fail is a sync mechanism nobody knows works.
