// ADR-041 A41-5 (D2) — a provider-neutral streaming protocol. The transport
// streams via callbacks (`onTextDelta` / `onReasoningDelta`) and returns the final
// result. This wraps that callback interface as a typed `AsyncIterable<StreamChunk>`
// so consumers iterate one discriminated union instead of registering callbacks and
// then reading a separate return value — no provider-specific streaming type leaks
// into the consumer. The OpenAI SSE parsing stays in `callOpenAIStream`; this is the
// seam every consumer migrates onto, one at a time (modelInvocationPhase first).
import type { LLMConfig } from '../../config/config.js';
import { callOpenAIStream, type BuildPayloadOptions } from './llmTransport.js';

/** The final value `callOpenAIStream` resolves to (content / toolCalls / usage / …). */
export type ProviderStreamResult = Awaited<ReturnType<typeof callOpenAIStream>>;

/**
 * One event in a provider stream. `text` / `reasoning` carry incremental deltas in
 * arrival order; the terminal `done` carries the assembled result. Exactly one
 * `done` is emitted (last) unless the stream errors, in which case the iterator
 * rejects after yielding whatever deltas arrived first — matching the callback
 * transport, where deltas fire before a thrown error.
 */
export type StreamChunk =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'reasoning'; readonly delta: string }
  | { readonly type: 'done'; readonly result: ProviderStreamResult };

/**
 * Drive `callOpenAIStream` and surface its deltas + final result as a typed async
 * stream. Byte-neutral relative to the callback path: the same deltas are produced
 * in the same order and the same result object is returned (as the `done` chunk).
 */
export async function* callProviderStream(
  config: LLMConfig,
  messages: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  tools: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  options: BuildPayloadOptions = {},
): AsyncGenerator<StreamChunk, void, unknown> {
  const queue: StreamChunk[] = [];
  let wake: (() => void) | null = null;
  const bump = (): void => { const w = wake; wake = null; w?.(); };
  const push = (chunk: StreamChunk): void => { queue.push(chunk); bump(); };

  let settled = false;
  let failure: unknown;
  // Run the transport concurrently; its callbacks feed the queue as deltas arrive,
  // and its resolution enqueues the terminal `done` chunk (or records the error).
  const run = callOpenAIStream(config, messages, tools, options, {
    onTextDelta: (delta) => push({ type: 'text', delta }),
    onReasoningDelta: (delta) => push({ type: 'reasoning', delta }),
  }).then(
    (result) => { push({ type: 'done', result }); },
    (err) => { failure = err; },
  ).finally(() => { settled = true; bump(); });

  // Yield everything queued, in order, until the transport has settled and drained.
  while (true) {
    while (queue.length > 0) yield queue.shift()!;
    if (settled) {
      await run; // the catch handler already captured any error into `failure`
      if (failure !== undefined) throw failure;
      return;
    }
    await new Promise<void>((resolve) => { wake = resolve; });
  }
}
