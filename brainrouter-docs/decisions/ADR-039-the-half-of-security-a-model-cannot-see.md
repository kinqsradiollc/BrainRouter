# ADR-039 — The half of security a model cannot see

**Status:** PROPOSED — for owner review.
**Depends on:** ADR-033 (review that finds things, and says where), ADR-025 (assurance programs),
ADR-032 (an agent that gets better and cannot get worse).

---

## 1. Where we are

Our review is a model with tools, wrapped in deterministic orchestration. ADR-033 was explicit about
the split it wanted:

> *Deterministic engineering owns everything that must not go wrong. The model owns judgement.*

And it delivered that for **orchestration** — which files are reviewed, how they are bundled, where a
finding lands, whether it survives reflection. All of that is code, and none of it asks a model to
remember.

But the *analysis itself* is entirely model judgement. There is no data-flow analysis anywhere in
`reviews/` or `packages/core/src/review/`: nothing computes that a value from a request body reaches
a `fetch`, that a string from a query parameter reaches a shell, that a regex with unbounded
backtracking runs over a webhook payload. The model reads the diff and forms an opinion.

That is half of a security review, and this release proved which half is missing.

### 1.1 The evidence, from one week

Two systems looked at this repository. They found **almost disjoint sets**.

**Static analysis found, and the model review did not:**

| finding | why a scanner sees it |
|---|---|
| three provider-probe SSRFs, one full-read | a taint path: request body → `fetch`, no guard between |
| a quadratic regex stalling the shared brain ~23s per PR comment | a syntactic property of the pattern plus its input source |
| session credentials in `localStorage` | a known sink with a known sensitivity class |
| `*` CORS origin combined with credentials | a two-property conjunction across files |

**The model review and investigation found, and static analysis did not:**

| finding | why a scanner cannot see it |
|---|---|
| a missing `cleanup` value in a SQL CHECK that killed every review | a disagreement between a migration and a TypeScript union — no data flows |
| an interrupted stage that could never be retried | a state-machine invariant across two modules |
| `git` absent from the shipped image | a property of the environment, not the source |
| the D7 outcome path with no untrusted-content guard | a missing authorization on a path that exists |

> **Neither subsumes the other, and the reason is structural.** Taint analysis answers *"can this
> value reach that sink"*. It cannot answer *"is this invariant true"*, *"does this run in the
> shipped image"*, or *"is this guard on every path that needs it"*. A model answers those and is
> unreliable at exhaustively tracing flows across files, because that is search, not judgement.

### 1.2 Why this matters more for generated code

AI-written code fails differently from human-written code. It is **plausible**. It reads correctly,
names things well, and handles the obvious cases — and the defects it leaves are disproportionately
the ones that look fine locally: a template string that happens to carry user input into a query, a
URL assembled from a parameter, a regex that is correct but catastrophic, a guard applied on three of
four paths.

Those are exactly the defects a taint engine is built to find and a reader is worst at. A review that
is only a reader, applied to code that is mostly generated, is weakest precisely where the code is
weakest.

**This is the gap. It is not a tuning problem, and no prompt closes it.**

---

## 2. The idea

> **Add the missing half, and let each half do what it is actually good at: the engine ENUMERATES
> candidates, the model DECIDES which are real.**

Neither alone is shippable. Static analysis alone produced **300+ open alerts on this repository, of
which 11 survived verification** — a signal-to-noise ratio that trains people to ignore it. Model
judgement alone missed every taint-flow finding above.

Together they are the two halves of ADR-033's own sentence, finally both present.

---

## 3. Decisions

### D1 · Static analysis becomes a review INPUT, not a parallel report

Analysis runs against the exact-revision checkout the review already has (ADR-033 D3), and its
results enter the pipeline as **candidates on the same footing as model-proposed findings** — same
positioning (D4), same reflection pass (D5), same publication gate.

Not a second bot posting a second comment. A reviewer that received one more source of evidence.

> A separate scanner comment is how you get 300 alerts nobody reads. A candidate that must survive
> verification is how you get 11 that matter.

### D2 · Every engine finding is verified before it is published

An engine says a path exists. Whether it is *reachable*, *guarded*, or *exploitable* is judgement,
and it is the judgement the model is genuinely good at when handed a specific claim and the code
around it.

This release is the argument: of eight "critical" SSRF alerts, **three were real**. Of 98
"missing rate limiting", the chokepoint largely already existed. Of 77 ReDoS alerts, the two I
checked by hand could not be reproduced, because their character classes excluded the delimiter.

Publishing raw engine output would have filed five false positives and buried three real ones.

### D3 · Verification is adversarial, and defaults to refuting

The verifier's job is to REFUSE the finding, not to confirm it. It must name the entry point an
attacker controls and each hop to the sink; if a guard, allowlist, auth check or bounded input
already blocks it, the finding dies.

This is the shape that produced 11 real findings from 44 candidates in this release's sweep, and it
is the same discipline ADR-033 D5 applies to model findings.

### D4 · The rule set is versioned, and its output is a diff

Queries change; a review must not become non-reproducible because an engine updated. The rule-set
version is recorded with the run, and what a review reports is **what is new against the base
revision** — not the repository's entire historical backlog.

A PR is responsible for what it introduced. Making every PR carry 300 pre-existing alerts is how the
gate becomes something to bypass.

### D5 · Absence of findings is never reported as safety

If analysis could not run — unsupported language, timeout, an extraction failure — the review says
**"not analyzed"**, in the same voice it uses for a diff-only fallback. It does not report a clean
result it did not establish.

This is golden rule 23 (a fallback must be visible) applied to the new half. A security review that
silently degrades to "no findings" is worse than no security review, because it produces confidence
instead of doubt.

### D6 · The engine is a port, and we own the boundary

Analysis sits behind a port with a stable contract — `analyze(checkout, ruleSet) → candidates` — so
the engine is replaceable and the review does not grow a dependency on any one vendor's output
format. Findings normalize to our existing candidate shape (CWE, severity, location, evidence)
before they reach the pipeline.

### D7 · Rules for OUR failure modes, not only the catalogue's

The standard catalogue would not have caught the schema/type drift, the retry trap, or the untrusted
path that skipped its guard. Those are ours, and we now know their shapes.

Where a failure is mechanically checkable, it becomes a check — `migrations.stageParity.test.ts` is
already one, written after the `cleanup` outage. This decision says that pattern is a program:
**every incident that produced a rule in `brainrouter-rules` should be asked whether it can be a
query instead.** A rule a human must remember is weaker than a query that fails a build.

---

## 4. What this does not do

- **It does not replace the model reviewer.** Half the findings this release came from judgement, and
  they were the expensive half — a four-day outage and a permanently wedged run.
- **It does not gate merges on the full backlog.** D4 is explicit: new findings against base.
- **It does not promise language parity.** The engine will cover some of our stack well and some
  poorly, and D5 requires saying which rather than implying coverage we do not have.

---

## 5. Open questions

1. **Where does analysis run?** It is CPU- and memory-hungry, and the review path is already the
   slowest required check on a PR. A separate stage with its own budget, feeding the review
   asynchronously, may fit better than an inline step.
2. **Which languages first?** Our own stack is TypeScript; customer repositories are not. Starting
   where we can validate against our own history is the honest order.
3. **How is the base-revision comparison computed?** Diffing findings between revisions needs stable
   finding identity — location alone is too fragile, since an unrelated edit above shifts every line.
4. **Do the CLI and desktop reviewers get this too?** They have a working tree rather than a
   checkout. ADR-033 D1 says one reviewer with two front doors, and a security capability that exists
   only on the bot would re-split what that decision joined.
5. **What is the false-positive budget?** D2/D3 make verification the filter, but verification costs
   model calls. If an engine emits 300 candidates per run, verifying all of them is not free, and
   pre-filtering by rule precision may be necessary before the adversarial pass.

---

## 6. How this will be judged

**Replay this release.**

> Take the merge commits from 0.4.20 and run the combined reviewer against the revisions that
> introduced each defect.

It must report the three SSRFs, the quadratic regex, and the credential storage — the findings the
model reviewer missed. It must NOT report the five path-guard "bypasses" that turned out to be
unreachable, nor the two ReDoS patterns whose character classes already excluded the delimiter.

That corpus is the right test precisely because we already know the answers, including which
plausible-looking findings are false.

Two supporting criteria:

- **Signal survives.** On a real PR, published findings are countable on one hand and each one names
  a source, a sink, and the path between them. If it publishes 300, D2 did not land.
- **A failed analysis is visible.** Break the engine deliberately; the review must say it was not
  analyzed rather than report no findings.

Not judged by: total findings, or catalogue coverage. **A security reviewer is judged by whether
people act on what it says**, and every additional false positive spends the credibility that makes
the true ones worth reading.
