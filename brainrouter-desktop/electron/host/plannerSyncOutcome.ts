/**
 * ADR-038 D4 — sync is a control, not a caption: what the desktop learned on
 * its last planner sync attempt, as a PlannerSyncOutcome the surface can show.
 *
 * Seen live: a desktop with 21 queued changes and a server that was not
 * running. The handler's account lookup threw, was caught into `null`, and the
 * branch for "no account" answered "Sign in before syncing" — wrong, and the
 * renderer discarded even that. The person saw "21 changes waiting to sync ·
 * Waiting for a connection." with nothing to act on. Pure; the handler records
 * what these return.
 */
import type { PlannerSyncOutcome, PlannerSyncResult } from '@kinqs/brainrouter-core/planner';

/** A failure to reach the server, as opposed to a refusal by it. */
export function isConnectivityFailure(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ''}` : String(err);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network|timed? ?out|AbortError|socket hang up/i.test(message);
}

export function localOnlyOutcome(at: string): PlannerSyncOutcome {
  return { at, ok: false, blocker: { kind: 'local-only', message: 'No server is configured, so changes stay on this device. Add a server in Settings to sync them.' } };
}

export function signInOutcome(at: string): PlannerSyncOutcome {
  return { at, ok: false, blocker: { kind: 'sign-in', message: 'Sign in (Settings → Account) to sync Planner changes with the server.' } };
}

export function organizationOutcome(at: string): PlannerSyncOutcome {
  return { at, ok: false, blocker: { kind: 'organization', message: 'Choose an active BrainRouter organization (Settings → Account) before Planner changes can sync.' } };
}

/** The account lookup failed: unreachable server, or something else it said. */
export function accountFailureOutcome(err: unknown, baseUrl: string, at: string): PlannerSyncOutcome {
  if (isConnectivityFailure(err)) {
    return { at, ok: false, blocker: { kind: 'unreachable', message: `The server at ${baseUrl} is not answering. Changes are kept here and will sync when it is back.` } };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { at, ok: false, blocker: { kind: 'error', message: `The server at ${baseUrl} refused the account check: ${detail}` } };
}

/** What a completed cycle means for the surface. */
export function cycleOutcome(result: PlannerSyncResult, baseUrl: string, at: string): PlannerSyncOutcome {
  const notice = [result.shedNotice, result.repairNotice, result.clockNotice].filter(Boolean).join(' ');
  if (result.offline) {
    return {
      at, ok: false,
      blocker: { kind: 'unreachable', message: `The server at ${baseUrl} is not answering. Changes are kept here and will sync when it is back.` },
      ...(notice ? { notice } : {}),
    };
  }
  return { at, ok: true, pulled: result.pulled, pushed: result.pushed, ...(notice ? { notice } : {}) };
}

/** Keep a blocker's first-seen time across repeated identical outcomes. */
export function withSince(next: PlannerSyncOutcome, previous: PlannerSyncOutcome | undefined): PlannerSyncOutcome & { since?: string } {
  if (!next.blocker) return next;
  const same = previous?.blocker?.kind === next.blocker.kind;
  const since = same ? ((previous as { since?: string }).since ?? previous!.at) : next.at;
  return { ...next, since };
}
