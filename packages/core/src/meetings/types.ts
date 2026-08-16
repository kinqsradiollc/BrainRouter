/**
 * ADR-035 — the shapes a meeting capture has to carry so it cannot be lost.
 *
 * §1 names the defect: audio lived in a React ref and a meeting row only
 * appeared once capture had already succeeded, so a failed capture had nowhere
 * to live and nothing to be retried from. Every type here exists to make one of
 * the ADR's decisions expressible:
 *
 * - D2 — a session exists from the moment Record is pressed, with an id the
 *   host names its capture directory (or its OPFS folder) after. That is what
 *   gives a crashed recording somewhere to be found again.
 * - D3 — the unit of transcription is a SEGMENT, so a failure is bounded to one
 *   segment rather than to the meeting, and nothing ever posts an hour of audio
 *   in one request.
 * - D5 — a segment that could not be transcribed keeps its time range, its
 *   reason and its attempt count. An unmarked hole in a transcript is quietly
 *   wrong; a stated gap is a fact someone can act on.
 * - D9 — a CHUNK and a UNIT are not the same thing. D3 above was written as
 *   though they were, and the implementation reasonably made them one 20-second
 *   constant; using it showed that constant answering three questions that have
 *   three different answers. So the record now carries both: a chunk ledger
 *   (what was written down, and how much a crash may cost) and units assembled
 *   from it (what is sent to be transcribed). `chunkLedger.ts` owns the rule.
 *
 * Everything in this subsystem is pure data and pure functions: no filesystem,
 * no browser storage API, no network. That is deliberate and is what D1b means
 * by "the session model, the segment protocol, and the recovery flow are
 * shared — only the write target is host-specific". The desktop writes these
 * records next to files on disk; the dashboard writes them beside OPFS blobs;
 * both agree on what a meeting IS because both import this module.
 */

/**
 * D2 — the lifecycle of a capture, and the reason `recording` is a persisted
 * state rather than an in-memory one.
 *
 * A process that dies while recording leaves `recording` written down, and that
 * stale value is precisely the signal recovery looks for (`recovery.ts`).
 * `finalized` and `discarded` are the two terminal states, and they are distinct
 * because "the user accepted this meeting" and "the user threw it away" imply
 * different retention outcomes under D6.
 */
export type MeetingCaptureStatus = 'recording' | 'stopped' | 'finalized' | 'discarded';

/**
 * D3/D5 — where a single segment is in its transcription.
 *
 * `pending` and `transcribing` are both provisional in D4's sense; the split is
 * kept because "queued because the endpoint is down" (D7) and "in flight right
 * now" are different things to say to a user, and ADR-028 asks the surface to
 * say which state it is actually in.
 */
export type MeetingSegmentState = 'pending' | 'transcribing' | 'done' | 'failed';

/**
 * The summary templates a capture can be started with. The vocabulary matches
 * the one the hosts already offer rather than inventing a second one — a shared
 * model whose enumerations disagree with the surfaces is how ADR-029's "two
 * features, one quietly worse" failure starts.
 */
export type MeetingCaptureTemplate = 'general' | 'standup' | 'one-on-one' | 'retrospective';

/**
 * Open question 5 — the tenancy a capture was started under, frozen at Record.
 *
 * ADR-019's switcher can change the active org mid-meeting. Nothing in this
 * module rewrites `scope`, so a recording that started under one org cannot
 * silently land in another; recovery filters by it instead (`recovery.ts`).
 * `orgId` is nullable because a personal install genuinely has no org.
 */
export interface MeetingCaptureScope {
  readonly orgId: string | null;
  readonly workspaceId?: string | null;
}

/**
 * D9 — one DURABILITY CHUNK: exactly what `ondataavailable` handed the host and
 * exactly what the host wrote down, before anything else happened to it.
 *
 * Its size is a durability decision and nothing else — it is the answer to "how
 * much may a crash cost", which the ADR puts at two to five seconds. It is not
 * an opinion about how much audio a transcription model wants, and it is not a
 * cadence for text appearing on screen. Those were the other two jobs the one
 * constant used to do.
 *
 * `sequence` is the key the host filed the bytes under, and the ONLY way back to
 * them. It is not a unit index: a unit spans several chunks, so the two counters
 * diverge the moment D9 is in play. Reading a unit's audio means reading the
 * chunks `MeetingSegment.chunks` names, in order.
 */
export interface MeetingChunk {
  readonly sequence: number;
  readonly byteLength: number;
  /** Elapsed milliseconds from the start of the capture, like a unit's range. */
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * D3/D9 — one TRANSCRIPTION UNIT and everything known about transcribing it.
 *
 * A unit is assembled from durability chunks and sized by the transcription
 * strategy (`chunkLedger.ts`), never by the write cadence. It is what gets sent
 * to the endpoint, what a retry re-sends, and what D5 states as a gap when it
 * cannot be transcribed.
 *
 * `byteLength` is what the host actually wrote, not what it intends to write:
 * the recovery predicate asks "is there audio" and a record that anticipated
 * bytes would answer yes for a session that has none.
 *
 * `startMs`/`endMs` are elapsed milliseconds from the start of the capture, not
 * wall clock. They span the unit's whole run of chunks — first chunk's start to
 * last chunk's end — so a gap marker still prints one honest range however many
 * chunks went into it. They stay meaningful for a session whose wall-clock start
 * is unknown (an import).
 *
 * The name is `MeetingSegment` rather than `MeetingTranscriptionUnit` because
 * every persisted record, both hosts and this subsystem's whole vocabulary
 * already say "segment" for this thing, and renaming a shape that is on disk
 * buys nothing D9 asked for. `MeetingTranscriptionUnit` is an alias for reading
 * new code by.
 */
export interface MeetingSegment {
  readonly index: number;
  readonly byteLength: number;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * D9 — the durability chunks this unit was assembled from, ascending and
   * contiguous.
   *
   * ABSENT on every record written before D9, and that absence is load-bearing
   * rather than sloppy: in those builds one unit was exactly one chunk, filed
   * under the unit's own index. So "no `chunks`" means "chunk `index`", which is
   * what `unitChunkSequences` returns and why a stored session from the current
   * build still reads correctly instead of losing its audio to a missing field.
   */
  readonly chunks?: readonly number[];
  readonly state: MeetingSegmentState;
  /** Present once `state` is `done`. Absent otherwise — never an empty placeholder. */
  readonly text?: string;
  /** D5 — why the last attempt failed, in words a user can act on. */
  readonly failureReason?: string;
  /** D5 — transcription attempts MADE (not queued). The bound in `retryPolicy.ts` reads this. */
  readonly attempts: number;
  /**
   * D7 — how many times an attempt on THIS segment was refunded because the
   * endpoint did not answer.
   *
   * It is not `attempts`, and the split is the whole point: an outage is a
   * verdict on the server, so the attempt is given back. But the give-back has
   * to be bounded or a server that answers every request with a "try again
   * later" status — including one that is really saying "these bytes will never
   * decode" — is an unbounded upload loop against our own sidecar, with the
   * segment sitting at `attempts: 0` forever and the transcript never admitting
   * anything is wrong.
   *
   * Absent until an outage actually touches the segment: most segments in a
   * meeting never see one, and a `0` written 180 times is noise in the record.
   */
  readonly deferrals?: number;
  /** ISO timestamp of the most recent attempt; the backoff clock starts here. */
  readonly lastAttemptAt?: string;
}

/**
 * D2 — the meeting itself, created at Record.
 *
 * The id is filesystem-safe by construction (`captureSession.ts` validates it)
 * because the host names a `0700` capture directory after it under D6. A
 * session with a path separator in its id would be a directory-traversal bug in
 * every host that stores audio, so the shared model refuses to mint one.
 *
 * ## There is no `writer` here, and there is not going to be one
 *
 * A record briefly carried one: a lease with a heartbeat stamp, so that "is
 * somebody recording into this?" could be answered from the bytes rather than
 * from one mount's React state. The shape was right for a store two processes
 * share; it was wrong for the question, because the question is about a PROCESS
 * and a stamp can only be about a moment. A tab or an app killed one second ago
 * leaves a stamp that still looks perfectly fresh, so the meeting §6 exists to
 * recover was withheld from the offer for the whole staleness window — on
 * surfaces that ask once and never ask again. That is §6's headline failure,
 * produced by the field meant to prevent it.
 *
 * Liveness is now the host's, and each host can state it exactly: the desktop
 * keeps a writer map in the one process every window lives in (single-instance
 * locked), and the browser holds a Web Lock per browsing context, which the
 * browser itself releases the instant the context is gone. Both hand the answer
 * to the shared rule as `exclude` at their own boundary.
 *
 * So a `writer` found in a persisted record is a field from an older build, it
 * is read by nothing, and `recoverCaptureSession` drops it rather than carrying
 * it forward. Adding one back would not merely be redundant — it would be a
 * second, slower opinion that the offer would start honouring again the moment
 * somebody restored the read.
 */
export interface MeetingCaptureSession {
  readonly id: string;
  readonly startedAt: string;
  readonly scope: MeetingCaptureScope;
  readonly title: string;
  readonly template: MeetingCaptureTemplate;
  /** BCP-47 tag passed to STT, or absent to let the endpoint auto-detect. */
  readonly language?: string;
  readonly status: MeetingCaptureStatus;
  /** D3/D9 — the transcription units, in capture order. */
  readonly segments: readonly MeetingSegment[];
  /**
   * D9 — the durability ledger: every chunk the host has written down, whether
   * or not a unit has claimed it yet.
   *
   * It is what makes the worst case seconds rather than a unit: a kill leaves
   * the chunks of a half-assembled unit here, and recovery seals them into one
   * rather than losing them because no unit ever mentioned them.
   *
   * PRESENT, including as an empty array, on records created under D9. Writing
   * the empty ledger at Record is load-bearing: if the first bytes land and the
   * process dies before the record update, orphan adoption can still tell those
   * were short D9 chunks rather than legacy 20-second ones.
   *
   * ABSENT on records written before D9, where the segments WERE the ledger,
   * one chunk each, `sequence === index`. `captureChunks` derives that ledger
   * rather than demanding a migration pass, so an old session loads and keeps
   * its audio.
   */
  readonly chunks?: readonly MeetingChunk[];
  /** Set when capture stopped; cleared again if the user resumes. */
  readonly stoppedAt?: string;
  /** Set once `status` is terminal (`finalized` or `discarded`). */
  readonly closedAt?: string;
}

/**
 * D9's name for what `MeetingSegment` has always been in every place that
 * matters: the thing that is sent to be transcribed.
 *
 * An alias rather than a rename because the shape is persisted on both hosts,
 * and because "segment" is the word the transcript, the queue, the gap markers
 * and both surfaces already use. New code that is specifically about the
 * chunk/unit split reads better with this one.
 */
export type MeetingTranscriptionUnit = MeetingSegment;
