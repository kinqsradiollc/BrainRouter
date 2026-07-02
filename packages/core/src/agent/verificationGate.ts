/**
 * CC-P6.5 — verification-before-done gate (0.4.15 thread B; scoping hardening).
 *
 * When a turn WRITES FILES (file edits / writes / patches, or a file-writing
 * shell command) it should not end claiming success without running SOME
 * verification — a build, a test, a typecheck — at least once. The strong
 * reference agents treat "I changed code, did I prove it works?" as a contract;
 * weak models happily declare "done, all fixed" having run nothing. This is the
 * exact counterpart of the `verificationRate` metric in the behavior benchmark
 * (CC-P8.1), so enforcing it moves the number it measures.
 *
 * SCOPING CONTRACT (the guardrail must be precise):
 *  - It triggers ONLY when the current turn actually wrote files and ran no
 *    relevant verification. A read-only turn (or a turn that only ran shell
 *    commands like `git status` / `ls` / `grep`) must NOT trip it, and it is
 *    purely a function of THIS turn's tool calls — never of a workspace/session
 *    switch (those don't run a turn, so they can't fire it).
 *  - A DOCS-ONLY or CONFIG-ONLY change (every written file is .md/.json/.yml/…)
 *    needs no build/test; instead of demanding a check, the gate asks the agent
 *    to state EXPLICITLY that no verification was required.
 *
 * Pure classifiers here; the runTurn guard tracks the files written + whether a
 * check ran, then fires ONE bounded nudge at turn end.
 */

const VERIFY_COMMAND =
  /\b(npm (run )?(test|build|lint|typecheck)|pnpm (test|build|lint)|yarn (test|build|lint)|vitest|jest|tsc\b|node --test|pytest|cargo (test|build|check|clippy)|go (test|build|vet)|make (test|check|build)|ruff|mypy|eslint|tsx? .*\.test\.)/i;

/**
 * Shell commands that clearly write files (so the verification contract should
 * apply). Read-only commands (git status, ls, cat, grep, find, …) deliberately
 * do NOT match — they are not "writing files" and must not trip the guardrail.
 */
const WRITE_COMMAND = /(^|[\s;&|(])(?:mv|cp|rm|rmdir|mkdir|touch|tee|ln|dd|sed\s+-i|perl\s+-p?i|patch)\b/i;
/** A redirect that writes to a real file (excludes `2>&1`, `>/dev/null`). */
const REDIRECT_WRITE = /(^|[^0-9>&])>>?\s*(?!&|\/dev\/null\b)[\w./~-]/;

/** True iff a `run_command` shell string clearly writes files. Pure. */
export function commandWritesFiles(command: string): boolean {
  const cmd = command ?? '';
  // Blank out single-/double-quoted arguments first, so a `>` or a write-verb
  // that lives INSIDE a quoted pattern (e.g. `grep 'a > b' *.ts`,
  // `grep -rn "rm -rf" src`) is not mistaken for a real redirect / mutation.
  // A read-only investigation that greps for such strings must not trip the
  // verification guardrail.
  const unquoted = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return WRITE_COMMAND.test(unquoted) || REDIRECT_WRITE.test(unquoted);
}

export const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch']);

export type VerificationSignal = 'mutated' | 'verified' | 'none';

/**
 * Classify a single tool call's effect on the verification contract:
 *  - a `run_command` running a build/test/lint → VERIFIED;
 *  - a file-writing tool (edit) or a file-writing shell command → MUTATED;
 *  - everything else (reads, non-writing shell commands) → NONE.
 * Narrowed from the original "any non-verify shell command is mutated": a
 * read-only command no longer counts as a file write, so the guardrail fires
 * only when the turn actually wrote files. Pure.
 */
export function classifyForVerification(toolName: string, commandText?: string): VerificationSignal {
  if (toolName === 'run_command') {
    const cmd = commandText ?? '';
    if (VERIFY_COMMAND.test(cmd)) return 'verified';
    return commandWritesFiles(cmd) ? 'mutated' : 'none';
  }
  if (EDIT_TOOLS.has(toolName)) return 'mutated';
  return 'none';
}

/** Documentation + configuration file extensions/dotfiles that need no build/test. */
const DOCS_CONFIG_NAMES = new Set([
  // docs — only CLEAR documentation formats (`.txt` is intentionally excluded:
  // it is ambiguous — could be a data fixture — so it isn't ruled docs-only).
  'md', 'markdown', 'mdx', 'rst', 'adoc',
  // config / data
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'lock', 'properties', 'env', 'editorconfig', 'gitignore', 'gitattributes',
  'npmrc', 'nvmrc', 'prettierrc', 'eslintignore', 'dockerignore',
]);

/**
 * True iff a path is a documentation or configuration file (so a turn that only
 * touched such files needs no build/test/typecheck/lint). Handles both
 * extensions (`README.md`, `tsconfig.json`) and extensionless dotfiles
 * (`.gitignore`, `.npmrc`). Pure.
 */
export function isDocsOrConfigPath(filePath: string): boolean {
  const base = (filePath ?? '').split(/[\\/]/).pop() ?? '';
  if (!base) return false;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    if (DOCS_CONFIG_NAMES.has(ext)) return true;
  }
  // Extensionless dotfile, e.g. `.gitignore`, `.npmrc`, `.editorconfig`.
  if (lower.startsWith('.') && DOCS_CONFIG_NAMES.has(lower.slice(1))) return true;
  return false;
}

export type VerificationDecision = 'none' | 'verify' | 'report-docs-only';

/**
 * Decide, at turn end, whether to nudge — and how. Pure.
 *  - `none`: the turn wrote no files, OR a verification already ran, OR we
 *    already nudged this turn. (A workspace/session switch never reaches here.)
 *  - `report-docs-only`: every file the turn wrote is docs/config and no opaque
 *    file-writing shell command ran → ask the agent to state that no
 *    verification was required (don't demand a build/test).
 *  - `verify`: the turn wrote code (or an opaque shell write) without verifying
 *    → demand the relevant check.
 */
export function decideVerification(input: {
  filesWritten: string[];
  /** A file-writing shell command ran whose written path(s) we can't classify. */
  shellWroteUnknown: boolean;
  verified: boolean;
  alreadyNudged: boolean;
}): VerificationDecision {
  if (input.alreadyNudged) return 'none';
  const wroteFiles = input.filesWritten.length > 0 || input.shellWroteUnknown;
  if (!wroteFiles || input.verified) return 'none';
  if (
    !input.shellWroteUnknown &&
    input.filesWritten.length > 0 &&
    input.filesWritten.every(isDocsOrConfigPath)
  ) {
    return 'report-docs-only';
  }
  return 'verify';
}

/**
 * Back-compat boolean decision (mutated && !verified && !alreadyNudged). Kept
 * for any caller that only needs "should I nudge to verify?"; `decideVerification`
 * is the richer, docs-aware entry point. Pure.
 */
export function shouldNudgeVerification(input: {
  mutated: boolean;
  verified: boolean;
  alreadyNudged: boolean;
}): boolean {
  if (input.alreadyNudged) return false;
  return input.mutated && !input.verified;
}

/** The corrective nudge injected at turn end when code was changed but not verified. Pure. */
export function buildVerificationNudge(opts?: { local?: boolean }): string {
  const lines = [
    'Runtime verification guardrail tripped.',
    'You wrote files this turn (code edits / writes) but ran no verification — no build, test, typecheck, or lint.',
    'Before claiming the work is done, prove it: run the relevant check (`run_command` with the project\'s test/build/typecheck/lint) and report the result.',
    'If there is genuinely nothing to run (a docs-only or config-only change), say so explicitly in your final answer instead of just asserting it works.',
  ];
  // HONK-L5 — weak/local models skip this step the most, so make it a hard,
  // non-optional directive (the worker→verify loop in one turn) rather than a
  // gentle reminder they can talk past.
  if (opts?.local) {
    lines.push(
      'This is REQUIRED, not optional: your NEXT action this turn MUST be that verification `run_command` (as a tool call). Do NOT write a final answer until you have run it and seen the result; if it fails, fix the cause and run it again before finishing.',
    );
  }
  return lines.join('\n');
}

/**
 * The nudge for a docs-only / config-only turn: no build/test is required, but
 * the agent must SAY so explicitly rather than implying it tested the change. Pure.
 */
export function buildDocsOnlyVerificationNote(filesWritten: string[]): string {
  const shown = filesWritten.slice(0, 8).join(', ');
  const more = filesWritten.length > 8 ? `, …(+${filesWritten.length - 8})` : '';
  return [
    'Verification check: this turn changed only documentation / configuration files',
    `(${shown}${more}) — there is no build, test, typecheck, or lint to run for these.`,
    'In your final answer, state EXPLICITLY that no verification was required (a docs/config-only change) instead of implying you tested it.',
  ].join('\n');
}
