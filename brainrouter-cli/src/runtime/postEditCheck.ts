import { execSync } from 'node:child_process';

/**
 * CLI-18 (0.4.4) — the edit→verify loop via a checker shell-out. After a file
 * write, run a configured command (`cli.postEditCheck`, e.g. `tsc --noEmit` or
 * `ruff check {file}`) and, if it FAILS, fold the error summary into the edit
 * tool's result so the model sees it BEFORE its next turn — closing the loop
 * instead of discovering the breakage on a later `run_command`. Opt-in (empty =
 * off), bounded by a timeout, and never throws (a broken checker is non-fatal).
 *
 * (A full incremental LSP client — live diagnostics + semantic nav, CLI-19 — is
 * a Phase-2 follow-up; this shell-out delivers the high-value half now.)
 */

/** Substitute `{file}` (quoted) into the template; null when the template is empty. */
export function buildPostEditCommand(template: string, file: string): string | null {
  const t = (template ?? '').trim();
  if (!t) return null;
  return t.includes('{file}') ? t.replace(/\{file\}/g, JSON.stringify(file)) : t;
}

/** Format a non-empty checker output into a model-facing diagnostics block (capped). */
export function formatPostEditDiagnostics(output: string): string {
  const trimmed = (output ?? '').trim();
  if (!trimmed) return '';
  const capped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…(truncated)` : trimmed;
  return `\n\n⚠️ Post-edit check failed — fix before continuing:\n${capped}`;
}

function defaultExec(cmd: string, cwd: string, timeoutMs: number): { code: number; output: string } {
  try {
    const out = execSync(cmd, { cwd, timeout: timeoutMs, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: out };
  } catch (e: any) {
    const output = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() || e?.message || String(e);
    return { code: typeof e?.status === 'number' ? e.status : 1, output };
  }
}

/**
 * Run the post-edit check and return a diagnostics suffix to append to the edit
 * tool's result — `''` when off, when the checker passes, or on any internal
 * error. `exec` is injectable for tests.
 */
export function runPostEditCheck(opts: {
  template: string;
  file: string;
  cwd: string;
  timeoutMs?: number;
  exec?: (cmd: string, cwd: string, timeoutMs: number) => { code: number; output: string };
}): string {
  try {
    const cmd = buildPostEditCommand(opts.template, opts.file);
    if (!cmd) return '';
    const { code, output } = (opts.exec ?? defaultExec)(cmd, opts.cwd, opts.timeoutMs ?? 20_000);
    return code === 0 ? '' : formatPostEditDiagnostics(output);
  } catch {
    return ''; // a broken checker must never break the edit
  }
}
