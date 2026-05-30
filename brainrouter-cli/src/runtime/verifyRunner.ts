import type { VerifyRecipe } from './projectProfile.js';

/**
 * CLI-10 (0.4.3) — run a verify recipe step and report the result.
 *
 * The command (`build` / `test` / `lint`) is resolved from the detected
 * project profile (projectProfile.ts) and executed in the workspace. The
 * runner takes an injectable `exec` so it's unit-testable without spawning a
 * real process; the command handler passes a child_process-backed exec.
 *
 * Post-edit LSP/language diagnostics (the other half of CLI-10) layer on top
 * and need live language servers — tracked separately.
 */

export type RecipeStep = 'build' | 'test' | 'lint';

export interface RecipeRunResult {
  step: RecipeStep;
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

/** Sync exec contract: run `command` in `cwd`, return exit code + combined output. */
export type ExecFn = (command: string, cwd: string) => { exitCode: number; output: string };

export function runVerifyRecipe(recipe: VerifyRecipe, step: RecipeStep, cwd: string, exec: ExecFn): RecipeRunResult | { error: string } {
  const command = recipe[step];
  if (!command) return { error: `No "${step}" command for this project profile.` };
  const { exitCode, output } = exec(command, cwd);
  return { step, command, ok: exitCode === 0, exitCode, output };
}

/** Render a run result as plain lines (caller colours). */
export function formatRecipeResult(result: RecipeRunResult): string[] {
  const head = `${result.ok ? '✓' : '✗'} ${result.step}: ${result.command} (exit ${result.exitCode})`;
  const tail = result.output.trim().split('\n').slice(-12).map((l) => `  ${l}`);
  return [head, ...(tail.length && tail[0].trim() ? tail : [])];
}
