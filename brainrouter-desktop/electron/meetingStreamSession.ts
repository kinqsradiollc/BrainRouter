/**
 * ADR-035 D10 — one capture's live transcription, in the process that outlives
 * the window.
 *
 * ## What it owns
 *
 * The four things D10 asks of a host, and nothing else:
 *
 * 1. **Ask the endpoint, then pick.** The strategy is a property of the ENDPOINT
 *    (D10), so this asks for the capability document and hands it to Core's
 *    strict normalizer. An endpoint advertising `streaming: null` — production
 *    today — selects the segmented path and this session goes inert, leaving the
 *    batch queue exactly as it was.
 * 2. **Send only what is already durable.** `offer` takes a SEQUENCE, never
 *    bytes: the audio is read back off the disk the supervisor already wrote it
 *    to. There is no in-memory copy of a meeting here, which is §1's defect, and
 *    a reconnect replays from the same disk rather than from anything held.
 * 3. **Promote a checkpoint only after the transcript state it describes is on
 *    disk.** A coverage event is validated by `reduceStreamingTranscript`
 *    against the persisted D9 ledger, then the covered chunks are sealed into
 *    transcription units and marked done with the utterances that cover them —
 *    and only when that write returns does the new checkpoint become this
 *    session's resume authority. A failed write keeps the prior one, which is
 *    the contract's own rule.
 * 4. **Say which path is running, and why.** Golden rule 23: a degradation
 *    nobody can see is indistinguishable from working. Every transition — no
 *    streaming offered, dropped and reconnecting, given up on — publishes a
 *    sentence.
 *
 * ## What it deliberately does NOT own
 *
 * Text a person can edit. Partial utterances are published as an ephemeral live
 * list and never folded into the compose box; only a COMMITTED unit becomes
 * settled text, through the same `transcriptFold` rule the segmented path uses.
 * That is what makes "a late arrival cannot overwrite an edit" structural rather
 * than careful: a late revision has nowhere to write.
 *
 * ## Why duplicate text is impossible rather than avoided
 *
 * A chunk is claimed by at most one unit and units claim chunks front-to-back
 * (`chunkLedger.ts` invariant 1). Coverage seals only chunks no unit has taken,
 * so if the ceiling already sealed a run and the batch queue transcribed it, a
 * later coverage over the same range seals nothing and commits nothing. The two
 * strategies cannot both put words in the same stretch of the meeting.
 */
import {
  captureChunks,
  describeTranscriptionEndpoint,
  initializationSegmentLength,
  markDone,
  reduceStreamingTranscript,
  sealUnit,
  selectTranscriptionMode,
  EMPTY_STREAMING_TRANSCRIPT,
  type MeetingCaptureSession,
  type MeetingLiveUtterance,
  type MeetingSegment,
  type MeetingStreamingTranscriptState,
  type MeetingTranscriptionLatencyMode,
  type MeetingTranscriptionMode,
} from '@kinqs/brainrouter-core/meetings';
import type { MeetingStreamConnection, MeetingStreamConnectionHandlers } from './meetingStreamConnection.js';
import {
  preferredLatencyMode,
  MeetingStreamUnavailableError,
  type MeetingStreamCloseKind,
} from './meetingStreamProtocol.js';

/** How many times a dropped connection is picked up again before the segmented path takes over. */
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 8_000;
/**
 * Frames per second are bounded at the gateway (50), and a replay after a
 * reconnect is the one moment this host would breach it. Pacing sends is what
 * keeps a recovery from being closed as a flood.
 */
const SEND_PACE_MS = 40;
/**
 * How much un-acknowledged audio a reconnect may replay. Past this the endpoint
 * is not keeping its coverage promise, so replaying more of the meeting at it is
 * worse than letting the segmented path — which is already sealing these chunks
 * at its ceiling — finish the job.
 */
const MAX_REPLAY_CHUNKS = 200;
/** Live utterances awaiting coverage. Comfortably more than a conversation holds; a breach means coverage stopped. */
const MAX_LIVE_UTTERANCES = 64;

/**
 * D10/ADR-028 — what the surface says about which transcription path is running.
 *
 * The sentences live together because they are one decision told in five ways,
 * and because a fallback that says nothing is the defect golden rule 23 names.
 * They are composed in main and travel on the progress channel, exactly as
 * `MEETING_CAPTURE_WRITER_NOTE` does, so the words a renderer prints are the
 * words this process decided rather than a second copy that can drift.
 */
export const MEETING_STREAM_NOTICE = Object.freeze({
  live: 'Live transcription is on — text appears while the meeting is being spoken.',
  unsupported:
    'This transcription service does not offer live streaming, so this meeting is being transcribed in segments. The audio is saved on this device either way.',
  unreachable:
    'Live transcription could not be reached, so this meeting is being transcribed in segments. The audio is saved on this device either way.',
  reconnecting:
    'Live transcription dropped and is being picked up again. The audio is on this device and will be replayed — nothing is lost.',
  undecodable:
    'The transcription service could not decode this audio live, so the rest of this meeting is being transcribed in segments.',
  degraded:
    'Live transcription stopped, so the rest of this meeting is being transcribed in segments. The audio is on this device and nothing recorded so far is lost.',
});

export interface MeetingTranscriptionStatus {
  /** Which strategy is in force right now — the answer the ENDPOINT gave, not a build-time assumption. */
  readonly mode: MeetingTranscriptionMode;
  /** True only while a connection is attached and covering. */
  readonly live: boolean;
  /** ADR-028 — one sentence a person can act on. Never empty for a degraded state. */
  readonly notice: string;
}

export interface MeetingStreamPortOpenInput {
  readonly sessionId: string;
  readonly mimeType: string;
  readonly language: string | null;
  readonly latencyMode: MeetingTranscriptionLatencyMode;
  /** The last checkpoint this host PERSISTED, or null. Never an unpersisted reducer result. */
  readonly resumeFromSequence: number | null;
  /**
   * The container bootstrap for whatever checkpoint the gateway actually
   * accepted — empty when the accepted stream starts at chunk 0, because that
   * chunk carries the recording's own header.
   */
  initializationSegmentFor(acceptedResumeFromSequence: number | null): Uint8Array;
  readonly handlers: MeetingStreamConnectionHandlers;
}

/**
 * The seam between this session and the network.
 *
 * `capabilities` answers with whatever the endpoint said, unnormalized: Core's
 * `describeTranscriptionEndpoint` is the single strict reader of that document
 * and a port that pre-judged it would be a second one.
 */
export interface MeetingTranscriptionStreamPort {
  capabilities(): Promise<unknown>;
  open(input: MeetingStreamPortOpenInput): Promise<MeetingStreamConnection>;
}

/** What this session is allowed to do to the capture: read it, read its audio, and write through its single writer. */
export interface MeetingStreamCaptureLedger {
  session(): MeetingCaptureSession;
  apply(transition: (session: MeetingCaptureSession) => MeetingCaptureSession): Promise<MeetingCaptureSession>;
  readChunk(sequence: number): Promise<Uint8Array | null>;
}

export interface MeetingStreamPublication {
  readonly status: MeetingTranscriptionStatus;
  /** D4 — provisional text, explicitly not persisted and explicitly not the compose box's. */
  readonly live: readonly MeetingLiveUtterance[];
}

export interface MeetingStreamSessionOptions {
  readonly sessionId: string;
  readonly mimeType: string;
  readonly language?: string;
  readonly port: MeetingTranscriptionStreamPort;
  readonly ledger: MeetingStreamCaptureLedger;
  readonly publish: (publication: MeetingStreamPublication) => void;
  /** Returns a canceller, like the supervisor's, so a test can run a backoff at an exact instant. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  /** Injected so pacing and the reconnect backoff are instant in a test rather than merely short. */
  readonly delay?: (ms: number) => Promise<void>;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

/**
 * The finals that belong inside one unit's elapsed range.
 *
 * Clamped at both ends on purpose: a coverage event proves every sample through
 * a chunk is represented, so an utterance that began a few milliseconds before
 * the first sealed unit or ran a few past the last one still belongs to the
 * meeting, and dropping it would put an unmarked hole inside a segment that
 * claims to be settled (D5's worse failure).
 */
export function utteranceTextForUnit(
  unit: MeetingSegment,
  units: readonly MeetingSegment[],
  utterances: readonly MeetingLiveUtterance[],
): string {
  const first = units[0];
  const last = units[units.length - 1];
  const isFirst = unit.index === first?.index;
  const isLast = unit.index === last?.index;
  const parts: string[] = [];
  for (const utterance of utterances) {
    if (utterance.state !== 'final') continue;
    const startsBefore = utterance.startMs < unit.startMs;
    const startsAfter = utterance.startMs >= unit.endMs;
    if ((startsBefore && !isFirst) || (startsAfter && !isLast)) continue;
    if (utterance.text.trim()) parts.push(utterance.text.trim());
  }
  return parts.join(' ');
}

export class MeetingStreamSession {
  readonly #options: MeetingStreamSessionOptions;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #delay: (ms: number) => Promise<void>;
  #mode: MeetingTranscriptionMode = 'segmented';
  #latencyMode: MeetingTranscriptionLatencyMode | null = null;
  #notice = '';
  #state: MeetingStreamingTranscriptState = EMPTY_STREAMING_TRANSCRIPT;
  #connection: MeetingStreamConnection | null = null;
  #connecting: Promise<void> | null = null;
  #initialization: Uint8Array | null = null;
  #highestOffered = -1;
  #nextToSend = 0;
  #pumping: Promise<void> = Promise.resolve();
  /** Every event is handled on one chain so a partial cannot land inside a coverage commit. */
  #events: Promise<void> = Promise.resolve();
  #attempts = 0;
  #cancelReconnect: (() => void) | null = null;
  #started: Promise<void> | null = null;
  #closed = false;
  #finishing = false;

  constructor(options: MeetingStreamSessionOptions) {
    this.#options = options;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#delay = options.delay ?? defaultDelay;
  }

  /**
   * Which strategy the append path should size units by.
   *
   * `segmented` until the endpoint has answered, which is what keeps a
   * segmented deployment behaving EXACTLY as it does today: the probe cannot
   * make the first unit later than it already is. If the answer arrives after a
   * unit has sealed, that unit is the batch path's and coverage over it seals
   * nothing — see the module header.
   */
  get mode(): MeetingTranscriptionMode {
    return this.#mode;
  }

  get status(): MeetingTranscriptionStatus {
    return { mode: this.#mode, live: this.#connection !== null, notice: this.#notice };
  }

  /** The provisional utterances a surface may show. Never the compose box's text. */
  get live(): readonly MeetingLiveUtterance[] {
    return this.#state.utterances;
  }

  /** The resume authority: promoted only after the transcript state it describes was persisted. */
  get checkpoint(): number | null {
    return this.#state.checkpoint?.acknowledgedThroughSequence ?? null;
  }

  /**
   * Ask the endpoint what it offers, once per capture.
   *
   * Started at Record rather than at the first chunk so the answer is in hand
   * long before the first unit could seal, and awaited by nothing on the append
   * path — a probe that hung would otherwise hold up a durable write, which is
   * the one thing that must never wait for the network (D1).
   */
  start(): Promise<void> {
    this.#started ??= this.#probe();
    return this.#started;
  }

  /**
   * A durability chunk is on disk. Nothing before this call may be sent.
   *
   * Fire-and-forget by design: the caller is the append path, and D1 says the
   * bytes come first. A stream that cannot keep up costs a reconnect, never a
   * chunk.
   */
  offer(sequence: number): void {
    if (this.#closed) return;
    // Recorded whatever the mode currently is. The capability answer arrives
    // asynchronously, and a chunk offered while the probe was still in flight
    // must be sent once it resolves rather than skipped for having been early —
    // the pump below is the part that is inert until then.
    if (sequence > this.#highestOffered) this.#highestOffered = sequence;
    this.#pump();
  }

  /**
   * Stop was pressed: no more audio is coming, so ask for the tail.
   *
   * Bounded inside the connection, because the audio is already durable and the
   * only thing being waited for is the last utterance's coverage. What the
   * endpoint never seals, `stopCapture` seals for the segmented queue.
   */
  async finish(): Promise<void> {
    if (this.#closed || !this.#started) return;
    this.#finishing = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    await this.#pumping.catch(() => undefined);
    const connection = this.#connection;
    if (connection) {
      await connection.finish().catch(() => undefined);
      connection.close();
    }
    // The tail's coverage arrives as an ordinary event, so the commit it starts
    // is on the event chain and has to settle before Stop can seal the rest.
    await this.#events.catch(() => undefined);
  }

  /** The capture is being closed or the app is quitting. Nothing further is sent, published, or committed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#connection?.close();
    this.#connection = null;
  }

  async #probe(): Promise<void> {
    let advertised: unknown = null;
    try {
      advertised = await this.#options.port.capabilities();
    } catch {
      // Unreachable, signed out, not JSON: one answer, and it is the honest one.
      advertised = null;
    }
    if (this.#closed) return;
    const endpoint = describeTranscriptionEndpoint(advertised);
    if (selectTranscriptionMode(endpoint) !== 'streaming' || endpoint.streaming === null) {
      this.#degrade(advertised === null ? MEETING_STREAM_NOTICE.unreachable : MEETING_STREAM_NOTICE.unsupported);
      return;
    }
    const latencyMode = preferredLatencyMode(endpoint.streaming.latencyModes);
    if (!latencyMode) {
      this.#degrade(MEETING_STREAM_NOTICE.unsupported);
      return;
    }
    this.#latencyMode = latencyMode;
    this.#mode = 'streaming';
    this.#announce(MEETING_STREAM_NOTICE.live);
    // A chunk offered while the probe was in flight is not lost: the pump is
    // started here rather than waiting for the next one.
    this.#pump();
  }

  #pump(): void {
    if (this.#closed || this.#mode !== 'streaming') return;
    this.#pumping = this.#pumping.then(() => this.#drainSends()).catch(() => undefined);
  }

  async #drainSends(): Promise<void> {
    while (!this.#closed && this.#mode === 'streaming' && this.#nextToSend <= this.#highestOffered) {
      const connection = await this.#ensureConnection();
      if (!connection) return;
      const sequence = this.#nextToSend;
      const chunk = captureChunks(this.#options.ledger.session()).find((entry) => entry.sequence === sequence);
      if (!chunk) return;
      const audio = await this.#options.ledger.readChunk(sequence);
      if (!audio?.byteLength) {
        // The ledger claims this chunk and the disk cannot give it back. The
        // gateway needs contiguity, so the live path ends here and the segmented
        // path takes over — where an unreadable chunk is a STATED gap (D5)
        // rather than a stream that quietly stops covering.
        this.#degrade(MEETING_STREAM_NOTICE.degraded);
        return;
      }
      try {
        connection.send({ sequence, startMs: chunk.startMs, endMs: chunk.endMs, audio });
      } catch {
        // The socket went away between the check and the send; the close handler
        // owns what happens next, and this chunk is re-sent from disk.
        return;
      }
      this.#nextToSend = sequence + 1;
      // Only while catching up. The live cadence is one chunk every few seconds
      // and must not be delayed at all; a REPLAY is the one moment this host
      // would breach the gateway's frames-per-second bound.
      if (this.#nextToSend <= this.#highestOffered) await this.#delay(SEND_PACE_MS);
    }
  }

  async #ensureConnection(): Promise<MeetingStreamConnection | null> {
    if (this.#connection) return this.#connection;
    if (this.#closed || this.#finishing || this.#mode !== 'streaming' || !this.#latencyMode) return null;
    this.#connecting ??= this.#open().finally(() => { this.#connecting = null; });
    await this.#connecting;
    return this.#connection;
  }

  async #open(): Promise<void> {
    const latencyMode = this.#latencyMode;
    if (!latencyMode) return;
    const resumeFromSequence = this.checkpoint;
    const replay = this.#highestOffered - (resumeFromSequence ?? -1);
    if (replay > MAX_REPLAY_CHUNKS) {
      this.#degrade(MEETING_STREAM_NOTICE.degraded);
      return;
    }
    const header = await this.#initializationSegment();
    if (this.#closed) return;
    let connection: MeetingStreamConnection;
    try {
      connection = await this.#options.port.open({
        sessionId: this.#options.sessionId,
        mimeType: this.#options.mimeType,
        language: this.#options.language ?? null,
        latencyMode,
        resumeFromSequence,
        initializationSegmentFor: (accepted) => (accepted === null ? new Uint8Array(0) : header),
        handlers: { onEvent: (event) => this.#accept(event) },
      });
    } catch (caught) {
      // A refusal that will refuse again — signed out, a plain-http account
      // host, a recorder MIME the gateway rejects — carries its own sentence and
      // ends the live path now rather than after four identical retries.
      if (caught instanceof MeetingStreamUnavailableError) this.#degrade(caught.notice);
      else this.#retryOrDegrade('endpoint');
      return;
    }
    if (this.#closed) {
      connection.close();
      return;
    }
    this.#connection = connection;
    // ADR-028/golden rule 28 — a connection that came back must not leave "being
    // picked up again" on screen. The sentence describes the state, so it is
    // re-stated when the state changes rather than only when it worsens.
    this.#announce(MEETING_STREAM_NOTICE.live);
    // The gateway never accepts a checkpoint above the one this host proved, so
    // the accepted value — not the requested one — decides what is replayed.
    this.#nextToSend = (connection.acceptedResumeFromSequence ?? -1) + 1;
    void connection.closed.then((kind) => {
      if (this.#connection !== connection) return;
      this.#connection = null;
      if (this.#closed || this.#finishing || kind === 'finished') return;
      this.#retryOrDegrade(kind);
    });
  }

  /**
   * The budget is spent by RECONNECTING and refunded by COVERING, never by
   * connecting.
   *
   * Resetting it on a successful open was wrong in the one case it existed for:
   * an endpoint that accepts a connection and immediately drops it would reset
   * the count every time and reconnect for ever, at a backoff that never grew.
   * A connection has proved itself when it has committed something — see
   * `#commit` — which is also the only event that makes the replay shorter.
   */
  #retryOrDegrade(kind: MeetingStreamCloseKind): void {
    if (kind === 'audio') { this.#degrade(MEETING_STREAM_NOTICE.undecodable); return; }
    if (kind === 'refused') { this.#degrade(MEETING_STREAM_NOTICE.degraded); return; }
    this.#attempts += 1;
    if (this.#attempts > MAX_RECONNECT_ATTEMPTS) { this.#degrade(MEETING_STREAM_NOTICE.degraded); return; }
    this.#announce(MEETING_STREAM_NOTICE.reconnecting);
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (this.#attempts - 1), MAX_RECONNECT_DELAY_MS);
    this.#cancelReconnect?.();
    this.#cancelReconnect = this.#schedule(() => {
      this.#cancelReconnect = null;
      // Replayed from the persisted checkpoint, out of audio that is on disk —
      // which is why a dropped connection costs a reconnect and not a meeting.
      this.#nextToSend = (this.checkpoint ?? -1) + 1;
      this.#pump();
    }, delayMs);
  }

  /**
   * The live path is over for this capture, and the surface is told why.
   *
   * Irreversible on purpose: a stream that has failed this way fails the same
   * way again, and flapping between two strategies would be a worse surface than
   * one honest sentence. The segmented queue needs no starting — it is already
   * draining every unit the ceiling seals.
   */
  #degrade(notice: string): void {
    this.#mode = 'segmented';
    this.#latencyMode = null;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#connection?.close();
    this.#connection = null;
    this.#announce(notice);
  }

  #announce(notice: string): void {
    this.#notice = notice;
    this.#report();
  }

  #report(): void {
    if (this.#closed) return;
    this.#options.publish({ status: this.status, live: this.live });
  }

  #accept(event: unknown): void {
    if (this.#closed) return;
    this.#events = this.#events.then(() => this.#handle(event)).catch(() => undefined);
  }

  async #handle(event: unknown): Promise<void> {
    if (this.#closed) return;
    const isCoverage = Boolean(event) && typeof event === 'object'
      && (event as { kind?: unknown }).kind === 'coverage';
    if (isCoverage) {
      await this.#commit(event);
      return;
    }
    const next = reduceStreamingTranscript(this.#state, event, captureChunks(this.#options.ledger.session()));
    if (next === this.#state) return;
    if (next.utterances.length > MAX_LIVE_UTTERANCES) {
      // Coverage stopped arriving. The chunks are still being sealed at the
      // ceiling and transcribed by the batch path, so the honest answer is to
      // stop pretending this connection is covering anything.
      this.#degrade(MEETING_STREAM_NOTICE.degraded);
      return;
    }
    this.#state = next;
    // D4/D10 — text WHILE the sentence is being spoken. This is the only push
    // that is not a persisted record, and it carries no editable text.
    this.#report();
  }

  /**
   * A coverage proof: seal what it covers, write the words down, and only then
   * let it become the resume authority.
   *
   * The order is the contract's. Promoting first and persisting afterwards would
   * mean a reconnect resuming past audio whose transcript never reached the
   * disk — the ADR's "checkpoint promoted only after the matching transcript
   * state has been persisted", inverted into silent loss.
   */
  async #commit(event: unknown): Promise<void> {
    const ledger = captureChunks(this.#options.ledger.session());
    const reduced = reduceStreamingTranscript(this.#state, event, ledger);
    const advanced = reduced.checkpoint?.acknowledgedThroughSequence ?? null;
    if (advanced === null || advanced === this.checkpoint) return;
    // Every final in hand belongs to the covered prefix: the reducer refuses a
    // coverage while a partial still starts inside it, so what is left after one
    // is the tail that has not been covered yet.
    const finals = reduced.utterances.filter((utterance) => utterance.state === 'final');
    try {
      await this.#options.ledger.apply((current) => {
        const before = current.segments.length;
        const sealed = sealUnit(current, { throughSequence: advanced });
        const created = sealed.segments.slice(before);
        let next = sealed;
        for (const unit of created) {
          next = markDone(next, unit.index, utteranceTextForUnit(unit, created, finals));
        }
        return next;
      });
    } catch {
      // The transcript state is not on disk, so the checkpoint does not move and
      // the same audio is replayed on the next connection. Nothing is dropped.
      return;
    }
    if (this.#closed) return;
    // This connection has now put words on disk, so the reconnect budget it may
    // have spent getting here is given back.
    this.#attempts = 0;
    // Frozen in the reducer's own canonical shape so the next event normalizes
    // it in place rather than rebuilding a copy of the whole live list.
    this.#state = Object.freeze({
      // Committed finals are settled text on disk now; keeping copies here would
      // grow for the length of the meeting and put the same words on the wire
      // twice, once as live and once as transcript.
      utterances: Object.freeze(reduced.utterances.filter((utterance) => utterance.state === 'partial')),
      checkpoint: reduced.checkpoint,
    });
    this.#report();
  }

  /**
   * The recording's container header, read once.
   *
   * A resumed connection is a fresh decode on the far side with no header in
   * front of it, and this is the same prefix `segmentAudio.ts` puts in front of
   * a batch unit for the same reason. An unreadable chunk 0 answers with an
   * empty header rather than failing: the endpoint may well decode the fragments
   * anyway, and refusing to stream over it would be the expensive way to be
   * cautious.
   */
  async #initializationSegment(): Promise<Uint8Array> {
    if (this.#initialization) return this.#initialization;
    const first = await this.#options.ledger.readChunk(0).catch(() => null);
    this.#initialization = first ? first.slice(0, initializationSegmentLength(first)) : new Uint8Array(0);
    return this.#initialization;
  }
}
