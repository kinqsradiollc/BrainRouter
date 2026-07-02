/**
 * Filter out Node.js platform warnings that the user has no way to act on
 * and that scroll real CLI banner content off-screen on short terminals.
 *
 *   - `ExperimentalWarning: SQLite is an experimental feature` — emitted by
 *     `node:sqlite`. The CLI itself no longer imports sqlite, but the
 *     stdio MCP child process does, and its warnings surface on the parent's
 *     stderr. Stable in Node 22+ in practice; the warning is correct but
 *     uninformative.
 *   - `DeprecationWarning: ... dotenv ...` — dotenv@16 prints a teaser for
 *     its hosted product on every load on newer Node releases.
 *
 * BrainRouter's own warnings flow through unchanged. `NODE_NO_WARNINGS=1`
 * would silence those too, so we intercept selectively instead.
 *
 * Two interception points: (1) remove Node's built-in `warning` listener
 * and add our own filtered one — this catches warnings emitted from
 * subprocesses or transitive imports during ESM resolution; (2) replace
 * `process.emitWarning` so future direct callers also get the filter.
 * Both are needed because ESM hoists imports above any code in this file,
 * so an emitWarning override alone misses import-time warnings.
 */
function isSuppressibleWarning(message: string, type: string): boolean {
  const looksExperimental =
    type === 'ExperimentalWarning' ||
    /experimental feature|SQLite is an experimental/i.test(message);
  const looksDotenvNoise =
    /dotenv@\d|dotenvx|dotenv\.org/i.test(message);
  return looksExperimental || looksDotenvNoise;
}

// Detach Node's default warning printer and replace with a filtered one.
// process.listeners returns each Function attached; the default one is a
// single internal listener that does the stderr printing.
for (const listener of process.listeners('warning')) {
  process.removeListener('warning', listener);
}
process.on('warning', (warning: any) => {
  if (isSuppressibleWarning(warning?.message ?? '', warning?.name ?? '')) return;
  // Mirror Node's default formatting for everything else so users see the
  // familiar "(node:PID) <Name>: <message>" shape.
  process.stderr.write(`(node:${process.pid}) ${warning?.name ?? 'Warning'}: ${warning?.message ?? warning}\n`);
});

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0]
    : (rest[0] && typeof rest[0] === 'object' && 'type' in rest[0]) ? (rest[0] as any).type
    : (warning instanceof Error ? (warning as any).name : '');
  if (isSuppressibleWarning(message, type)) return;
  return (originalEmitWarning as any)(warning, ...rest);
}) as typeof process.emitWarning;

/**
 * Crash diagnostics — surface ANY exit reason so the user (or we) can
 * see WHY the process died if the REPL ever silently quits. The
 * symptom the user reported was "REPL prints banner, then bash prompt"
 * with no error. If that happens again under any future regression,
 * one of these handlers will catch it and print the cause.
 *
 * `cli.debugExit: true` in `~/.config/brainrouter/config.json` (default off)
 * enables verbose exit tracing including the beforeExit event so we can
 * see whether the event loop drained (= stdin refcount issue) vs explicit
 * process.exit (= bug).
 */
// MEM-36 — scrub secret-shaped values from crash output before it hits the
// terminal/log. Bulletproof: redaction failure falls back to the raw text so
// the last-resort handler can never itself throw.
function redactSafe(detail: string): string {
  try { return redactText(detail); } catch { return detail; }
}
process.on('uncaughtException', (err) => {
  process.stderr.write(`\n[brainrouter] Uncaught exception killed the process:\n${redactSafe(String(err?.stack ?? err))}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  // ORCH-FIX — a stray async rejection (e.g. a detached child agent that failed
  // after the parent stopped awaiting it) must NOT kill an interactive session.
  // Log it loudly and keep the CLI alive; genuinely-unstable SYNC throws are
  // still fatal via uncaughtException above. Child promises are additionally
  // guarded at the source (orchestration/tools.ts), so this is a last-resort
  // logger rather than the common path.
  process.stderr.write(`\n[brainrouter] Unhandled promise rejection (continuing):\n${redactSafe(String(reason?.stack ?? reason))}\n`);
});

import { redactText } from '@kinqs/brainrouter-core/session';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';

if (getCliKnobs().debugExit) {
  process.on('beforeExit', (code) => {
    process.stderr.write(`[brainrouter:debug] beforeExit code=${code} (event loop drained — likely Ink stdin.unref leak)\n`);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[brainrouter:debug] exit code=${code}\n`);
  });
}
