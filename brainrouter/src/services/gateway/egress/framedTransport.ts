import { Duplex } from 'node:stream';
import type { EgressDialTarget, EgressTunnelTransport } from './tunnelTransport.js';

/**
 * ADR-043 S3b — an already-attached, opaque, bidirectional frame channel to ONE
 * client device. The relay's payload-blind splice moves these frames verbatim
 * between the gateway and the client (its bounds/close-codes apply); this
 * interface is deliberately transport-agnostic so `FramedEgressTransport` can be
 * unit-tested against an in-memory channel while the relay-backed implementation
 * (the egress channel type + ticketing) lands separately.
 *
 * A channel carries exactly one tunnel. Frames are opaque `Uint8Array`s: the
 * gateway sends one small dial-instruction frame first, then raw TLS record
 * bytes; the client acks the dial, then splices to the provider socket.
 */
export interface EgressChannel {
  send(frame: Uint8Array): void;
  onMessage(handler: (frame: Uint8Array) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}

/** Opens a fresh {@link EgressChannel} to the user's edge for one upstream dial. */
export type EgressChannelOpener = (
  target: EgressDialTarget,
  options?: { readonly signal?: AbortSignal },
) => Promise<EgressChannel>;

/** Relay frame ceiling (`MAX_FRAME_BYTES`); larger writes are split before sending. */
export const EGRESS_MAX_FRAME_BYTES = 128 * 1024;

/** The gateway's first frame: name the allowlisted endpoint the client must dial. */
interface DialInstruction {
  readonly v: 1;
  readonly kind: 'dial';
  readonly host: string;
  readonly port: number;
}

/** The client's reply to a {@link DialInstruction}. */
interface DialResult {
  readonly v: 1;
  readonly kind: 'dialed';
  readonly ok: boolean;
  readonly error?: string;
}

function encodeControl(message: DialInstruction): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

function decodeDialResult(frame: Uint8Array): DialResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(frame));
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' && parsed !== null
    && (parsed as { kind?: unknown }).kind === 'dialed'
    && typeof (parsed as { ok?: unknown }).ok === 'boolean'
  ) {
    return parsed as DialResult;
  }
  return null;
}

/**
 * ADR-043 S3b — the relay-backed {@link EgressTunnelTransport}: adapt an
 * {@link EgressChannel} into the byte `Duplex` the tunnel dialer terminates TLS
 * over. `open()` acquires a channel, sends the dial instruction, waits for the
 * client's ack, then returns a duplex that frames outgoing TLS bytes onto the
 * channel and de-frames incoming ones — bounded by the relay frame ceiling.
 *
 * It never inspects payload bytes (they are ciphertext, ADR-043 D1); the only
 * structured exchange is the opening dial handshake.
 *
 * SSRF boundary (ADR-043 §5, per seam-author review): `target` is the
 * SERVER-validated upstream host:port (from `dialTargetFromValidated` of a
 * `ValidatedUpstreamTarget`). The client is *told* where to dial and can never
 * name the host — the egress path reaches nothing the direct path's
 * `validateUpstreamTarget` allowlist does not already permit.
 */
export class FramedEgressTransport implements EgressTunnelTransport {
  constructor(private readonly openChannel: EgressChannelOpener) {}

  async open(target: EgressDialTarget, options?: { readonly signal?: AbortSignal }): Promise<Duplex> {
    const channel = await this.openChannel(target, options);
    // ONE stateful handler for the channel's lifetime: it dispatches the dial
    // ack first, then raw bytes — so no data frame can slip through a gap between
    // a handshake handler and a separate bridge handler.
    return new Promise<Duplex>((resolve, reject) => {
      let state: 'dialing' | 'open' | 'closed' = 'dialing';
      let duplex: Duplex | null = null;
      const signal = options?.signal;

      const detach = (): void => signal?.removeEventListener('abort', onAbort);
      const failDial = (message: string): void => {
        if (state !== 'dialing') return;
        state = 'closed';
        detach();
        channel.close(message);
        reject(new Error(message));
      };
      // The fallback ladder aborts the signal on its connect-timeout; honour it
      // here so a live-but-unacked channel (edge accepted the splice then
      // black-holed the dial) is torn down instead of leaking the relay socket
      // and this never-settling promise.
      const onAbort = (): void => failDial('egress dial aborted before the tunnel opened');

      channel.onClose((reason) => {
        if (state === 'dialing') {
          failDial(reason ?? 'egress channel closed before dial');
          return;
        }
        state = 'closed';
        duplex?.push(null); // upstream EOF — the TLS layer notices a dropped tunnel
      });

      channel.onMessage((frame) => {
        if (state === 'dialing') {
          const result = decodeDialResult(frame);
          if (!result) {
            failDial('egress client sent a malformed dial reply');
          } else if (!result.ok) {
            failDial(`egress client could not dial ${target.host}:${target.port}: ${result.error ?? 'unknown'}`);
          } else {
            state = 'open';
            detach();
            duplex = this.#bridge(channel);
            resolve(duplex);
          }
          return;
        }
        if (state === 'open') duplex?.push(Buffer.from(frame)); // raw TLS bytes
      });

      if (signal?.aborted) {
        failDial('egress dial aborted before the tunnel opened');
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      channel.send(encodeControl({ v: 1, kind: 'dial', host: target.host, port: target.port }));
    });
  }

  /** Post-handshake byte bridge: outgoing TLS bytes ⇄ bounded opaque frames. */
  #bridge(channel: EgressChannel): Duplex {
    return new Duplex({
      read() {},
      write(chunk: Buffer, _enc, callback) {
        // Split at the relay frame ceiling so a single large TLS record can never
        // exceed the payload-blind splice's bound and trip its close code.
        for (let offset = 0; offset < chunk.length; offset += EGRESS_MAX_FRAME_BYTES) {
          channel.send(chunk.subarray(offset, offset + EGRESS_MAX_FRAME_BYTES));
        }
        callback();
      },
      destroy(err, callback) {
        channel.close(err?.message);
        callback(err);
      },
    });
  }
}
