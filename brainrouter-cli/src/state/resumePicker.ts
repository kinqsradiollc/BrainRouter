/**
 * CC-P2.1 — `--continue` / `--resume <key>` launch flags (0.4.15 thread H).
 *
 * Pure selection logic for which persisted session a fresh `brainrouter chat`
 * launch should resume:
 *
 *   --continue        → the most recent top-level session (skips worker child
 *                       transcripts — resuming into a worker's context would
 *                       be nonsense).
 *   --resume <key>    → exact sessionKey, or a UNIQUE prefix of one (so the
 *                       user can paste the first chars from /sessions).
 *
 * Returns a discriminated result; the entry point prints errors and falls
 * through to a fresh session rather than aborting the launch.
 */
import type { TranscriptSummary } from '@kinqs/brainrouter-core/dist/session/sessionStore.js';

export type ResumePick =
  | { ok: true; sessionKey: string }
  | { ok: false; error: string };

/** Worker/child transcripts are not resumable chat sessions. */
function isResumableKey(key: string): boolean {
  return !key.includes(':worker:');
}

/** Pick the session to resume. `transcripts` must be newest-first. Pure. */
export function pickResumeSession(
  transcripts: TranscriptSummary[],
  opts: { continueLatest?: boolean; resumeKey?: string },
): ResumePick {
  if (opts.resumeKey) {
    const key = opts.resumeKey.trim();
    const exact = transcripts.find((t) => t.sessionKey === key);
    if (exact) return { ok: true, sessionKey: exact.sessionKey };
    const prefixed = transcripts.filter((t) => t.sessionKey.startsWith(key));
    if (prefixed.length === 1) return { ok: true, sessionKey: prefixed[0].sessionKey };
    if (prefixed.length > 1) {
      return { ok: false, error: `--resume "${key}" matches ${prefixed.length} sessions — give more characters (see /sessions).` };
    }
    return { ok: false, error: `--resume "${key}" matches no persisted session in this workspace (see /sessions).` };
  }
  if (opts.continueLatest) {
    const latest = transcripts.find((t) => isResumableKey(t.sessionKey));
    if (latest) return { ok: true, sessionKey: latest.sessionKey };
    return { ok: false, error: 'No previous session to continue in this workspace.' };
  }
  return { ok: false, error: 'Nothing to resume (no flag given).' };
}
