/**
 * ADR-043 S3b (C5b) — the per-dial edge handler. For each `dial` push the control
 * client (C5a) surfaces, this: attaches a client seat to the server's
 * `/egress-relay` with the one-use ticket, receives the gateway's opaque dial
 * instruction over that splice, VETS the target with the SSRF guard, opens a RAW
 * TCP socket to it from the device's own network, replies a binary `dialed` ack,
 * and then splices ciphertext bytes verbatim between the relay and the provider.
 *
 * The device never terminates TLS — the server does (server-terminated TLS), so
 * every byte crossing here is opaque ciphertext; the credential and plaintext
 * never reach the device. The wire handshake mirrors the gateway's
 * `FramedEgressTransport`: a binary `{v:1,kind:'dial',host,port}` in, a binary
 * `{v:1,kind:'dialed',ok}` out, then raw bytes. Every refusal replies
 * `dialed:{ok:false}` so the gateway's fallback ladder drops to direct egress.
 */
import { vetDialTarget, DialNotAllowedError, type VettedTarget } from './edgeDialGuard.js';
import type { EgressDialInstruction } from './egressControlClient.js';
import type { LookupAddress } from 'node:dns';

const EGRESS_MAX_FRAME_BYTES = 128 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;

/** A relay WebSocket that carries both text control frames and binary payload. */
export interface RelaySocketLike {
  send(data: string | Uint8Array, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

/** A raw TCP socket to the provider (server-terminated TLS ⇒ opaque bytes only). */
export interface TcpSocketLike {
  write(data: Uint8Array): void;
  end(): void;
  destroy(): void;
  on(event: 'connect' | 'data' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

export interface EdgeDialHandlerDeps {
  relayWsFactory(url: string): RelaySocketLike;
  tcpConnect(target: VettedTarget): TcpSocketLike;
  /** The enrolled device id used in the relay attach frame. */
  deviceId(): string | null;
  /** SSRF vetting; defaults to {@link vetDialTarget} with the allowlist/lookup below. */
  vet?(host: string, port: number): Promise<VettedTarget>;
  isHostAllowed?(host: string): boolean;
  lookup?(host: string): Promise<LookupAddress[]>;
  now?(): number;
  connectTimeoutMs?: number;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d as Uint8Array))));
  return new Uint8Array(0);
}

function decodeDialInstruction(frame: Uint8Array): { host: string; port: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(frame));
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === 'dial' &&
    typeof (parsed as { host?: unknown }).host === 'string' &&
    typeof (parsed as { port?: unknown }).port === 'number'
  ) {
    return { host: (parsed as { host: string }).host, port: (parsed as { port: number }).port };
  }
  return null;
}

function encodeDialed(ok: boolean, error?: string): Uint8Array {
  const message = error === undefined ? { v: 1, kind: 'dialed', ok } : { v: 1, kind: 'dialed', ok, error };
  return new TextEncoder().encode(JSON.stringify(message));
}

type DialState = 'attaching' | 'dialing' | 'splicing' | 'closed';

/**
 * Handles exactly one dial per {@link handle} call. Stateless across dials, so the
 * control client can invoke it for every push; each call owns its own relay + TCP
 * sockets and tears both down together on any error or close.
 */
export class EdgeDialHandler {
  constructor(private readonly deps: EdgeDialHandlerDeps) {}

  private vet(host: string, port: number): Promise<VettedTarget> {
    if (this.deps.vet) return this.deps.vet(host, port);
    return vetDialTarget(host, port, { isHostAllowed: this.deps.isHostAllowed, lookup: this.deps.lookup });
  }

  handle(instruction: EgressDialInstruction): void {
    // Refuse a dial whose ticket has already expired (20 s TTL) before touching
    // the network — a delayed/replayed push must not open a socket.
    const now = (this.deps.now ?? Date.now)();
    const expiry = Date.parse(instruction.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) return;

    const relay = this.deps.relayWsFactory(instruction.relayUrl);
    let state: DialState = 'attaching';
    let tcp: TcpSocketLike | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const teardown = (reason?: string): void => {
      if (state === 'closed') return;
      state = 'closed';
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      try {
        relay.close(1000, reason);
      } catch {
        /* best effort */
      }
      try {
        tcp?.destroy();
      } catch {
        /* best effort */
      }
    };

    const refuse = (error: string): void => {
      try {
        relay.send(encodeDialed(false, error), { binary: true });
      } catch {
        /* best effort */
      }
      teardown(error);
    };

    relay.on('open', () => {
      const deviceId = this.deps.deviceId();
      if (!deviceId) {
        teardown('device not enrolled');
        return;
      }
      relay.send(JSON.stringify({ kind: 'attach', ticket: instruction.clientToken, deviceId }));
    });

    relay.on('message', (...args: unknown[]) => {
      const isBinary = args[1] === true;
      if (!isBinary) return; // relay TEXT control frames (attached/peer-*) — not ours to act on
      const frame = toBytes(args[0]);
      if (state === 'attaching' || state === 'dialing') {
        if (state === 'dialing') return; // already handling the one dial instruction
        state = 'dialing';
        void this.onDialInstruction(frame, instruction, relay, {
          onConnected: (socket) => {
            tcp = socket;
            state = 'splicing';
          },
          setTimer: (t) => {
            connectTimer = t;
          },
          clearTimer: () => {
            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
          },
          refuse,
          teardown,
        });
        return;
      }
      if (state === 'splicing' && tcp) tcp.write(frame); // raw ciphertext → provider
    });

    relay.on('close', () => teardown('relay closed'));
    relay.on('error', () => teardown('relay error'));
  }

  private async onDialInstruction(
    frame: Uint8Array,
    instruction: EgressDialInstruction,
    relay: RelaySocketLike,
    hooks: {
      onConnected: (socket: TcpSocketLike) => void;
      setTimer: (t: ReturnType<typeof setTimeout>) => void;
      clearTimer: () => void;
      refuse: (error: string) => void;
      teardown: (reason?: string) => void;
    },
  ): Promise<void> {
    const parsed = decodeDialInstruction(frame);
    if (!parsed) {
      hooks.refuse('malformed dial instruction');
      return;
    }
    // The relay-delivered target MUST match the control-push target — a divergence
    // means the instruction was tampered with in transit.
    if (parsed.host !== instruction.host || parsed.port !== instruction.port) {
      hooks.refuse('dial target mismatch');
      return;
    }

    let vetted: VettedTarget;
    try {
      vetted = await this.vet(parsed.host, parsed.port);
    } catch (err) {
      hooks.refuse(err instanceof DialNotAllowedError ? err.message : 'dial target refused');
      return;
    }

    let settled = false;
    const socket = this.deps.tcpConnect(vetted);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      hooks.refuse('dial timed out');
    }, this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    hooks.setTimer(timer);

    socket.on('connect', () => {
      if (settled) return;
      settled = true;
      hooks.clearTimer();
      hooks.onConnected(socket);
      relay.send(encodeDialed(true), { binary: true }); // ack; the gateway now streams bytes
    });
    socket.on('data', (...dataArgs: unknown[]) => {
      const chunk = toBytes(dataArgs[0]);
      // Split at the relay frame ceiling so one large record can't trip the
      // payload-blind splice's bound.
      for (let offset = 0; offset < chunk.length; offset += EGRESS_MAX_FRAME_BYTES) {
        relay.send(chunk.subarray(offset, offset + EGRESS_MAX_FRAME_BYTES), { binary: true });
      }
    });
    socket.on('close', () => hooks.teardown('provider closed'));
    socket.on('error', () => {
      if (settled) {
        hooks.teardown('provider error');
        return;
      }
      settled = true;
      hooks.refuse('dial failed');
    });
  }
}
