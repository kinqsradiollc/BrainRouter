import { describe, expect, it } from 'vitest';
import type { Duplex } from 'node:stream';
import {
  EGRESS_MAX_FRAME_BYTES,
  FramedEgressTransport,
  type EgressChannel,
} from './framedTransport.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ackFrame = (ok: boolean, error?: string): Uint8Array =>
  enc.encode(JSON.stringify({ v: 1, kind: 'dialed', ok, ...(error ? { error } : {}) }));

/** An in-memory {@link EgressChannel} the test drives directly. */
class MockChannel implements EgressChannel {
  readonly sent: Uint8Array[] = [];
  closeReason: string | null | undefined;
  onSend?: (frame: Uint8Array, index: number, chan: MockChannel) => void;
  #message?: (frame: Uint8Array) => void;
  #close?: (reason?: string) => void;

  send(frame: Uint8Array): void {
    const index = this.sent.length;
    this.sent.push(frame);
    this.onSend?.(frame, index, this);
  }
  onMessage(handler: (frame: Uint8Array) => void): void {
    this.#message = handler;
  }
  onClose(handler: (reason?: string) => void): void {
    this.#close = handler;
  }
  close(reason?: string): void {
    this.closeReason = reason ?? null;
    this.#close?.(reason);
  }

  deliver(frame: Uint8Array): void {
    this.#message?.(frame);
  }
  drop(reason?: string): void {
    this.#close?.(reason);
  }

  /** The parsed dial instruction (first frame the transport sent). */
  dialInstruction(): { kind: string; host: string; port: number } {
    return JSON.parse(dec.decode(this.sent[0]));
  }
}

/** A channel that acks the dial and echoes every later frame back. */
function loopbackChannel(): MockChannel {
  const channel = new MockChannel();
  channel.onSend = (frame, index, chan) => {
    if (index === 0) chan.deliver(ackFrame(true));
    else chan.deliver(frame); // echo raw bytes as the "provider" would return them
  };
  return channel;
}

function transportOf(channel: MockChannel): FramedEgressTransport {
  return new FramedEgressTransport(async () => channel);
}

describe('FramedEgressTransport — dial handshake', () => {
  it('sends the server-dictated host:port and resolves on ack', async () => {
    const channel = loopbackChannel();
    const duplex = await transportOf(channel).open({ host: 'api.provider.test', port: 8443 });
    expect(channel.dialInstruction()).toEqual({ v: 1, kind: 'dial', host: 'api.provider.test', port: 8443 });
    expect(duplex).toBeDefined();
    duplex.destroy();
  });

  it('rejects when the client cannot dial', async () => {
    const channel = new MockChannel();
    channel.onSend = (_f, index, chan) => {
      if (index === 0) chan.deliver(ackFrame(false, 'ECONNREFUSED'));
    };
    await expect(transportOf(channel).open({ host: 'api.provider.test', port: 443 })).rejects.toThrow(/ECONNREFUSED/);
    expect(channel.closeReason).not.toBeUndefined(); // failed dial closes the channel
  });

  it('rejects on a malformed dial reply', async () => {
    const channel = new MockChannel();
    channel.onSend = (_f, index, chan) => {
      if (index === 0) chan.deliver(enc.encode('not json'));
    };
    await expect(transportOf(channel).open({ host: 'x.test', port: 443 })).rejects.toThrow(/malformed/i);
  });

  it('rejects when the channel closes before the dial completes', async () => {
    const channel = new MockChannel();
    channel.onSend = (_f, index, chan) => {
      if (index === 0) chan.drop('relay closed');
    };
    await expect(transportOf(channel).open({ host: 'x.test', port: 443 })).rejects.toThrow(/relay closed/);
  });
});

describe('FramedEgressTransport — byte bridge', () => {
  it('round-trips bytes through the channel after the handshake', async () => {
    const duplex = await transportOf(loopbackChannel()).open({ host: 'x.test', port: 443 });
    const received = collect(duplex);
    duplex.write(Buffer.from('hello tls record'));
    await tick();
    duplex.destroy();
    expect(Buffer.concat(await received).toString()).toContain('hello tls record');
  });

  it('splits a write larger than the frame ceiling into bounded frames', async () => {
    const channel = loopbackChannel();
    const duplex = await transportOf(channel).open({ host: 'x.test', port: 443 });
    const payload = Buffer.alloc(EGRESS_MAX_FRAME_BYTES * 2 + 10, 7);
    duplex.write(payload);
    await tick();
    const dataFrames = channel.sent.slice(1); // drop the dial frame
    expect(dataFrames.length).toBe(3);
    for (const frame of dataFrames) expect(frame.byteLength).toBeLessThanOrEqual(EGRESS_MAX_FRAME_BYTES);
    duplex.destroy();
  });

  it('ends the duplex (EOF) when the channel closes', async () => {
    const channel = loopbackChannel();
    const duplex = await transportOf(channel).open({ host: 'x.test', port: 443 });
    const ended = new Promise<void>((resolve) => duplex.on('end', resolve));
    duplex.resume(); // flowing mode so 'end' fires
    channel.drop();
    await expect(ended).resolves.toBeUndefined();
  });

  it('closes the channel when the duplex is destroyed', async () => {
    const channel = loopbackChannel();
    const duplex = await transportOf(channel).open({ host: 'x.test', port: 443 });
    duplex.destroy();
    await tick();
    expect(channel.closeReason).not.toBeUndefined();
  });
});

function collect(duplex: Duplex): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    duplex.on('data', (c: Buffer) => chunks.push(c));
    duplex.on('close', () => resolve(chunks));
    duplex.on('end', () => resolve(chunks));
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
