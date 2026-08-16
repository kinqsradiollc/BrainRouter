/**
 * ADR-035 D10 — the only place this host constructs a WebSocket.
 *
 * Everything about the live transcription protocol is in
 * `meetingStreamProtocol.ts` and `meetingStreamConnection.ts`, which know
 * nothing about `ws`. This is the adapter between them and the library, and it
 * is deliberately the smallest file in the group: what cannot be unit-tested
 * without a listener should be the part with no decisions in it.
 *
 * Two of those non-decisions are still worth stating. The gateway only ever
 * sends text frames, so a binary one is decoded as UTF-8 and left to the parser
 * to reject rather than being special-cased into a second error path. And the
 * socket is capped at the gateway's own maximum payload, so a server that
 * answered with something enormous costs a closed connection rather than this
 * process's memory.
 */
import { WebSocket } from 'ws';
import type { MeetingStreamSocket, MeetingStreamSocketListeners } from './meetingStreamConnection.js';

/** The gateway's own frame ceiling (256 KB initialization + a 21-byte header), applied to what it sends back. */
const MAX_PAYLOAD_BYTES = 256 * 1024 + 21;

export function createMeetingStreamSocket(
  url: string,
  listeners: MeetingStreamSocketListeners,
): MeetingStreamSocket {
  const socket = new WebSocket(url, { maxPayload: MAX_PAYLOAD_BYTES, followRedirects: false });
  socket.on('open', () => listeners.onOpen());
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    listeners.onMessage(bytes.toString('utf8'));
  });
  socket.on('close', (code: number) => listeners.onClose(code));
  socket.on('error', (error: unknown) => listeners.onError(error));
  return {
    send(payload: string | Uint8Array): void {
      socket.send(payload);
    },
    close(): void {
      // `close` on a socket still connecting throws in some states; terminating
      // a connection that is going away anyway is not a failure worth raising to
      // a meeting.
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
    },
  };
}
