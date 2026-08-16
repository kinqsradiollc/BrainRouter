# ADR-036 — The finding carries its code

**Status:** Accepted — implemented (2026-08-16, owner-accepted). D1/D6: `review_findings` now persists `code_excerpt` + `code_replacement` (migration 064), redacted on the way IN via `redactReviewSourceText` and bounded, threaded through `findingInput`/`normalizeFinding` (not part of the fingerprint) and surfaced by `listReviewFindingsForOrg`. D2–D5: the dashboard PR-review finding detail renders the finding's own hunk — reviewed lines + before/after proposal — via `ReviewCodeFrame`, escaped (untrusted source rendered as data), bounded with the truncation stated, using the `parseHunk`/`excerptRows`/`findingRows` logic ported verbatim from the desktop panel (one classification across surfaces, ADR-029). Open questions 1/3/5 (expandable context, syntax highlighter, deleted-file state) remain follow-ups.
**Depends on:** ADR-033 (review that finds things, and says where), ADR-025 (assurance programs),
ADR-019 (dashboard org/workspace context), ADR-028 (surfaces that tell the truth).

---

## 1. Where we are

The review console already shows a run and its findings: repository, PR number, branch → base,
severity counts, a per-finding card with title, description and `file:line` references, review
metadata (provider, author, trigger, head/base SHA), and the agent trace. The finding detail view has
a lifecycle — Open / In Progress / Snoozed / Fixed / Ignored — a TL;DR, a "How do I fix it?"
narrative, CWE, and an activity log.

What it does not have is **the code**.

A finding says `test-fixtures/vuln-sample.js:13`. To see line 13 — the thing the finding is
*about* — you leave. You open the pull request on GitHub, find the file, find the hunk, and read it
there. Every finding is a redirect.

That is the gap this ADR closes, and it is narrower than "render the pull request". The bot already
knows exactly which lines it is talking about; ADR-033 D4 exists precisely so a finding's line is
computed from the evidence it quoted rather than remembered. **We are not missing the data. We are
missing the panel that shows it.**

### 1.1 Why the redirect is expensive

- **It breaks the review at its most useful moment.** The reader has the explanation in front of
  them and must leave to see the subject of the explanation.
- **The context on GitHub is the wrong context.** GitHub shows the whole diff. The finding is about
  five lines, and the reader has to re-find them.
- **A fix suggestion with no before/after is an assertion.** "Validate the host against a strict
  allowlist" is advice; the same words beside the two versions of the line are a decision someone
  can make in seconds.
- **It leaks the review outside the product.** Triage, status, ownership and history live here; the
  evidence lives there. Splitting the two means neither surface is sufficient and both must be open.

---

## 2. The idea

> **A finding is not a pointer to code. It is code, with an explanation attached.**

So the unit the dashboard renders is not "the pull request" and not "a file" — it is **the finding's
own hunk**: the lines the bot reasoned about, the lines it proposes instead, and enough surrounding
context to read them. Everything else about the PR stays one click away, where it belongs.

---

## 3. Decisions

### D1 · Every finding carries its own excerpt, served from the review, not fetched from the forge

A finding persists the code it refers to: the file path, the line range, the exact lines at the
reviewed revision, and — where the bot proposes one — the replacement. The dashboard renders from
that record.

Not fetched live from GitHub at view time, for three reasons that are all the same reason:

- **A review is a statement about one revision.** The branch moves; a finding rendered against
  today's file is a finding about a different program than the one that was reviewed.
- **Viewing a finding must not need forge credentials**, a network round trip, or a rate-limit
  budget. A person reading last week's review should not be able to exhaust an API quota.
- **It must still render when the PR is gone** — closed, branch deleted, repository archived,
  access revoked. The review is our record.

> ADR-033 D3 already gives the bot a read-only view of the exact-SHA checkout. Capturing the lines
> it quoted is a small addition to a review that already had them in hand.

### D2 · The default view is the finding's hunk, not the file and not the diff

The panel shows the changed lines the finding is about, with a few lines of context either side, and
the file/line header as its title. Not the whole file; not the whole PR diff.

This is the decision that keeps the surface honest. A reviewer who wants the full diff should open
the pull request — that is what it is good at, and we will not do it better. What we can do better
is show **exactly the lines a finding is about, next to the reason it is a finding.**

### D3 · Before and after, when the bot proposes a fix

Where the bot suggests a change, the panel renders the original and the proposed replacement as a
diff: removed lines marked, added lines marked, line numbers preserved from the reviewed revision.

This is what turns "How do I fix it?" from prose into something reviewable. It is also the honest
place to say what the suggestion is: **a proposal, not a patch that has been applied or tested.**
The surface must not imply otherwise (ADR-028).

### D4 · Multiple locations are multiple blocks, in the order the finding names them

A finding that spans `vuln-sample.js:13` and `vuln-sample.js:3` renders two blocks. The require line
and the call site are both part of one argument, and collapsing them into one range would invent
context the finding did not claim.

### D5 · The excerpt is untrusted content and is rendered as data

Repository source reaches the browser here. It is attacker-influenced by definition — anyone who can
open a pull request can put arbitrary bytes in a file — so it is escaped, never interpreted:

- no HTML from the excerpt reaches the DOM as markup;
- syntax highlighting is applied to plain text after escaping, never by injecting spans from source;
- long lines wrap or scroll within their block and cannot break the page;
- the excerpt is bounded in lines and bytes, with the truncation stated rather than silent.

The same rule the agent side already applies to fetched pages and workspace data applies to a diff:
**it is data, and it is not permitted to become instructions or markup.**

### D6 · Redaction happens before persistence, not before display

Review source already passes through `redactReviewSourceText` on the way out of the checkout. The
stored excerpt is the redacted one, so a secret that appeared in a diff is not sitting in our
database waiting to be rendered. Display-time redaction would be the wrong layer: it would leave the
secret stored and rely on every future reader path remembering to strip it.

### D7 · Lifecycle and evidence live on the same screen

Status (Open / In Progress / Snoozed / Fixed / Ignored), severity, assignment and activity already
exist. They belong beside the code, because the decision they record — *is this real, and is it
fixed?* — is a decision about the code. A person should be able to read the lines, form a view, and
set the status without leaving.

### D8 · "Open pull request" stays, and stays honest

The escape hatch remains for everything this view deliberately does not do: full diff, file tree,
conversation, CI, merge. The button is not an admission of failure; it is the boundary of the claim.

---

## 4. What this explicitly does not do

- **It is not a PR client.** No file tree, no whole-diff browser, no review comments, no approve or
  merge. Those are GitHub's, and duplicating them badly would be worse than linking.
- **It does not apply fixes.** A suggested replacement is rendered, copied, or turned into a fix
  prompt. Writing it to the branch is a different decision with different authorization.
- **It does not re-review at view time.** The panel shows what the review found at the revision it
  reviewed. A stale finding is resolved by running a new review, not by silently re-rendering
  against a moved branch.

---

## 5. Open questions

1. **How much context is "enough"?** Three lines either side reads well and sometimes hides the
   reason. Expandable context is the obvious answer; the question is whether expansion is served
   from the stored excerpt (bounded, offline) or fetched (unbounded, needs credentials) — and D1
   argues for the former.
2. **What is the storage cost?** Excerpts are small individually and unbounded in aggregate across
   every finding of every review. Retention needs a rule, and it should be the same rule as the
   findings themselves.
3. **Highlighting: which lexer, and at what size?** A highlighter that ships every grammar is large;
   one that ships none is unreadable. There is likely a small set of languages that covers almost
   every finding we produce.
4. **Do desktop and dashboard share this component?** Both surface reviews. ADR-029's rule is one
   workspace across many surfaces, and two divergent renderings of the same finding would be exactly
   the split this repo keeps paying for.
5. **What does a finding on a deleted file show?** The excerpt is still valid for the reviewed
   revision; the file no longer exists on the branch. The panel should say so rather than render as
   though nothing changed.

---

## 6. How this will be judged

**One task, timed.**

> A reviewer opens a review with a high-severity finding they have not seen before, and decides
> whether it is real — **without opening the pull request.**

They must be able to read the flagged lines, the proposed replacement, and the reason, and then set
the status, all on one screen. If they have to open GitHub to decide, this ADR has not delivered.

Two supporting criteria:

- **A finding renders after the branch is gone.** Delete the branch, then open the review. The code
  is still there, because it was ours, not fetched.
- **A hostile file cannot break the page.** A source file containing `</script>`, ANSI escapes, a
  100,000-character line, and markup renders as visible text, bounded, with the truncation stated.

Not judged by: how closely it resembles GitHub. The goal is not to reproduce the pull request — it
is to make the pull request unnecessary for the question a reviewer actually has.
