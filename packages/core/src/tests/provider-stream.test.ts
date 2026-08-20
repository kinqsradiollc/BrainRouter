// ADR-041 A41-5 — the provider-neutral streaming wrapper. These pin the adapter
// contract independently of the network: a stubbed globalThis.fetch drives the real
// callOpenAIStream underneath (OpenAI Responses typed SSE), and we assert the
// StreamChunk order + terminal done + error propagation match the callback transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProviderStream, type StreamChunk } from '../agent/transport/providerStream.js';

const cfg = { provider: 'openai', apiKey: 'k', model: 'gpt-5', endpoint: 'https://api.openai.com/v1' } as any;

// A Responses typed-SSE body from a list of text deltas + a completed frame.
function responsesFrames(deltas: string[]): unknown[] {
  return [
    ...deltas.map((delta) => ({ type: 'response.output_text.delta', delta })),
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2 } } },
  ];
}

function withStubbedFetch(frames: unknown[] | null, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => {
    if (frames === null) {
      return new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }) as any;
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) as any;
  }) as typeof fetch;
  return run().finally(() => { globalThis.fetch = original; });
}

test('A41-5 — deltas stream in order, terminated by exactly one done chunk', async () => {
  await withStubbedFetch(responsesFrames(['Hel', 'lo', ' world']), async () => {
    const chunks: StreamChunk[] = [];
    for await (const c of callProviderStream(cfg, [{ role: 'user', content: 'hi' }], [])) chunks.push(c);

    const texts = chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta);
    assert.deepEqual(texts, ['Hel', 'lo', ' world'], 'text deltas preserved in order');

    const dones = chunks.filter((c) => c.type === 'done');
    assert.equal(dones.length, 1, 'exactly one done chunk');
    assert.equal(chunks[chunks.length - 1].type, 'done', 'done is last');
    const result = (dones[0] as { result: { content: string } }).result;
    assert.equal(result.content, 'Hello world', 'the done chunk carries the assembled result');
  });
});

test('A41-5 — a stream with no deltas still yields a done chunk', async () => {
  await withStubbedFetch(responsesFrames([]), async () => {
    const chunks: StreamChunk[] = [];
    for await (const c of callProviderStream(cfg, [{ role: 'user', content: 'hi' }], [])) chunks.push(c);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'done');
  });
});

test('A41-5 — the iterator rejects when the transport fails', async () => {
  await withStubbedFetch(null, async () => {
    await assert.rejects(async () => {
      for await (const _c of callProviderStream(cfg, [{ role: 'user', content: 'hi' }], [])) { /* drain */ }
    }, /./);
  });
});
