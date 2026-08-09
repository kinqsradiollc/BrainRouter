# ADR-033 — Review that finds things, and says where

**Status:** ACCEPTED — approved by the owner for implementation.
**Depends on:** ADR-025 (assurance programs), ADR-028 (surfaces that tell the truth), ADR-029 F1 (an offer the product cannot honour).

---

## 1. Where we are

We have two reviewers and they are not the same kind of thing.

| | The PR bot | Desktop / CLI |
|---|---|---|
| Runs | `integrations/prSecurityReview.ts` | `runReview` in the desktop host, `/review` in the CLI |
| Shape | **single-shot LLM call per diff part** | **an Agent with tools** |
| Sees the repository? | **Yes** — checked out at the exact SHA | Yes — the working tree |
| Can it *ask* for a file mid-review? | **No** | Yes — `read_file`, grep |
| Concurrency | none — `for (let partIndex …)` is sequential | n/a |
| Reflection on its own findings | none | none |

**The bot is not blind — it is non-interactive**, and getting that distinction right changes what
this ADR should build. `ExactShaCheckoutAdapter` (`reviews/repositoryContextComposition.ts`) clones
the repository at the exact SHA with a one-shot credential that is cleared as soon as the fetch
begins, and a deterministic impact-packet assembler decides what of it becomes `repositoryContext`.

So the model is handed a fixed block of evidence someone else chose. If a finding needs one more
file, it cannot ask.

The file says so itself, and the comment is more honest than most designs:

> *"The bot shares the review DEFINITION (lens contract + grounding clause) with the desktop and CLI
> reviewers, but not their orchestration: what follows is a single-shot `llmRunner` call with no
> Agent, no workspace manifest and no profile to resolve […] Routing it through an Agent is a
> redesign, not a wiring change."*

This ADR is that redesign.

### 1.1 What the shape costs us

- **The bot cannot verify a suspicion it did not anticipate.** The evidence is fixed before the
  model starts, so a finding that turns on a file the packet did not include is an inference about
  code the model never saw. ADR-028's rule — do not claim a state you have not established — is
  reachable only for whatever the assembler happened to include.
- **Parts are split by SIZE.** A change to `en.json` and its `zh.json` sibling can land in different
  parts and be reviewed by two calls that cannot see each other.
- **Sequential parts.** A ten-part diff is ten serial model calls, which is why the required check is
  the slowest thing on the PR and why a wedged provider blocks merges.
- **Nothing measures it.** No precision, no recall, no benchmark. We cannot tell an improvement from
  a regression, so every prompt change is a guess.

---

## 2. The idea worth taking

The strongest published answer to this is not "a better prompt". It is a **split of responsibility**:

> **Deterministic engineering owns everything that must not go wrong. The model owns judgement.**

Concretely, the parts that are engineering rather than prompting:

- which files are reviewed, and which are filtered — decided by code, so nothing is silently skipped;
- how files are **bundled into review units** — related files together, each unit its own sub-agent
  with isolated context, which is what keeps quality stable on a large changeset;
- which rules apply to which file — matched by template, not by asking the model to remember;
- **where a finding actually goes** — an external positioning step, because line drift is the most
  common way a true finding becomes useless;
- a **reflection pass** over the findings before they are published.

The reported result of that split is worth stating because it argues against our instinct: **higher
precision at roughly a ninth of the tokens**, with recall deliberately traded away. A reviewer that
reports less and is right is more useful than one that reports more, because a reviewer nobody trusts
gets muted.

---

## 3. Decisions

### D1 · One reviewer, two front doors

The bot and the local reviewer become **the same orchestration** with different inputs and different
sinks — a PR diff posting comments, or a working tree printing to a terminal. Today they share a
contract and diverge in capability, which is the worst split: the same words with different
guarantees behind them.

> **If the desktop reviewer can open a file and the bot cannot, they are not the same review, and
> saying they are is the ADR-028 failure applied to our own tooling.**

### D2 · Review units are bundles, decided by code

Replace size-based parts with **bundles**: related files grouped into one unit — a file and its
test, a message catalogue and its translations, a route and its handler. Each bundle is one
sub-agent with its own context.

This is the decision that makes everything else possible: bundles are independent, so they run
**concurrently**, and a large changeset stops being a long serial chain.

**Bundling is engineering, not judgement.** A model asked "which files go together" will be
plausible and unstable; path and import relationships are neither.

### D3 · The bot may ASK for a file, not merely be handed one

The checkout already exists (§1). What is missing is the ability to request something the packet did
not anticipate, so this is a smaller change than "give the bot access" — it is a read-only toolset
over a directory that is already on disk.

A finding that says *"this can be null"* must have been checked against the definition. Where the
check was not possible, the finding says so rather than being dropped or asserted; the grounding
vocabulary for that already exists and this extends it to the bot.

> **The deterministic packet stays.** It is the floor — what a review gets without asking. Tools are
> for the question the assembler could not have predicted, and a reviewer that had to fetch
> everything itself would be slower and less predictable than one that starts with the right
> evidence in hand.

### D4 · Position is computed, not generated

A separate step maps a finding to its line, from the file content and the diff — never from the
model's memory of what line it was looking at.

> **A correct finding on the wrong line is a false positive to the person reading it**, because they
> look, see nothing, and trust the next one less.

### D5 · A reflection pass, and it is allowed to delete

Before publishing, a second pass reviews the findings *as a set*: drop what is not real, merge
duplicates across bundles, and rank. It must be able to return **fewer** findings than it received —
a critic that can only annotate is a formatting step.

We have `review/critic.ts` in core and the bot does not use it. That is the cheapest half of this
decision.

### D6 · Precision is the target, and recall is the trade

State it so nobody optimises the wrong number later: **we would rather miss a real issue than report
a false one.** A false positive costs a person's attention and a little trust, every time; and a
review people stop reading finds nothing at all.

### D7 · Measure it, or none of the above is knowable

Build a small benchmark from **our own merged PRs** with known outcomes, and report precision,
recall, wall-clock and tokens per run.

> **Without this, every change in this ADR is a belief.** It is also the only way to justify D6's
> trade to someone who disagrees with it.

Start small — tens of PRs, not hundreds — and grow it from real review misses.

### D8 · The required check must not be able to wedge a merge

Today a stalled provider blocks merges, and that has already happened. Concurrency (D2) reduces the
window; it does not close it.

A review that cannot complete reports **"review unavailable"** and says why. It does not hold the
gate. A gate that blocks on our own infrastructure teaches people to bypass the gate.

### D9 · Diffs and repository content stay untrusted

Already true in the bot (`UNTRUSTED_REVIEW_EVIDENCE_RULE`) and it must survive the redesign.

D3 sharpens the risk rather than inventing it: **the checkout is already on disk today**, so the
question was never whether an attacker could get their code near us — it is whether they can steer
what we *choose to read* from it. A hostile diff that names a path in a comment is exactly that
attempt.

Three constraints, and the first is the one that matters:

1. **Reads are confined to the checkout**, path-normalised, no symlink escape. The credential is
   already one-shot and cleared; the filesystem boundary must be as deliberate.
2. **The toolset is read-only.** A reviewer that can write is a different trust decision (§4).
3. **Bundles are chosen by engineering** (D2), so the *scope* of a review is never something the
   diff can argue its way into — only the detail within it.

---

## 4. Out of scope

- Auto-fixing findings. A reviewer that edits is a different trust decision.
- Replacing CodeQL or dependency scanning. This complements them.
- The pentest program (ADR-025's authorized-assessment track) — different lens, different consent.

---

## 5. Open questions

1. **What bundles, concretely?** Path adjacency and import edges are the obvious signals; we have a
   code graph that may already answer it. Worth checking before inventing a heuristic.
2. **Where does the bot's concurrency budget come from?** Per-tenant model spend is real, and N
   bundles in parallel is N times the burst.
3. **Does the local reviewer get bundles too, or is it fine one-shot?** A working-tree diff is
   usually small; this may be a PR-only concern, and pretending otherwise adds machinery for nothing.
4. **What is the benchmark's ground truth?** Our merged PRs have review comments and follow-up
   fixes — usable, and biased toward what we already catch. Worth stating that bias rather than
   discovering it later.

---

## 6. How this will be judged

**One number and one behaviour.**

The number: **precision on the D7 benchmark goes up, and tokens per review go down.** Both, or the
split in §2 did not buy what it claims.

The behaviour: **take a real merged PR with a known defect, and check that the finding lands on the
right line.** Not the right file — the right line. Everything else in this ADR is in service of a
person looking where they were told and finding the thing there.
