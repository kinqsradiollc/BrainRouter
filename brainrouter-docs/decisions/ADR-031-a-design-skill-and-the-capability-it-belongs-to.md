# ADR-031 — A design skill, and the capability it belongs to

**Status:** ACCEPTED — approved by the owner, who delegated the open decisions. D2b and D3 are now
answered from measurement rather than left open.
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
| `design` | available, not enabled | it turns on when someone is doing design work in a design workspace — the capability activates for the `designer` persona as well as the `engineer` one, or this row would be unreachable |

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
(`skills/design/…`, `skills/api/a11y-skill`). They are missing from *two of the three packages that
carry skills* — and the third already does it correctly.

#### 3.1 · `skills/` at the root has two audiences, and that is not a mistake

This is the thing worth writing down, because it looks like an accident and is not:

1. **Contributors.** Claude Code and Codex read it while working on this repository. It is the same
   role a `.claude/skills` directory plays elsewhere, kept at the root because it is not
   Claude-specific.
2. **The MCP server.** `brainrouter/src/registry.ts:161` indexes `join(root, 'skills')` at runtime
   and serves the catalogue over MCP. `resolver.ts` finds the repo root *by looking for `skills/`*.

One directory, two readers, and no conflict: the library is the product **and** the toolkit we build
it with. That is a coherent design and it should be stated rather than rediscovered.

#### 3.2 · Three packages carry skills; one of them already does it right

| Package | How it gets skills | Gets |
|---|---|---|
| `brainrouter` (the MCP server) | **generated** — `scripts/prepack.mjs` copies root `skills/` in before pack, `postpack.mjs` deletes it after, `/skills/` is gitignored | **all 54** |
| `packages/core` | **13 files committed by hand** | 13 |
| `brainrouter-cli` | **13 files committed by hand** | 13 |

> **The mechanism this ADR was going to propose already exists — in one package out of three.**

`brainrouter` has exactly the shape the other two need: one source, a copy generated at pack time,
the copy gitignored so nobody edits it by mistake, and a paired cleanup so the working tree does not
accumulate. It has been working the whole time.

**I got this wrong on first reading and the correction matters.** I recorded `brainrouter/skills/`
as an empty directory listed in `files` — a packaging bug. It is not: it is generated, deliberately
absent from the tree, and `.gitignore:3` says so. The bug is the opposite of where I put it.

So the real statement is narrower and more actionable than "41 skills reach nobody":

> **The MCP server ships all 54. Core and the CLI ship 13 each, hand-copied, committed — and the
> design profile's five are not among them.**

The copies are byte-identical today, in both places. That is the reason to act now rather than a
reason not to: every duplication this codebase has been bitten by recently — two merge
implementations, two neutralisers, two SSRF guards — was byte-identical right up until it was not.

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

### D2 · Adopt the mechanism we already have, in the two packages that lack it

Not a new design — **`brainrouter/scripts/prepack.mjs` is the design**, and it has been in production
the whole time. Core and the CLI adopt it:

1. **Generate at pack time** from root `skills/`, the way the MCP server already does.
2. **Gitignore the generated directory**, so the copy cannot be edited by mistake — this is what makes
   it a copy rather than a fork. It is the half `brainrouter` gets right and the reason its 54 have
   never drifted.
3. **Delete after pack**, paired, so the working tree does not accumulate a second truth.
4. **Declare the selection once** if core and the CLI carry a subset rather than all 54 — the set is
   a decision, not whatever happens to be in a directory.

Copies stay real files. **npm needs them**: a symlink does not survive `npm pack` and does not exist
on Windows, and each package genuinely has to carry what it offers.

**The check is the load-bearing half.** Whatever runs the copy, something must fail when a generated
directory disagrees with its source — gitignoring it is most of that, because a file nobody can
commit is a file nobody can silently change. Where a committed copy has to remain, a test asserting
byte-equality is the substitute. A generated copy with no check is a hand copy that also has a
script.

### D2b · Which skills each package carries · **all of them**

I expected this to be a per-skill product judgement. Measuring it made the judgement unnecessary:

> **The entire library is 777 KB of text across 54 skills.**

That is a rounding error beside things these packages already carry without discussion — the document
parser's WebAssembly binary is 4.6 MB, the editor chunk is 3.9 MB. There is no budget argument for
carrying thirteen instead of fifty-four, and once the cost is gone the reasons to carry everything
are decisive:

1. **A subset makes a profile's truth depend on which package you installed.** The design profile
   names five skills. With a subset they exist on the MCP server and not in the CLI, so the same
   profile is honest in one place and lying in another — a worse failure than the one we started
   with, because it is intermittent.
2. **The selection stops being a thing to maintain.** A declared per-package list is a second
   decision to keep in agreement with the first, and §3 is a record of what happens to those.
3. **Carrying is not enabling.** The profile system already decides which skills a workspace turns
   on. A carried-but-unenabled skill costs bytes; an absent one costs a feature.

`brainrouter` has taken all of them the whole time and nobody has minded.

**Consequence to state plainly:** vendoring the design skill adds ~690 KB, roughly doubling the
library. Still small in absolute terms, and if the library ever grows to where this reasoning breaks,
the fix is a declared selection *then* — with a measurement behind it, the way this one has.

### D2c · The new skill enters the library, not the bundle

Once the above exists, adopting the design skill is unremarkable: it becomes an entry in `skills/`
like the other 54, selected into whichever packages carry it. **Vendoring rather than depending on
the npm package is right for the same reason it is right for the rest of the library** — a skill is
prose, not code. The thing that makes a dependency worth its cost, someone else fixing bugs in code
you run, does not apply to a document the model reads.

### D3 · The licence travels, generated by the same script that copies the files

The skill is MIT. **None of our bundled skills currently carries a third-party notice**, so vendoring
creates an obligation the repository has no home for.

> **This is not paperwork.** We publish to npm, ship a desktop binary on three platforms, and offer a
> hosted product. An MIT notice that exists in one checkout and not in the artifacts is a licence
> breach in every one of them.

So it is a packaging problem, and it gets the packaging answer — **the same one as the skills
themselves**, because the failure mode is identical: a notice maintained by hand beside a copy
maintained by hand is two things that fall out of agreement.

1. A vendored skill carries its licence **beside it in the library**, as a file, not as a line in a
   README someone has to remember.
2. The copy step **generates a third-party notice** for each package from what it actually copied,
   and lists it in that package's npm `files`.
3. Generating it from the copied set rather than from a hand-written list is the whole point: a skill
   that ships without its notice becomes impossible rather than merely discouraged.

The same treatment covers the WebAssembly parser ADR-030 adopted, which is also MIT and also has no
notice today. Fixing one and not the other would leave the repository exactly as wrong.

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

**Decided, and built.** The format is the skill's own
(`skills/design/hallmark/references/design-md.md`) — BrainRouter defines no competing schema. The
convention is `design.md` at the workspace root, then `.brainrouter/design.md`, then
`docs/design.md`, first match wins. `readWorkspaceDesignArtifact`
(`packages/core/src/workspace/designArtifact.ts`) reads and neutralises it; the `frontend`
capability contributes it as a fenced prompt block when it activates, so a workspace that has a
design artifact is handed something a workspace without one is not. Before this the capability's
prompt block said "discover and follow the workspace design artifact" and nothing behind the
sentence existed — an offer the product could not honour. Recorded as a rule in
`brainrouter-rules/09-docs-skills-and-plugins.md` §7c.

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
`skills/`, pack, and what `packages/core` and `brainrouter-cli` ship must follow. Verify it by
*breaking* it — hand-edit a generated copy and confirm the build refuses. A sync mechanism nobody has
watched fail is a sync mechanism nobody knows works.

**4 · The two audiences stay one library.** A contributor's Claude Code session and the MCP server
must keep reading the same `skills/`. If a change here makes the product's catalogue diverge from the
toolkit we build with, we have turned one directory into two and should say so deliberately rather
than discover it.
