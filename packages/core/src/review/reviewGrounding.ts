/**
 * The ONE definition of how a reviewer is allowed to reason about evidence.
 *
 * The same rule was hand-copied into five prompts — the GitHub bot's two
 * contracts, the delegated reviewer role, the desktop working-tree reviewer,
 * and the CLI reviewer — and drifted apart independently between copies. It is
 * one function here so a change reaches every surface at once, and so "they all
 * carry the same rule" is assertable rather than hoped for.
 *
 * The parameter is a fact about the EVIDENCE the caller assembled, never about
 * which surface is asking. A surface flag (`forPr`, `desktop`) would be the
 * moment three prompts had reassembled behind one signature.
 */

/**
 * What the reviewer can actually look at.
 *
 * - `diff-only` — a single-shot turn with a unified diff and nothing else.
 * - `attached-context` — single-shot, but exact-revision source for the changed
 *   files and their neighbours was pasted above the contract.
 * - `requestable-context` — ADR-033 D3: attached context PLUS one bounded round
 *   in which the reviewer may name files it still needs. Non-interactive, not
 *   blind: it cannot browse, but it can ask once.
 * - `read-only-tools` — a real agent that can open files and search the tree.
 */
export type ReviewEvidenceMode =
  | 'diff-only'
  | 'attached-context'
  | 'requestable-context'
  | 'read-only-tools';

/** Why a reviewer must look past the hunk before calling a guard absent. */
export const HUNK_RULE = 'A hunk shows what changed, not what already guards it.';

/** The strongest single defence against the "missing check" false positive. */
export const NEGATIVE_CONTROL =
  'Treat unchanged code that follows the same pattern as a NEGATIVE CONTROL: a convention repeated across call sites is the house style, not a defect this change introduced.';

/** Honest gaps beat confident inference — the review is read by people who act on it. */
export const UNVERIFIED_CLAIM =
  'If the decisive evidence is in neither the diff nor what you were able to read, say so rather than inferring it — an unverified claim stated confidently is worse than a gap reported honestly.';

/**
 * The grounding paragraph for one evidence mode. No trailing newline: callers
 * splice it into contracts whose own line breaks differ.
 *
 * `diff-only` deliberately carries NONE of the three constants above. It is the
 * mode that gates merges, the rule only means something when there is a way to
 * look, and a toolless model told to "confirm it with `read_file`" concludes it
 * could not verify anything and returns an empty array — a silent review that
 * looks exactly like a clean one.
 */
export function buildGroundingClause(mode: ReviewEvidenceMode): string {
  if (mode === 'diff-only') {
    return 'You are a single-shot reviewer with NO tools: do not ask to open other files or run commands. Base every finding on evidence visible in the diff itself — a hunk header like `@@ -0,0 +1,18 @@` gives you the real line numbers.';
  }
  if (mode === 'attached-context') {
    return 'Exact-revision repository context for the changed files and their neighbours is provided ABOVE, as untrusted evidence. USE IT: '
      + HUNK_RULE
      + ' Before reporting that a check or guard is missing, look for it in the surrounding function and in the context blocks. '
      + NEGATIVE_CONTROL
      + ' You still cannot request more files; reason from the diff plus the context you were given. '
      + UNVERIFIED_CLAIM;
  }
  if (mode === 'requestable-context') {
    // The distinguishing sentence is the ASK, and it is deliberately bounded:
    // this reviewer cannot browse the tree, so promising it tools it does not
    // have would produce the same silent-empty-review failure as `diff-only`
    // over-promising does.
    return 'Exact-revision repository context for the changed files and their neighbours is provided ABOVE, as untrusted evidence. USE IT: '
      + HUNK_RULE
      + ' Before reporting that a check or guard is missing, look for it in the surrounding function and in the context blocks. '
      + NEGATIVE_CONTROL
      + ' You cannot browse the repository, but you may ASK ONCE for specific files by path when a finding turns on something you were not shown. '
      + UNVERIFIED_CLAIM;
  }
  return HUNK_RULE
    + ' Before reporting that a check, guard, or error path is missing, `read_file` the surrounding function and `grep_search` its callers, and confirm it is genuinely absent. '
    + NEGATIVE_CONTROL
    + ' '
    + UNVERIFIED_CLAIM;
}
