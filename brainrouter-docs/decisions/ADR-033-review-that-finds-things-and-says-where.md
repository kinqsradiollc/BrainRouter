# ADR-033 — Review that finds things, and says where

**Status:** ACCEPTED — approved by the owner for implementation.

**Implementation status (2026-08-12): PARTIAL, and the split is clean rather than ragged.**

**Shipped AND reached** — D1, D2, D3, D4, D5, D8 and D9 are engineering, and every one of them is
live on a path a user reaches: the bot through the scheduler executors, the CLI `/review` handler,
and the desktop host. Verified deterministically — `review-orchestration` 8/8, `review-bundles`
18/18, `review-position-and-reflection` 19/19. D6 is a stance and lives in the prompt.

**The one gap, stated precisely: D7's harness runs against real providers but no *qualifying* number
has been recorded.** It exists, it runs, and as of 2026-08-26 it has been exercised against five
hosted models (see below) — every free one fails the strict findings-envelope on the real prompt, and
the one frontier model reached was blocked by an empty provider balance. That is why this ADR is
PARTIAL and not COMPLETE, and it is a measurement gated on **funded frontier access** rather than code
that was not written.

This is deliberately not called "the live-model half is unproven" any more, which was the earlier
wording and was vaguer than the facts deserve: the deterministic engineering is done and reached,
and exactly one conjunct — a number from the harness — is outstanding.
**Implementation status (2026-08-12):** PARTIAL, and precisely one conjunct short. The shared
orchestration, evidence safety and paired fail-closed benchmark harness are implemented and reached
on a user path; the deterministic COST conjunct of §6 passes: bundled sends **516,672 characters in
16 calls versus legacy's 545,529 in 12** (−28,857, −5.29%), down from +33,537 before.

**What D7 still owes is a QUALITY number — precision and recall — and it is blocked on a provider,
not on code.** The corpus exists and is frozen (`benchmark/data/review-cases.json`, schema 2, 11
cases: 7 carrying curated known issues, 4 clean with explicit no-linked-fix evidence, observation
cutoff 2026-08-09, ground-truth bias restated inside the data). The runner exists
(`npm run bench:review -w @kinqs/brainrouter-mcp-server -- --provider-config=…`) and is
paired-only by design, because a lone arm cannot prove a delta.

**The harness has now been RUN, and it works** (2026-08-12, against a local `qwen2.5-coder` on
Ollama through the loopback exemption the provider resolver already allows). That is a change of
kind: this document previously said the runner "ships and has never produced a number", which left
open whether it would even execute. It does. It prepared exact-revision evidence from a local
checkout, executed both arms of case `pr-743` across six model calls, scored them, and wrote its
machine-readable artifact.

**What it demonstrated is that the number needs a better model than a local one**, and the evidence
is specific rather than a shrug:

- `qwen2.5-coder:7b` failed on its FIRST call — it could not produce the fenced findings envelope at
  all (`reviewer returned malformed JSON findings`).
- `qwen2.5-coder:14b` produces the envelope reliably, completed `pr-743` — and found **nothing**:
  legacy 0/0, bundled 0/0, on a case carrying curated known issues. It then failed `pr-1242` with
  `reviewer returned one or more invalid findings`.

Zero recall on a case with planted defects is not a formatting problem, so a third local model is
not the answer; the wall is reviewing capability. D7's number therefore needs a frontier-class
provider, which is the owner's key to supply.

**The harness has since been run against five real providers (2026-08-26), and the wall is now
precisely located.** The paired runner was pointed — via a provider-config naming an `apiKeyEnv`, so
no key ever touched the config or a log — at hosted models through the owner's OpenRouter and
OrcaRouter accounts. The model-independent input-cost diagnostic reproduced §6's cost half exactly
(bundled **516,672** vs legacy **545,529** characters, **−28,857 / −5.29%**), so the harness itself
is proven end to end. What every *free* model did was **complete the call and then fail the strict
findings-envelope on the real review prompt** — a formatting failure the parser refuses to launder
into a clean zero-finding report:

- a hosted reasoning model *did not end* with the fenced envelope (its answer trailed off after the
  reasoning trace);
- **DeepSeek-V4-pro** and **Nemotron-3-Ultra-550B** returned *no* envelope at all — and Nemotron has
  a **1 M-token context**, so the 280 K-char prompt was nowhere near its limit. That rules OUT
  context size as the cause: the wall is the complex, multi-constraint review contract itself, which
  the open models honour on a toy prompt but not on the real one.

The one genuinely frontier, envelope-clean model reached in probing — a **GPT-5.1 codex-class**
model — was blocked before the corpus by **`402 Payment Required`**: the OpenRouter balance could not
cover even one full request. So the residual gate is now specific and small: **funded frontier
access**. Add credits to a frontier provider (or point the config at one already funded), then run
the single `bench:review` command in §6 — the corpus, runner, safety discipline and cost half are all
in place and reproduced; only the paid quality measurement remains, and it is the owner's to unlock.

**Both failures are evidence FOR the design, and worth keeping.** A malformed envelope and an
invalid finding each aborted the run and wrote an explicitly FAILED artifact. Neither degraded into
a zero-finding report that would have read as a clean review — which is exactly the outcome
`parseReviewFindingsEnvelope`'s strictness exists to prevent, and it was the temptation when the
first run failed: loosening that parser would have "fixed" the run by turning a loud failure into a
silent one.

A run was attempted on 2026-08-12 against a local OpenAI-compatible endpoint. It failed — the server
listed models but served no completions — and that failure is worth recording rather than hiding,
because it exercised §6's own discipline for the first time against a REAL provider fault instead of
the synthetic bootstrap case the tests cover: six bounded retries, then a `status: "failed"`
artifact at mode 0600 carrying corpus identity, zero completed cases and the one attempted model
call. **It did not become a zero-finding report**, which is the failure mode that would have made
every other number in this ADR untrustworthy.

What closed it was a mis-scoped budget rather than any relaxation of D2/D3/D5/D9. The
repository-context cap was applied PER UNIT, so a review's evidence budget grew with how many units
it happened to split into, and two units whose impact packets shared dependencies materialised that
shared context twice. Measured per case, that single effect was the whole regression: two cases that
split one call into two accounted for 33,028 of the 33,537 excess, while every case that split into
genuinely unrelated units was already cheaper (one saved 21,946). The budget now belongs to the
REVIEW and is divided across its units — bundling changes how evidence is divided, never how much a
review may spend. Single-unit reviews are byte-identical, and the same rule is applied in production
so the measured number describes what the bot actually does.

**§6 is still not satisfied.** It is a conjunction, and only the cost half is demonstrated. The
PRECISION half — strictly higher semantic precision, and the known defect reported on the correct
reviewed-revision line — requires a real provider run on the frozen corpus and has not been made.
Nothing here should be read as evidence about review quality; a cheaper review that finds less would
satisfy this number and fail the ADR.
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

The result **published for that split** is worth stating because it argues against our instinct:
higher precision at a small fraction of the cost, with recall deliberately traded away. That figure is
someone else's measurement on someone else's corpus — it is the reason to try the shape, and it is not
evidence about ours. Ours is D7's job, and until D7 has run we have no number of our own.

The argument we are adopting, independent of any figure: a reviewer that reports less and is right is
more useful than one that reports more, because a reviewer nobody trusts gets muted.

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
recall, wall-clock, and cost per run (characters and model calls — see §6 for why not tokens).

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

### 5.1 What the implementation settled

1. **The existing code graph answers it, and it had to be asked first.** The parser-backed index
   built at the reviewed revision already records `imports` / `calls` / `tests` / `configures`
   between symbols, so mapping those edges back to paths groups a route with the handler it calls
   even when neither hunk mentions the other. The diff's own import lines remain as the floor for a
   review with no checkout, but they are thin on their own: a unified diff shows three lines of
   context around each hunk, and a file's imports sit at the top, so a change that does not touch
   the import block produces no edges at all. Consulting the graph is also why the plan is now built
   *after* the evidence packet rather than straight off the diff.
2. **Concurrency is an injected number, not a constant** — four bundles in flight per review, chosen
   by the scheduler that knows whose budget is being spent. Every unit is still charged against the
   same model-call and duration budget, so parallelism changes the shape of the spend, not its size.
3. **The local front doors now use the same orchestration.** CLI and Desktop collect the complete
   working-tree diff, prepare it with the same source-safety policy, plan semantic bundles, run them
   concurrently within an injected cap, compute positions from diff evidence, deduplicate, and run
   reflection. Each bundle receives an isolated read-only reviewer Agent; malformed or incomplete
   output cannot become a clean result.
4. **Ground truth is conceptual and semantic, with negative controls.** The frozen corpus contains
   manually curated issues traced from later standalone fixes. Each label is one conceptual defect,
   with explicit semantic aliases and every eligible location in the reviewed revision; a finding
   must match the issue meaning as well as its file. Clean controls mean no linked later fix was
   observed by the cutoff, not proof of no latent defect. The bias remains toward defects that were
   noticed and fixed, so only the paired delta is an acceptance signal.

---

## 6. How this will be judged

**One number and one behaviour.**

The number: **precision on the D7 benchmark goes up, and cost per review goes down.** Both, or the
split in §2 did not buy what it claims.

Cost is measured in **characters sent and generated, plus model calls** — not tokens. We do not run a
tokenizer: every provider uses a different one, so a token count here would be true for one model and
wrong for the rest, and the claim above is a RATIO between two arms rather than an absolute budget.
Across the same corpus and the same model, characters move with tokens, which is all a delta needs.
Stated plainly because "tokens" is the word everyone reaches for, and using it for a number nobody
tokenized would be a measurement we did not take.

The behaviour: **take a real merged PR with a known defect, and check that the finding lands on the
right line.** Not the right file — the right line. Everything else in this ADR is in service of a
person looking where they were told and finding the thing there.

### How that number gets produced

A delta needs two measurements, so the command always runs both arms over the entire frozen corpus
with one explicitly configured provider and the code-review lens. There is no single-arm, partial
corpus or lens override:

```sh
npm run bench:review -w @kinqs/brainrouter-mcp-server -- \
  --provider-config=/absolute/path/review-provider.json
```

The JSON file names `endpoint`, `model`, `apiKeyEnv`, and optionally `wireFormat`; the secret lives
only in the named environment variable. Missing configuration, provider errors, malformed logical
output, unavailable evidence, or a dirty implementation worktree fail non-zero instead of becoming
an empty finding set. A complete or explicitly failed mode-0600 JSON artifact is written under
`brainrouter/benchmark/results/review/` by default and records the repository/corpus/model identity,
every call, both arms, total prompt-plus-completion characters, deltas and the conjunctive
acceptance decision. A completed run exits zero only when semantic issue precision rises, total
model characters fall, at least one known defect lands on its correct line, and neither arm has a
provider or logical failure. No qualifying live artifact is recorded in this ADR yet.

The production-evidence, model-independent input diagnostic is reproducible with:

```sh
npm run bench:review:input-cost -w @kinqs/brainrouter-mcp-server
```

It currently records 545,529 characters and 12 calls for legacy versus 579,066 characters and 16
calls for bundled. Bundled is therefore 33,537 characters (6.15%) larger before completion output is
counted. Deterministic relationship and artifact-level projection work reduced the bundled baseline
by 98,914 characters and 12 calls without joining unrelated files, but the remaining result is still
affirmative evidence that the cost claim has not been earned. This diagnostic is explicitly
non-qualifying for §6 quality. The paired provider benchmark also requires a clean committed tree so
its repository identity is reproducible; the intentionally uncommitted implementation under review
cannot produce a qualifying artifact.

Three things about the report are deliberate, because each of them was wrong once:

- **Precision is reported twice** — "right file" and "right line". A finding anywhere inside a file
  that happens to contain a known defect satisfies the first and not the second, and §6 is asking
  about the second.
- **Completion characters are counted, not just prompt size.** The reflection pass and the D3 second
  round are extra generations; a cost claim that measures only the prompt would miss them.
- **The ground truth's line numbers are recorded in the REVIEWED revision.** They are taken from
  `git blame --porcelain`, which reports the line's position in the commit that introduced it —
  not its position in the fix commit's parent, which is a different revision that later commits have
  already shifted. A defect naming a file the reviewed revision does not contain is dropped rather
  than shipped, because it is unfindable by construction and would depress recall forever.
