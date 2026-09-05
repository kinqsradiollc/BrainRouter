/**
 * ADR-052 P1a (D1a) — a streamed response cut off mid-answer by a server error,
 * connection loss, or stall is CONTINUED, not failed. The transport retains the
 * partial text and re-issues the request as a continuation (the partial replayed
 * as an assistant prefill so the model resumes rather than restarts), bounded by
 * a small continuation budget. A user abort (Stop) is never continued.
 *
 * Kept as a pure driver over an injected `run` so it unit-tests without a live
 * model: a fake `run` that yields a few deltas then throws once, and completes on
 * the retry, proves the stitch.
 */
import type { StreamChunk, ProviderStreamResult } from './providerStream.js';

type DoneChunk = Extract<StreamChunk, { type: 'done' }>;

/**
 * Replay the partial assistant text as a prefill message so a re-issued request
 * CONTINUES the response instead of starting over. Empty partial ⇒ messages
 * unchanged.
 */
export function buildContinuationMessages<T>(messages: readonly T[], partialText: string): T[] {
  if (!partialText) return [...messages];
  return [...messages, { role: 'assistant', content: partialText } as unknown as T];
}

export interface StreamContinuationOptions {
  /** Start (or continue, when `seed` is non-null) a streaming attempt. */
  run: (seed: string | null) => AsyncIterable<StreamChunk>;
  /** True when the error is a retryable server/connectivity cut (NOT a user abort). */
  isRetryable: (err: unknown) => boolean;
  /** How many times to re-issue as a continuation before giving up. Default 2. */
  maxContinuations?: number;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

/**
 * Drive a streaming attempt, continuing across a retryable mid-stream cut. On a
 * clean finish, returns the terminal `done` chunk with `content` stitched to the
 * full accumulated text. Rethrows when the cut is not retryable, no text has
 * arrived yet, or the continuation budget is spent — i.e. it never turns a fatal
 * failure into a silent truncation.
 */
export async function streamWithContinuation(opts: StreamContinuationOptions): Promise<DoneChunk> {
  const max = opts.maxContinuations ?? 2;
  let accumulated = '';
  let seed: string | null = null;

  for (let attempt = 0; ; attempt++) {
    try {
      let done: DoneChunk | undefined;
      for await (const chunk of opts.run(seed)) {
        if (chunk.type === 'text') {
          accumulated += chunk.delta;
          opts.onText?.(chunk.delta);
        } else if (chunk.type === 'reasoning') {
          opts.onReasoning?.(chunk.delta);
        } else {
          done = chunk;
        }
      }
      if (!done) throw new Error('stream ended without a terminal result');
      // Stitch the full accumulated text (partial + continuation) into the final
      // result; a single clean attempt already has content === accumulated.
      const result: ProviderStreamResult = accumulated && done.result.content !== accumulated
        ? { ...done.result, content: accumulated }
        : done.result;
      return { type: 'done', result };
    } catch (err) {
      // Continue ONLY when the cut is retryable, some text already arrived, and
      // there is budget left; otherwise the failure is real — rethrow it.
      if (attempt >= max || !accumulated || !opts.isRetryable(err)) throw err;
      seed = accumulated;
    }
  }
}
