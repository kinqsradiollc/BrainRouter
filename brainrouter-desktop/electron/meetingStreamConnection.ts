/**
 * ADR-035 D10 — one live transcription connection, from attach to finish.
 *
 * `meetingStreamProtocol.ts` says what a frame looks like; this says what order
 * frames go in and what each answer means. It owns exactly one connection and
 * has no opinion about reconnecting, about the meeting, or about the record —
 * `meetingStreamSession.ts` owns all three. The split matters because the two
 * fail differently: a connection either attaches or does not, while a SESSION
 * survives connections failing.
 *
 * The socket is a port rather than a `ws` import so the handshake is testable
 * without a listener. The real one is `meetingStreamSocket.ts`, which is the
 * only file in this host that constructs a `WebSocket`.
 *
 * Three ordering rules the gateway enforces and this module therefore obeys:
 *
 * 1. **Nothing precedes attach, and nothing follows it until `attached`.** The
 *    gateway closes 1002 on the second frame it sees before the handshake
 *    resolves, so `connect` does not resolve — and no audio is sent — until the
 *    accepted state is in hand.
 * 2. **The container bootstrap precedes audio**, exactly once per connection,
 *    including after a reconnect. A resumed stream is a fresh decode on the
 *    other side and has no header in front of it otherwise.
 * 3. **Sequences are contiguous from what the gateway accepted**, not from what
 *    this host asked for. The accepted checkpoint is authoritative and is what
 *    the caller replays from.
 */
import {
  classifyMeetingStreamClose,
  encodeMeetingStreamAttach,
  encodeMeetingStreamAudio,
  encodeMeetingStreamInitialization,
  parseMeetingStreamMessage,
  MEETING_STREAM_FINISH_FRAME,
  type MeetingStreamAttachInput,
  type MeetingStreamAudioFrame,
  type MeetingStreamCloseKind,
} from './meetingStreamProtocol.js';

/** What a transport has to give this module. Deliberately smaller than `WebSocket`. */
export interface MeetingStreamSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface MeetingStreamSocketListeners {
  onOpen(): void;
  /** The gateway only ever sends text frames; a binary one is a protocol error there, not here. */
  onMessage(text: string): void;
  onClose(code: number): void;
  onError(error: unknown): void;
}

export type MeetingStreamSocketFactory = (
  url: string,
  listeners: MeetingStreamSocketListeners,
) => MeetingStreamSocket;

export interface MeetingStreamConnectionHandlers {
  /**
   * One transcript event, exactly as the gateway sent it.
   *
   * Unvalidated on purpose: `reduceStreamingTranscript` is the single validator
   * of this shape, and a second one here would be a second opinion about what a
   * partial is — which is how the two hosts' rules drifted before D1b.
   */
  onEvent(event: unknown): void;
}

export interface MeetingStreamConnectInput {
  readonly url: string;
  readonly attach: MeetingStreamAttachInput;
  /**
   * The bootstrap for the checkpoint the gateway ACCEPTED, which may be lower
   * than the one asked for. Empty when the accepted stream starts at chunk 0,
   * because that chunk carries the recording's own header and prepending a
   * second one is a stream two decoders read differently.
   */
  initializationSegmentFor(acceptedResumeFromSequence: number | null): Uint8Array;
  readonly socket: MeetingStreamSocketFactory;
  readonly handlers: MeetingStreamConnectionHandlers;
  /** Bounded so a socket that opens and then says nothing cannot hold a meeting's stream open for ever. */
  readonly attachTimeoutMs?: number;
  /** How long `finish` waits for the endpoint to seal the tail before giving up on it. */
  readonly finishTimeoutMs?: number;
}

export interface MeetingStreamConnection {
  /** What the gateway accepted, never what was asked for. The caller replays from here. */
  readonly acceptedResumeFromSequence: number | null;
  readonly latencyMode: string;
  /** Throws once the connection is gone, so a caller cannot believe a chunk was sent. */
  send(chunk: MeetingStreamAudioFrame): void;
  /** Resolves when the endpoint has sealed the tail, or when waiting for it stopped being worth it. */
  finish(): Promise<void>;
  close(): void;
  /** How this connection ended. Resolves exactly once, and never rejects. */
  readonly closed: Promise<MeetingStreamCloseKind>;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_FINISH_TIMEOUT_MS = 5_000;

class MeetingStreamClosedError extends Error {
  constructor() {
    super('The live transcription connection is closed.');
    this.name = 'MeetingStreamClosedError';
  }
}

/**
 * Open a connection and complete its handshake.
 *
 * Rejects when the socket fails, when the attach deadline passes, or when the
 * gateway closes instead of attaching. Every one of those is an ordinary answer
 * for the caller — the audio is already on disk — so the rejection carries the
 * close classification when there is one.
 */
export function connectMeetingStream(input: MeetingStreamConnectInput): Promise<MeetingStreamConnection> {
  const attachTimeoutMs = input.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const finishTimeoutMs = input.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;
  // Neither timer below is `unref`'d, deliberately. Both are bounded — ten
  // seconds to attach, five to seal the tail — and both are cleared the moment
  // they are answered, so what they hold open is exactly the handshake a caller
  // is already awaiting. An unref'd deadline is a deadline the runtime may skip.
  return new Promise<MeetingStreamConnection>((resolve, reject) => {
    let attached = false;
    let settled = false;
    let open = true;
    let finishedSeen = false;
    let resolveClosed: (kind: MeetingStreamCloseKind) => void = () => undefined;
    let resolveFinished: () => void = () => undefined;
    const closed = new Promise<MeetingStreamCloseKind>((done) => { resolveClosed = done; });
    const finished = new Promise<void>((done) => { resolveFinished = done; });
    // Assigned after the listeners are built, and read only from them: a
    // transport that reports `open` synchronously must not find this in its
    // temporal dead zone.
    let socket: MeetingStreamSocket | null = null;
    let openedBeforeAssignment = false;
    const closeSocket = (): void => { socket?.close(); };

    const attachTimer = setTimeout(() => {
      if (attached) return;
      // The gateway has its own attach deadline; this is the case it cannot
      // cover — a socket that never opened, or an answer that never arrived.
      fail(new Error('The live transcription endpoint did not answer the attach request.'));
      closeSocket();
    }, attachTimeoutMs);

    const finish = (kind: MeetingStreamCloseKind): void => {
      if (!open) return;
      open = false;
      clearTimeout(attachTimer);
      resolveClosed(kind);
      resolveFinished();
    };

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(attachTimer);
      reject(error instanceof Error ? error : new Error('The live transcription connection failed.'));
    }

    const listeners: MeetingStreamSocketListeners = {
      onOpen(): void {
        if (!socket) { openedBeforeAssignment = true; return; }
        // Rule 1 — the credential-bearing frame is the first thing on the wire,
        // and nothing else goes out until the gateway has answered it.
        try {
          socket.send(encodeMeetingStreamAttach(input.attach));
        } catch (caught) {
          fail(caught);
          closeSocket();
        }
      },
      onMessage(text: string): void {
        const message = parseMeetingStreamMessage(text);
        if (!message) return;
        if (message.type === 'transcript.event') {
          input.handlers.onEvent(message.event);
          return;
        }
        if (message.type === 'finished') {
          finishedSeen = true;
          resolveFinished();
          return;
        }
        if (attached || settled) return;
        attached = true;
        settled = true;
        clearTimeout(attachTimer);
        // Rule 2 — the bootstrap goes out before the caller can send a chunk,
        // so there is no ordering for a caller to get wrong.
        try {
          socket?.send(encodeMeetingStreamInitialization(
            input.initializationSegmentFor(message.acceptedResumeFromSequence),
          ));
        } catch (caught) {
          reject(caught instanceof Error ? caught : new Error('The live transcription connection failed.'));
          closeSocket();
          return;
        }
        resolve({
          acceptedResumeFromSequence: message.acceptedResumeFromSequence,
          latencyMode: message.latencyMode,
          send(chunk: MeetingStreamAudioFrame): void {
            if (!open || !socket) throw new MeetingStreamClosedError();
            socket.send(encodeMeetingStreamAudio(chunk));
          },
          async finish(): Promise<void> {
            if (!open || !socket) return;
            try {
              socket.send(MEETING_STREAM_FINISH_FRAME);
            } catch {
              return;
            }
            let timer: NodeJS.Timeout | undefined;
            const bound = new Promise<void>((done) => {
              timer = setTimeout(done, finishTimeoutMs);
            });
            // Bounded because Stop is a click a person is waiting on. What is at
            // stake is the last utterance, not the audio: every chunk is already
            // durable, so a tail the endpoint never sealed is sealed by the
            // segmented path instead (D10's mandatory fallback).
            await Promise.race([finished, bound]);
            if (timer) clearTimeout(timer);
          },
          close: closeSocket,
          closed,
        });
      },
      onClose(code: number): void {
        const kind = finishedSeen ? 'finished' : classifyMeetingStreamClose(code);
        finish(kind);
        // A close BEFORE `attached` is the handshake's answer, so it rejects
        // rather than resolving a connection nothing can be sent on.
        fail(new Error(`The live transcription endpoint closed the connection (${code}).`));
      },
      onError(error: unknown): void {
        fail(error);
        finish('endpoint');
      },
    };

    socket = input.socket(input.url, listeners);
    if (openedBeforeAssignment) listeners.onOpen();
  });
}
