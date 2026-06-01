import type { AccessMode } from '../../runtime/exec/execPolicy.js';

/**
 * REVIEW-FIX (0.4.7) — the single authoritative `/review` orchestration prompt.
 *
 * Previously `/review` reached the model as TWO conflicting instruction sets:
 * the generic five-axis `code-review-and-quality` skill body ("evaluate
 * correctness/readability/architecture/security/performance, fill the
 * checklist") AND this high-signal-only fan-out workflow. The contradiction
 * (review everything vs. flag only definite bugs/guideline breaks) helped the
 * weaker OS model collapse the whole thing onto one explorer child. This module
 * is now the *only* set of instructions for `/review` — run directly, with the
 * skill latched solely so memory recall still sees the review context.
 *
 * Two more collapse fixes live here:
 *  - the diff is **injected** (no explorer spawn just to read it), and
 *  - the report write is **access-aware**: a write/shell session has the parent
 *    write `review.md`; a read-only session prints findings to chat (it cannot
 *    write, and asking a read-only child to do it is exactly what failed).
 */
export interface BuildReviewPromptOptions {
  scope: string;
  slug: string;
  reportPath: string;
  /** `git diff HEAD`, already collected + capped by the CLI. */
  diff: string;
  diffTruncated: boolean;
  /** The session's access mode — decides who (if anyone) writes the report. */
  accessMode: AccessMode;
  /** `--fix`: apply surviving fixes + re-verify (write/shell only). */
  fix: boolean;
}

export function buildReviewPrompt(opts: BuildReviewPromptOptions): string {
  const { scope, slug, reportPath, diff, diffTruncated, accessMode, fix } = opts;
  const canWrite = accessMode === 'write' || accessMode === 'shell';

  const steps: string[] = [
    '# Code Review',
    '',
    `Provide a code review for: ${scope}`,
    '',
    '**You are the lead reviewer. Drive every step yourself** — spawn children only',
    'for the parallel review/validation fan-out (Steps 4–5). Do NOT hand the whole',
    'workflow to a single child; that loses the orchestration.',
    '',
    '**Agent assumptions (applies to all subagents launched here):**',
    '- All tools are functional and will work without error. Do not test tools or make exploratory calls.',
    '- Only call a tool if it is required to complete the task. Every tool call should have a clear purpose.',
    '',
    '## Required memory-first opening',
    'Run `memory_search` for similar past reviews and `memory_file_history` for any files touched by this diff. Pass relevant record IDs to children via `seedRecordIds`.',
    '',
    `Workflow slug: \`${slug}\`. Output file: \`${reportPath}\`.`,
    '',
    '## The diff under review',
    'The diff is provided below — do NOT spawn a child just to read it. If it is',
    'truncated, you may read specific files for missing context.',
    '',
    '```diff',
    diff.trim().length > 0 ? diff.trimEnd() : '(no diff content)',
    '```',
    diffTruncated ? '\n_(diff truncated above; read files directly for any elided regions.)_' : '',
    '',
    '## Step 1: Triage',
    'Decide whether this review should proceed: is the scope closed/draft, trivial, or already reviewed? If so, stop here and tell the user.',
    '',
    '## Step 2: Locate guidelines',
    'Use `task_agent` (role=explorer, access=read) to return the list of file paths (not contents) of ALL relevant guideline files: root `AGENT.md`/`AGENTS.md`/`CLAUDE.md`, and any of those in directories containing files modified by this scope.',
    '',
    '## Step 3: Summary',
    'Summarize the changes from the diff above (no child needed).',
    '',
    '## Step 4: Parallel review (4 agents in ONE message)',
    'Launch 4 `task_agent` calls IN PARALLEL — single assistant message, four tool_calls:',
    '- Agents 1+2 (CLAUDE.md/AGENTS.md compliance, role=reviewer access=read): audit changes for guideline compliance. When evaluating compliance for a file, only consider guideline files that share a path with the file or its parents.',
    '- Agents 3+4 (bug hunters, role=reviewer access=read): scan for obvious bugs and incorrect logic in the diff. Focus only on the diff itself without reading extra context. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues you cannot validate from the diff alone.',
    '',
    '**HIGH SIGNAL ONLY filter (CRITICAL):** Only flag issues where:',
    '- Code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references).',
    '- Code will definitely produce wrong results regardless of inputs (clear logic errors).',
    '- Clear, unambiguous guideline violations where you can quote the exact rule being broken.',
    '',
    '**Do NOT flag:**',
    '- Code style or quality concerns.',
    '- Potential issues that depend on specific inputs or state.',
    '- Subjective suggestions or improvements.',
    '- Pre-existing issues.',
    '- Issues a linter will catch (do not run the linter to verify).',
    '- General code-quality concerns (test coverage, security) unless explicitly required by AGENTS.md.',
    '',
    'If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.',
    '',
    '## Step 5: Validate',
    'For each issue found in Step 4, launch a parallel `task_agent` (role=reviewer access=read) to validate the claim. Each validator gets the issue description and confirms it is truly an issue with high confidence by re-checking the relevant code.',
    '',
    '## Step 6: Filter',
    'Drop any issue that did not validate in Step 5. The survivors are the high-signal issues.',
    '',
  ];

  // Step 7 — access-aware output. The PARENT holds the access; a read-only
  // session cannot write the report (and must not delegate it to a read child).
  if (canWrite) {
    steps.push(
      '## Step 7: Output',
      `\`write_file\` to \`${reportPath}\`: severity-ordered findings (Critical / Important) with file:line citations and concrete fix suggestions. If no issues survived filtering, the report says "No issues found. Checked for bugs and guideline compliance."`,
    );
  } else {
    steps.push(
      '## Step 7: Output (read-only session)',
      'You are in **read** mode and cannot write files. Do NOT call `write_file` and do NOT spawn a child to write — print the findings directly to chat:',
      'severity-ordered (Critical / Important) with file:line citations and concrete fix suggestions. If nothing survived filtering, say "No issues found. Checked for bugs and guideline compliance."',
      `Then tell the user: "Re-run \`/review\` in write mode (e.g. \`/policy workspace\`) to persist \`${reportPath}\`."`,
    );
  }

  if (fix) {
    // --fix is only reachable in write/shell (the caller blocks it in read mode).
    steps.push(
      '',
      '## Step 8: Apply fixes (--fix)',
      'For each surviving high-signal issue, apply the **minimal** fix that resolves exactly that finding:',
      '- Edit in place (`write_file`); keep each fix tightly scoped to the cited `file:line`. Do NOT refactor unrelated code, rename things, or fix issues you did not flag.',
      '- After applying ALL fixes, run the project build + tests via `run_command` (e.g. the workspace `npm run build` / test script) to confirm nothing regressed.',
      '- If the build/tests break, identify the offending fix, revert just that one edit, and mark it `needs-manual` in the report with the failure reason. Never leave the tree in a broken state.',
      '',
      'Then update the report: for each finding, append a `Fixed` / `needs-manual (reason)` status. Summarize ≤ 15 lines in chat: what was fixed, what was left for the human (and why), and the final build/test result.',
    );
  } else if (canWrite) {
    steps.push('Then summarize ≤ 15 lines in chat referencing the file. Do NOT edit reviewed files.');
  }

  return steps.filter((line) => line !== undefined).join('\n');
}
