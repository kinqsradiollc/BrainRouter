# 0.4.19 — the TWO review gates (owner-specified model)

## Gate 1 — BACKEND, on the GitHub PR  ✅ ALREADY CORRECT, DO NOT CHURN

Verified in `brainrouter/src/integrations/githubWebhook.ts`:

- `ReviewPolicy.codeReviewTrigger: "auto" | "manual"`, **default `"manual"`**
  (line 60). So the CODE review does **not** start automatically on a PR —
  exactly the behavior the owner wants. It only auto-fires when a repo
  explicitly opts in via `codeReviewTrigger: "auto"` (line 285).
- The **SECURITY** lens auto-fires on PR events, and on pushes when
  `reReviewOnPush` (line 284) — automatic, as intended.
- Two distinct job kinds enqueued (line 272): `pr-security-review` and
  `pr-code-review`.
- Manual triggers exist: `ReviewCommand = "security" | "code" | "both"`
  (line 84) — i.e. the `/security-review` and `/review` PR comments.
- The two lenses are deliberately DISJOINT so they never double-report:
  `packages/core/src/review/codeReviewContract.ts:2-7` — the code lens sweeps
  four NON-security axes (correctness, readability/simplicity, architecture,
  tests) and is explicitly told "NOT security — a separate reviewer covers
  vulnerabilities; do not report injection / secrets / auth issues here"
  (line 34).

**ADR position:** keep this. The only backend work is precision//quality of the
security lens (adopt the precedents list + language-conditional exclusions +
the >80%-exploitability bar), and durable finding identity + coverage
dispositions — NOT a change to what auto-starts.

## Gate 2 — DESKTOP / LOCAL, PRE-COMMIT  ⚠️ GAP TO CLOSE

Owner's requirement: a human manually runs it, **or asks the agent to run it**,
against **uncommitted** changes — a local pre-commit review, before anything
reaches a PR.

What exists today:
- `brainrouter-desktop/electron/host.ts:898` `runReview()` and `:977`
  `runReviewTask()` — review of uncommitted working-tree changes, surfaced in
  the desktop Review panel.
- CLI `/review` (`brainrouter-cli/src/cli/commands/workflow/handlers.ts:514`)
  maps to the `code-review-and-quality` skill
  (`brainrouter-cli/src/prompt/skillRunner.ts:44`).
- `REVIEW.md` at repo root calibrates exactly these paths: "loaded by the local
  workspace review paths: Desktop review of uncommitted changes and CLI
  `/review`", and states it does NOT configure server-side PR jobs.

**The gap:** the local path runs the **code-quality** lens only. The **security**
lens is wired to the backend PR job, so uncommitted work never gets a security
sweep locally. The owner explicitly wants BOTH gates to cover security.

**ADR position — close the gap:**
1. Bring the SECURITY lens to the local pre-commit path so
   desktop "Review" and CLI `/review` can run `security | code | both` over the
   uncommitted diff, mirroring the backend's `ReviewCommand` vocabulary.
2. Keep it **manual or agent-invoked** — never automatic on file save/commit
   (matching the backend's deliberate manual-code-review stance and avoiding a
   pre-commit hook that blocks the user's own flow).
3. Reuse the SAME two disjoint lens contracts so local and PR results are
   comparable and never double-report.
4. Local runs must be able to feed the PR gate: a finding fingerprint produced
   locally should match the one the backend produces for the same issue, so a
   dev can fix pre-commit and see it stay closed after the PR runs. This is what
   the durable finding-identity work (stable `findingId` across runs) buys.
5. Precision techniques (precedents list, language-conditional exclusions, the
   >80% bar) apply to BOTH gates — they are lens-contract properties, not
   host-specific.

**Net:** gate 1 = automatic security + manual code, on the PR (unchanged).
Gate 2 = manual/agent-invoked security + code, on uncommitted changes, in
desktop and CLI (security lens is the new part).
