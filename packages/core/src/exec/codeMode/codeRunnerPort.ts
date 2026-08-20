/**
 * ADR-041 A41-15 (W3) — the Code Mode runner capability port.
 *
 * A sibling of `SubprocessPort` / `ShellPort` / `FilesystemPort` (ADR-041 D3): the
 * `run_code` handler depends on this interface, and the default binding runs the
 * program as a local subprocess. An ExecutionWorld (D10) can later back it with a
 * container/remote runner with zero handler change. Type-only imports keep it free
 * of the runner's node dependencies.
 */
import type { CodeModeBudget, CodeRunKillReason } from './budget.js';

/** How the parent dispatches one `agent.<tool>(args)` call from the program. */
export type CodeToolDispatch = (tool: string, args: Record<string, unknown>) => Promise<string>;

export interface CodeRunOptions {
  /** The workspace root the program runs in (its cwd). */
  workspaceRoot: string;
  /** Dual-budget + output-cap knobs. */
  budget: CodeModeBudget;
  /** Tool names the child may bind as `agent.<name>(...)` (a hint; the parent re-authorizes every call). */
  toolNames: readonly string[];
  /** Abort signal (the turn's) — aborting SIGKILLs the child. */
  signal?: AbortSignal;
  /** Environment scrub already applied (secret vars removed) before spawn. */
  scrubbedEnv?: NodeJS.ProcessEnv;
}

export interface CodeRunResult {
  /** The program's returned value, stringified (empty when it returned nothing). */
  returnValue: string;
  /** The program's captured stdout/stderr (already char-capped). */
  output: string;
  /** True when the output hit the cap and was truncated. */
  outputTruncated: boolean;
  /** Number of tool calls the program made. */
  toolCalls: number;
  /** Set when the run ended by enforcement rather than a clean return. */
  killReason?: CodeRunKillReason;
  /** The program's own error message, when it threw. */
  error?: string;
}

export interface CodeRunnerPort {
  /**
   * Run one model-authored async program. `dispatch` is invoked for every
   * `agent.<tool>(args)` the program makes — the runner is transport only; the
   * caller's `dispatch` is the security-bearing re-entry into the D8 pipeline.
   */
  runCode(source: string, options: CodeRunOptions, dispatch: CodeToolDispatch): Promise<CodeRunResult>;
}
