/**
 * ADR-035 D6 — the id one capture writer is known by.
 *
 * ## What it owns
 *
 * One function: minting a string that tells one writer of a capture apart from
 * another. Nothing else. It is here rather than in a host because both the
 * mint and its fallback are decisions the subsystem already made once for
 * `newMeetingSessionId`, and a host that reinvented either would get the
 * fallback wrong in the one environment that needs it.
 *
 * ## Why it is a module of its own
 *
 * It is what is left of `captureLease.ts`, and it is left deliberately. The
 * lease tried to answer "is somebody recording into this capture right now?"
 * from a heartbeat stamp inside the record, and that question cannot be
 * answered by a stamp: a writer killed a second ago leaves one that still looks
 * fresh, which is how §6's own destructive test came to fail — the recovered
 * meeting was withheld from the offer for a staleness window, on surfaces that
 * ask once. Every host now answers liveness itself, exactly, from something
 * that dies when the writer does: a per-process writer map on the desktop, a
 * Web Lock per browsing context in the browser.
 *
 * The id survived that because it is not an answer to anything — it is a NAME.
 * The desktop's map is keyed by it, and a window that cannot name itself cannot
 * be told apart from another window. It does not belong in `captureSession.ts`,
 * whose subject is the transitions of a meeting; a writer is not a meeting.
 *
 * ## Invariants
 *
 * 1. **It identifies a WRITER — one window or one browsing context — never a
 *    process and never an origin.** A process-wide id would make two windows of
 *    one Electron process indistinguishable, and those two windows are the case
 *    the desktop's map exists for.
 * 2. **It is a coordination token, not a credential.** Nothing grants
 *    permission on the strength of it. The capture directory's actual
 *    protection is its `0700` mode (D6).
 * 3. **It is never persisted into a capture record.** A name written down
 *    outlives the writer it named, which is the whole defect above.
 */

/**
 * A holder id for one window or tab.
 *
 * Same fallback as `newMeetingSessionId` and for the same reason:
 * `crypto.randomUUID` is unavailable outside a secure context and the dashboard
 * is not always served from one, so a plain-http origin must still be able to
 * identify its writer.
 */
export function newCaptureHolderId(): string {
  const webcrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webcrypto?.randomUUID === 'function') return `wr-${webcrypto.randomUUID()}`;
  return `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
