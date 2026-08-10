/**
 * ADR-035 D6 — who this WINDOW is, as the capture writer registry names it.
 *
 * ## What it owns
 *
 * One string, minted once, for the life of one BrowserWindow.
 *
 * ## Why it is a module and not a `useMemo`
 *
 * Because the id has to be the same for every reader inside the window and
 * different for every other window, and a hook can guarantee neither.
 * `createMeetingCaptureOps()` is called twice in the meetings surface (the
 * library and the compose form), each in its own component; two `useMemo`s would
 * mint two ids, the compose form would start the recording under one of them and
 * the other would then tell the user that ANOTHER window is recording the meeting
 * they are recording, and refuse their own Create. A module-level constant is
 * exactly one per JavaScript realm, and one realm is one BrowserWindow — which
 * is the unit main registers a writer against.
 *
 * It must NOT be per-process: `openWorkspaceWindow` mints one window per
 * workspace inside a single Electron process, so a process-wide id would make
 * two windows indistinguishable to each other, which is the case this exists to
 * answer.
 *
 * ## Invariants
 *
 * 1. **Minted lazily, then never again.** Lazily so importing this module cannot
 *    reach for `crypto` before a host has one; never again so the id survives
 *    every remount of the meetings view for as long as the window lives.
 * 2. **It is a coordination token, not a credential.** Anything in this window
 *    may read it. What it buys is that main can tell two windows apart; it is
 *    not a permission and nothing treats it as one. The capture directory's
 *    actual protection is its `0700` mode.
 * 3. **A reload is a new writer, deliberately.** A reloaded window has no
 *    recorder, no queued chunks and no memory of the meeting, so it is not the
 *    writer main registered. The page it replaced hands the recording back as it
 *    goes (`pagehide`, see `preload.cts`), and this realm arrives with an id of
 *    its own rather than pretending to be its predecessor.
 */
import { newCaptureHolderId } from "@kinqs/brainrouter-core/meetings";

let holderId: string | null = null;

/** This window's capture-writer id. The same string every time it is asked. */
export function captureHolderId(): string {
  if (!holderId) holderId = newCaptureHolderId();
  return holderId;
}
