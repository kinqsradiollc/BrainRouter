# ADR-039 — The half of security a model cannot see

**Status:** Accepted — scoped **this-repo-only** (2026-08-17). The D8 blocker (this-repo-only vs customer-facing) is resolved to the conservative scope: BrainRouter runs the flow/taint analysis on its OWN repository as a review input, with **no customer-facing offering** — so there is no third-party licensing exposure and the build is unblocked. (Expanding to a customer-facing product later would reopen D8 and need a licensing review; that is explicitly out of scope now.) Implementation is a phased program (flow-analysis engine against the exact-SHA checkout with its own DB-build stage, an owned barrier/source/sink model pack, and integration into the review pipeline) —  sized as its own track, not a single slice. **Down payment (0.4.21):** the concrete vulnerabilities this ADR cites as evidence were located + adversarially verified and fixed ahead of the engine — the ~23s quadratic-regex ReDoS on the recall/briefing path (#1413) and the LM Studio model-probe SSRF that was the unguarded "fourth path" (#1414). The three runtime provider-endpoint SSRFs (embeddings / rerank / memory-pipeline chat) are also fixed (#1416): a validate-then-fetch guard through `upstreamProbePolicy` refuses an internal target before dialing (self-hosted local backends opt in via `BRAINROUTER_UPSTREAM_ALLOWLIST`, documented in deploy/brain/README; a narrow DNS-rebinding TOCTOU is a noted follow-up). All six confirmed concrete vulnerabilities are now closed; the general flow/taint engine remains the separate track above.
**Depends on:** ADR-033 (review that finds things, and says where), ADR-036 (the finding carries its
code), ADR-025 (assurance programs), ADR-032 (an agent that gets better and cannot get worse).

---

## 1. Where we are

Our review is a model with tools, wrapped in deterministic orchestration. ADR-033 was explicit:

> *Deterministic engineering owns everything that must not go wrong. The model owns judgement.*

It delivered that for **orchestration** — which files are reviewed, how they bundle, where a finding
lands, whether it survives reflection. All code, none of it asking a model to remember.

The **analysis itself is entirely model judgement.** There is no data-flow analysis anywhere in
`reviews/` or `packages/core/src/review/`. Nothing computes that a value from a request body reaches
a `fetch`, that a query parameter reaches a shell, that a backtracking regex runs over a webhook
payload. The model reads a diff and forms an opinion.

That is half of a security review, and this release showed which half is missing.

### 1.1 The evidence, from one week

Two systems examined this repository and found **almost disjoint sets**.

**Flow analysis found; the model review did not:**

| finding | why an engine sees it |
|---|---|
| three provider-probe SSRFs, one full-read | a taint path: request body → `fetch`, no barrier between |
| a quadratic regex stalling the shared brain ~23s per PR comment | a property of the pattern plus the source of its input |
| session credentials in `localStorage` | a known sink with a known sensitivity class |
| `*` CORS origin combined with credentials | a two-property conjunction across files |

**The model review and investigation found; flow analysis did not:**

| finding | why an engine cannot see it |
|---|---|
| a missing `cleanup` value in a SQL CHECK that killed every review | a migration disagreeing with a TypeScript union — no value flows |
| an interrupted stage that could never be retried | a state-machine invariant across two modules |
| `git` absent from the shipped image | a property of the environment, not the source |
| the D7 outcome path with no untrusted-content guard | a missing authorization on a path that exists |

> **Neither subsumes the other, and the reason is structural.** Flow analysis answers *"can this value
> reach that sink"*. It cannot answer *"is this invariant true"*, *"does this run in the shipped
> image"*, or *"is this guard on every path that needs it"*. A model answers those and is unreliable
> at exhaustively tracing flows across files, because that is search, not judgement.

### 1.2 Why this matters more for generated code

AI-written code fails differently. It is **plausible**: it reads correctly, names things well, and
handles the obvious cases. The defects it leaves are disproportionately the ones that look fine
locally — a template string carrying user input into a query, a URL assembled from a parameter, a
regex that is correct but catastrophic, a guard applied on three paths of four.

Those are exactly what a flow engine is built to find and a reader is worst at. A review that is only
a reader, applied to code that is mostly generated, is weakest precisely where the code is weakest.

---

## 2. What this class of engine actually is

This matters because it determines the architecture, and getting it wrong produces a design that
cannot be built.

- **It is database-first, not file-first.** The tool's primary job is to *build a database*: compile
  or trace the codebase into a relational representation, then evaluate queries against that. The
  analysis unit is a whole snapshot of a buildable project — **not a diff, and not a file**.
- **Queries are declarative and carry metadata.** A security query declares `@precision`,
  `@security-severity`, `@kind`, and tags. A `path-problem` query returns not a location but a
  **path**: source → intermediate nodes → sink.
- **Suites select on that metadata.** "Which queries run" is a declarative suite that includes, for
  example, high and very-high precision security queries plus medium precision ones whose severity
  is error or warning. Precision filtering is a first-class concept, not something a consumer builds.
- **The taint model is source / sink / barrier.** A configuration declares what is a source, what is
  a sink, what *sanitizes* (a barrier), and what extra steps propagate taint.
- **The model can be extended as data, without writing queries.** Framework knowledge ships as YAML
  data extensions that add rows to extensible predicates — `sourceModel`, `sinkModel`, `barrierModel`
  and friends — keyed by type, access path and kind. Teaching the engine about a library, or about
  *our own* code, does not require forking the query pack.
- **Incremental, diff-aware evaluation is an engine concern.** Recent configurations opt into a
  diff-informed mode; it is not something a consumer implements on top.
- **The engine is licensed separately from the queries.** The standard queries and libraries are
  open source; the CLI and engine are a separate artifact under a separate licence, and analysing
  **closed-source** code with it requires a **commercial licence**.

That last point is not a footnote. It decides what we may ship, to whom.

---

## 3. Decisions

### D1 · Analysis is a review INPUT, not a parallel bot

Results enter the pipeline as **candidates on the same footing as model-proposed findings** — same
positioning (ADR-033 D4), same reflection pass (D5), same publication gate.

Not a second bot posting a second comment. A reviewer that received one more source of evidence.

> A separate scanner comment is how you get 300 alerts nobody reads. A candidate that must survive
> verification is how you get 11 that matter.

### D2 · Every engine finding is adversarially verified before it publishes

An engine says a path exists. Whether it is *reachable*, *guarded*, or *exploitable* is judgement —
and it is the judgement a model is genuinely good at when handed a specific claim and the code around
it. The verifier's job is to REFUSE: name the entry point an attacker controls and each hop to the
sink, and if a guard already blocks it, the finding dies.

This release is the argument. Of eight "critical" SSRF alerts, **three were real**. Of 98
"missing rate limiting", the chokepoint largely already existed. Of 77 ReDoS alerts, the two checked
by hand could not be reproduced, because their character classes excluded the delimiter. Publishing
raw output would have filed five false positives and buried three real ones.

### D3 · We select by precision, we do not invent our own filter

Query metadata already encodes precision and severity, and suites already select on it. Our
configuration is *which suite*, plus explicit additions — not a bespoke scoring layer that
re-implements, worse, a decision the query author already made.

An earlier draft of this ADR proposed exactly that bespoke pre-filter. It was wrong: it would have
discarded the query author's own precision judgement and replaced it with ours.

### D4 · We model OUR barriers, or we will drown in our own fixed code

This is the decision most likely to be skipped and most likely to hurt.

A generic taint model does not know that `fetchUpstreamWithPolicy` is the SSRF chokepoint, that
`redactReviewSourceText` sanitizes source before it is stored, that `isSafeRepositoryRelativePath`
plus inventory membership bounds a path, or that `asUntrustedWorkspaceText` fences attacker content.
Without being told, the engine will keep reporting the code we fixed *this week* — and a scanner that
re-reports fixed code is one people learn to ignore.

Barriers are declarable as data. So this is a **model pack we own and version alongside the code**:
when a new chokepoint is introduced, its barrier row lands in the same PR. A chokepoint the analyser
does not know about is a chokepoint that generates false positives forever.

### D5 · The database step is where the cost lives, and it is not per-diff

Because analysis is database-first, it cannot be run per-bundle inside the review the way a model
call can. Building the database is the expensive step, and it is proportional to the repository, not
to the change.

So: analysis runs as its **own stage with its own budget**, against the same exact-SHA checkout
(ADR-033 D3), and feeds the review asynchronously. A review must not block on it, and — per ADR-033
D8 — must not hold the merge gate when it is unavailable.

An earlier draft of this ADR described a synchronous `analyze(checkout, ruleSet) → candidates` port.
That was written without knowing about the database step, and it would not have survived contact with
a real repository.

### D6 · A path is evidence, and we should carry it

Queries return source → hops → sink, which is strictly richer than the location a model finding
carries. ADR-036 asks that a finding carry the code it is about; a flow path is the best version of
that we can get — it shows not only *where* but *how*.

Normalizing a path down to a single line would throw away the most useful thing the engine produces.

### D7 · Rules for OUR failure modes, not only the catalogue's

The standard catalogue would not have caught the schema/type drift, the retry trap, or the guard
missing from one path. Those are ours, and we now know their shapes.

Where a failure is mechanically checkable it should become a check —
`migrations.stageParity.test.ts` is already one, written after the `cleanup` outage. This decision
makes that a program: **every incident that produced a rule in `brainrouter-rules` should be asked
whether it can be a query instead.** A rule a human must remember is weaker than one that fails a
build.

### D8 · Licensing decides the scope before engineering does

The engine's licence permits open-source analysis; **analysing closed-source code requires a
commercial licence.** Our product reviews customers' private repositories. So:

- using it on **this** repository, via the code scanning already configured here, is settled and
  needs no decision;
- shipping it as a capability that runs against **customer** code is a commercial question that must
  be answered before any engineering is scheduled;
- D1's port boundary therefore earns its keep for a second reason: if the answer is no, the same
  seam accepts a differently-licensed engine without the review pipeline changing.

**This must be resolved first.** Building the integration and then discovering we cannot ship it is
the expensive order.

---

## 4. What this does not do

- **It does not replace the model reviewer.** Half this release's findings came from judgement, and
  they were the expensive half — a four-day outage and a permanently wedged run.
- **It does not gate merges on the full backlog.** New findings against base; a PR is responsible for
  what it introduced.
- **It does not promise language parity.** Coverage differs by language, and D5's honesty rule means
  saying which rather than implying coverage we lack.
- **It does not report absence as safety.** If analysis could not run — unsupported language,
  timeout, extraction failure — the review says *"not analyzed"*, in the same voice it uses for a
  diff-only fallback. Golden rule 23 applied to the new half.

---

## 5. Open questions

1. **The licence, first.** See D8. Everything else is contingent.
2. **Where does the database get built, and how often?** Per PR is expensive; per default-branch
   commit with a diff-aware pass on top may be the shape, but it needs measuring on a real repository
   rather than assuming.
3. **How is finding identity kept stable across revisions?** Location alone is too fragile — an edit
   above shifts every line. A path-based identity may be more stable, and that needs testing.
4. **Who writes and reviews the barrier model pack?** D4 only works if it is maintained. If adding a
   chokepoint without its barrier row is possible, it will happen.
5. **Do the CLI and desktop reviewers get this?** They have a working tree, not a checkout, and no
   database. ADR-033 D1 says one reviewer with two front doors; a capability that exists only on the
   bot re-splits what that decision joined.

---

## 6. How this will be judged

**Replay this release.**

> Take the merge commits from 0.4.20 and run the combined reviewer against the revisions that
> introduced each defect.

It must report the three SSRFs, the quadratic regex, and the credential storage — the findings the
model reviewer missed. It must NOT report the five path-guard "bypasses" that proved unreachable, nor
the two ReDoS patterns whose character classes already excluded the delimiter.

That corpus is the right test precisely because we know the answers, **including which
plausible-looking findings are false.**

Three supporting criteria:

- **Fixed code stays fixed.** Run it against `HEAD` after the SSRF fix. If it still reports
  `modelProbe.ts`, D4's barrier model is missing or wrong, and the integration is not ready.
- **Signal survives.** On a real PR, published findings are countable on one hand, and each names a
  source, a sink, and the path between them.
- **A failed analysis is visible.** Break the engine deliberately; the review must say it was not
  analyzed rather than report no findings.

Not judged by: total findings, or catalogue coverage. **A security reviewer is judged by whether
people act on what it says**, and every false positive spends the credibility that makes the true
ones worth reading.
