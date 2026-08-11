/**
 * ADR-035 D2/D6 — "is a tab of this browser writing to this capture RIGHT NOW?",
 * asked of the browser instead of guessed from a clock.
 *
 * **What this replaces, and why the thing it replaces could not work.** The
 * previous answer was a LEASE in the capture record: a heartbeat stamp plus a
 * thirty-second staleness threshold. A lease is the right shape when the readers
 * are separate machines that can only communicate through the record. Two tabs
 * of one browser are not that. The threshold bought nothing and cost §6 twice:
 *
 * - A killed tab's stamp stays fresh for up to thirty seconds, so a tab reopened
 *   straight after the kill is shown an EMPTY device holding a complete, playable
 *   meeting — and permanently for that page view, because the offer is computed
 *   on mount and on org change and nothing re-asks. §6's headline test, failing.
 * - A tab that is alive but throttled looks dead, so the recording it is still
 *   writing is offered to somebody else with a Discard beside it.
 *
 * Both are the same mistake: a timing heuristic standing in for a fact the host
 * can state exactly. **`navigator.locks` is that fact.** A Web Lock is scoped to
 * the ORIGIN — the same scope as OPFS and IndexedDB, which is the scope the
 * question is about — it is exclusive across every tab and worker of that origin,
 * and it is released BY THE BROWSER when the context holding it goes away. That
 * is `kill -9`, a crash, a reload and a closed tab, all with no threshold to tune
 * and no window in which a dead writer still looks alive.
 *
 * Three invariants follow, and none of them needs a clock:
 *
 * 1. **Held means alive.** There is no stale held lock. A recording whose tab is
 *    gone is offerable on the very next check, with no waiting and no re-check.
 * 2. **A holder cannot be robbed.** `ifAvailable` never queues and never steals,
 *    so a live writer cannot lose its recording to a tab that merely waited long
 *    enough — the second half of the lease's failure. A writer therefore has no
 *    "did I lose it?" state to keep, and no heartbeat to miss.
 * 3. **Ownership is local knowledge.** `query()` says a lock is held; whether it
 *    is OURS is answered from the handles this object is holding, not inferred
 *    from an opaque `clientId`. That is also why the writer set unions in our own
 *    ids: a lock we are holding is a fact, not a question.
 *
 * **When `navigator.locks` is missing** this object answers `unavailable` and
 * reports `known: false` rather than an empty set, and the surface prints
 * `CAPTURE_LOCKS_UNAVAILABLE`. Golden rule 23: a fallback that is invisible is a
 * silent outage, and the degradation here is real — a second tab of such a
 * browser is not coordinated at all, so two tabs recording at once can only be
 * told apart by the person doing it. `known: false` is deliberately NOT the same
 * value as "nobody is writing": callers that destroy things read it as "this
 * browser cannot say", and callers that would otherwise reap a chunk-less
 * manifest leave it alone.
 *
 * **Which browsers that actually is — two of them, and the banner reaches
 * both.** `LockManager` is `[SecureContext]`, so a page in an INSECURE CONTEXT
 * has no `navigator.locks` at all and takes this whole path: the banner is
 * raised in the surface's constructor, `#otherWriter` answers `unknown`, and the
 * reap declines to reclaim what it cannot prove is dead. Such a page cannot
 * reach a RECORDING either — `navigator.mediaDevices` is `undefined` there for
 * the same reason — so the two-tab race the coordination exists for cannot
 * happen on it.
 *
 * **"Insecure context" is not "plain http", and the difference is the URL this
 * dashboard is developed on.** Secure Contexts makes `http://localhost` and
 * `http://127.0.0.1` potentially trustworthy, so a plain-http page served from
 * there is a SECURE context with `navigator.locks`, `navigator.mediaDevices` and
 * `crypto.randomUUID` all present, and a meeting records and coordinates on it
 * exactly as it does over https. Saying "plain http" here would therefore be
 * wrong about the commonest plain-http page there is — an earlier version of
 * this paragraph said it, and the banner said it too, which told a developer on
 * `http://localhost:3000` that their tabs were uncoordinated when they are not.
 * The insecure origins this really names are plain http served from anywhere
 * else, and `file:`.
 *
 * The other browsers that reach the race are SECURE ones that predate Web Locks
 * — Safari up to 15.3, Firefox up to 95, and the older in-app WebViews that lag
 * both. They record perfectly well and cannot coordinate, which is the whole
 * point.
 *
 * The sentence below therefore has to be true for both, because it prints from
 * the constructor — before, and independently of, any Record. It names the
 * insecure origin as well as the old browser, and it keeps the one remedy the
 * insecure origin actually has: serve the page over https.
 */

/** Namespaced like every other key this product puts in a browser-wide namespace. */
export const CAPTURE_LOCK_PREFIX = "brainrouter:meeting-capture:";

/**
 * The sentence a surface shows for as long as this browser cannot answer the
 * question at all — golden rule 23, and ADR-028's "the surface says which state
 * it is in".
 */
export const CAPTURE_LOCKS_UNAVAILABLE =
  "This browser cannot tell whether another tab is recording — it has no Web Locks API. That is the case on a page served over http from anywhere but localhost, where Web Locks needs a secure context (so does the microphone), and in older versions of Safari and Firefox and some in-app browsers. Recording in two tabs at once is not coordinated here: open this dashboard over https if it is not already, and keep this meeting in one tab.";

/**
 * What a surface says about a capture another tab of this origin is holding —
 * and why that is two sentences rather than one.
 *
 * A lock here means "a tab of this browser has this capture IN HAND": its
 * recorder is writing audio into it, OR its transcription queue is writing
 * segments into it. Those are different facts about a meeting, and this host
 * used to report both as the first one — so a tab that had merely opened a
 * crashed recording was announced to every other tab as recording it, and the
 * Delete it blocked was blocked with a sentence that was not true.
 *
 * **The desktop draws the line in the same place and can afford a narrower
 * mechanism.** `MeetingTranscriptionSupervisor.#writers` registers the RECORDING
 * window only, and `adopt` "registers no writer of its own, because a pick-up is
 * not a recording". That works there because one Electron process holds every
 * window and `#entries` hands both windows the SAME queue over a capture, so two
 * pick-ups cannot become two writers. A browser tab has no shared process: each
 * tab builds its own `MeetingTranscriptionQueue`, and two of them over one
 * capture interleave their `apply` calls until the later persist erases the
 * earlier one's segments. So the lock has to cover the queue and not only the
 * recorder — and the honesty the desktop gets for free is bought here by saying
 * WHICH of the two is true instead of always claiming the louder one.
 */
export const CAPTURE_RECORDING_ELSEWHERE = "Another tab of this browser is recording this meeting right now.";

/** The pick-up's sentence: held, being transcribed and composed, but not recorded. */
export const CAPTURE_OPEN_ELSEWHERE = "Another tab of this browser has this meeting open.";

/**
 * Which of the two a surface should print, from the only evidence there is: the
 * capture's own stored status. A tab that picked a recording up persists it as
 * `stopped` before anything else happens to it, so a held capture that still
 * says `recording` is one whose microphone is open.
 */
export function captureHeldNote(stillRecording: boolean): string {
  return stillRecording ? CAPTURE_RECORDING_ELSEWHERE : CAPTURE_OPEN_ELSEWHERE;
}

/**
 * Golden rule 23 — what a surface ASKS when it is told to destroy a recording on
 * a browser that cannot tell whether another tab is writing to it.
 *
 * Reproduced with a tab whose browser has no Web Locks (`withoutLocks` in the
 * harness, and any of the browsers the header names): tab one recording with the
 * microphone open, tab two offered that LIVE capture in its recovery list, one
 * click and the manifest and every chunk were gone — while tab one still
 * reported `recording: true` and told the person their audio was safe.
 * `known: false` is not "nobody is writing", and no path that destroys a meeting
 * may read it as if it were.
 *
 * **These are questions rather than refusals, and that is the correction.** The
 * refusal they replace said "Pick it up here first — a recording this tab is
 * holding can be discarded", and on this browser that instruction could not be
 * followed: a picked-up capture is the ACTIVE one, it leaves the recovery offer
 * the moment it is adopted, and Discard is only rendered on an offered row — so
 * the one browser that refused the delete was also the one browser with no
 * second way to make it. Audio the product will not delete on any path is audio
 * a person cannot get rid of, which is a worse answer to D6 than asking them.
 *
 * So the browser states exactly what it cannot vouch for and the person, who is
 * the only one here who can know whether another tab is open, decides. Both
 * questions name the consequence rather than asking "are you sure?".
 *
 * Create is deliberately not asked at all through the same unknown: it can only
 * ever finalize a capture THIS tab has been writing itself, and a confirmation
 * on every meeting made on such a browser would be noise that teaches people to
 * click through the two that mean something.
 */
export const CAPTURE_DISCARD_UNKNOWN =
  "This browser cannot tell whether another tab is recording this meeting. If one is, deleting it here destroys the audio that tab is still recording, and it cannot be undone. Delete it anyway?";

/** The same unknown, on the path that ADOPTS a recording instead of deleting it. */
export const CAPTURE_PICK_UP_UNKNOWN =
  "This browser cannot tell whether another tab is recording this meeting. If one is, opening it here means two tabs writing to one recording, and creating the meeting from this tab would delete the audio the other is still capturing. Open it here anyway?";

/** The lock's name for one capture. Exclusive per session, shared by every tab. */
export function captureLockName(sessionId: string): string {
  return `${CAPTURE_LOCK_PREFIX}${sessionId}`;
}

/** The capture a held lock is about, or `null` when the name is somebody else's. */
export function captureLockSessionId(name: string | undefined): string | null {
  if (typeof name !== "string" || !name.startsWith(CAPTURE_LOCK_PREFIX)) return null;
  return name.slice(CAPTURE_LOCK_PREFIX.length) || null;
}

/**
 * `held` — this tab has it and keeps it until it lets go or the tab dies;
 * `taken` — another tab of this origin has it, and nothing was waited for;
 * `unavailable` — this browser has no Web Locks, so nothing was taken and
 * nothing is known.
 */
export type CaptureLockOutcome = "held" | "taken" | "unavailable";

/**
 * The captures being written, and whether that answer is an answer.
 *
 * `known: false` with an empty set is not "nobody is writing" — see the header.
 * Keeping the two apart is what stops a browser without Web Locks quietly
 * reaping a recording that is waiting on the microphone prompt in another tab.
 */
export interface CaptureWriters {
  readonly known: boolean;
  readonly ids: ReadonlySet<string>;
}

/**
 * The two `LockManager` methods this needs, so a test does not have to be a
 * browser and so the shape can be feature-detected rather than assumed.
 */
export interface CaptureLockManager {
  request(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
  query(): Promise<{ readonly held?: readonly { readonly name?: string }[] }>;
}

/**
 * This tab's locks over this origin's captures.
 *
 * One per surface, exactly as one `CaptureLocks` stands for one tab: the map of
 * handles below IS the "is that one mine?" answer, and sharing an instance
 * between two notional tabs would make each read the other's holdings as its own
 * — the four-guards defect, wearing its last hat.
 */
export class CaptureLocks {
  readonly #manager: CaptureLockManager | null;

  /** Session id → the function that hands the lock back. Only ever ours. */
  readonly #held = new Map<string, () => void>();

  constructor(manager: CaptureLockManager | null) {
    this.#manager = manager;
  }

  /** Whether this browser can answer the question at all. */
  get available(): boolean {
    return this.#manager !== null;
  }

  /** Whether THIS tab is the one holding that capture. */
  holds(sessionId: string): boolean {
    return this.#held.has(sessionId);
  }

  /**
   * Take the capture, or say who has it — never wait for it.
   *
   * `ifAvailable` is the whole contract: a request that queued would resolve
   * minutes later, in the middle of somebody else's recording, and Record would
   * appear to hang for as long as the other tab kept talking. It also means a
   * refusal is a FACT about right now rather than a timeout.
   */
  async hold(sessionId: string): Promise<CaptureLockOutcome> {
    const manager = this.#manager;
    if (!manager) return "unavailable";
    // Asking twice for a lock we already hold would be refused by `ifAvailable`
    // — a tab reporting itself as another tab.
    if (this.#held.has(sessionId)) return "held";
    let settle: (outcome: CaptureLockOutcome) => void = () => {};
    const granted = new Promise<CaptureLockOutcome>((resolve) => {
      settle = resolve;
    });
    // The callback's promise is the lock's lifetime, so it is resolved by
    // `release` and by nothing else. `granted` resolves as soon as the callback
    // RUNS, which is what a caller is waiting for.
    const request = manager.request(
      captureLockName(sessionId),
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (!lock) {
          settle("taken");
          return Promise.resolve();
        }
        return new Promise<void>((release) => {
          this.#held.set(sessionId, () => {
            this.#held.delete(sessionId);
            release();
          });
          settle("held");
        });
      },
    );
    // A manager that refuses outright — storage blocked for this origin, a
    // context that lost its lock service — is the unavailable case arriving
    // late rather than a recording nobody may make.
    void Promise.resolve(request).catch(() => {
      this.#held.delete(sessionId);
      settle("unavailable");
    });
    return granted;
  }

  /** Hand one capture back. A no-op for one this tab never held. */
  release(sessionId: string): void {
    this.#held.get(sessionId)?.();
  }

  /** Hand everything back — the unmount teardown, before the tab survives it. */
  releaseAll(): void {
    for (const release of [...this.#held.values()]) release();
  }

  /**
   * Every capture some tab of this origin is writing to, including this one.
   *
   * Asked fresh at every call rather than cached: the reap's whole difficulty is
   * a tab that pressed Record AFTER the caller took its listing, so an answer
   * from a moment ago is the wrong answer by construction.
   */
  async writers(): Promise<CaptureWriters> {
    const manager = this.#manager;
    // Ours are a fact we hold rather than a question we ask, and they are in the
    // set on every path — including the one where the query itself fails.
    const ids = new Set<string>(this.#held.keys());
    if (!manager) return { known: false, ids };
    try {
      const snapshot = await manager.query();
      for (const entry of snapshot.held ?? []) {
        const sessionId = captureLockSessionId(entry.name);
        if (sessionId) ids.add(sessionId);
      }
      return { known: true, ids };
    } catch {
      // A query that would not answer leaves us unable to say, which is not the
      // same as "nobody is writing" and must not be reported as it.
      return { known: false, ids };
    }
  }
}

/**
 * This tab's locks, over the real browser.
 *
 * The detection is structural rather than `"locks" in navigator`, because the
 * property exists and is `undefined` outside a secure context, and because this
 * is the one place that has to be right for the fallback to be honest.
 */
export function browserCaptureLocks(): CaptureLocks {
  try {
    const candidate = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
    return new CaptureLocks(isLockManager(candidate) ? candidate : null);
  } catch {
    // Touching `navigator` at all throws in a few embedded contexts.
    return new CaptureLocks(null);
  }
}

function isLockManager(value: unknown): value is CaptureLockManager {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CaptureLockManager>;
  return typeof candidate.request === "function" && typeof candidate.query === "function";
}
