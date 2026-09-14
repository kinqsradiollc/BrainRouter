/**
 * A stall watchdog for a streaming provider response.
 *
 * `cli.llmTimeoutMs` guards the request — it is cleared the moment the 200
 * arrives, before a single body byte is read. Nothing then bounds the body: a
 * provider that stops sending (a dead upstream, a server-side loop that never
 * reaches `done`) left the turn "working…" forever. A live desktop session sat
 * for six minutes on a Matilda request whose stream simply went silent.
 *
 * The watchdog races every body read against `stallMs` of silence. A healthy
 * stream keeps it fed — token deltas, and even the keep-alive comment lines a
 * provider sends between server-side steps (Matilda: every 15 s) are bytes.
 * Silence past the budget cancels the reader and rejects with a
 * `StreamStalledError` that the retry layers already treat as a transient
 * server failure (status 504, message `stalled`), so the resilient call wrapper
 * reconnects instead of the turn hanging. Pure: no config reads here.
 */

export class StreamStalledError extends Error {
  readonly code = 'stalled';
  /** Gateway-timeout shape: retryable for the resilient wrapper and the router. */
  readonly status = 504;
  constructor(readonly stallMs: number, what: string) {
    super(`LLM stream stalled: no data from ${what} for ${(stallMs / 1000).toFixed(0)}s.`);
    this.name = 'StreamStalledError';
  }
}

interface ReadableLike<T> {
  read(): Promise<{ value?: T; done: boolean }>;
  cancel?(reason?: unknown): Promise<void> | void;
}

/**
 * One `reader.read()` bounded by `stallMs` of silence. `stallMs <= 0` disables
 * the watchdog (plain read). On a stall the reader is cancelled best-effort so
 * the underlying connection is released, then the error is thrown.
 */
export async function readWithStallWatchdog<T>(
  reader: ReadableLike<T>,
  stallMs: number,
  what: string,
): Promise<{ value?: T; done: boolean }> {
  if (!(stallMs > 0)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamStalledError(stallMs, what)), stallMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } catch (err) {
    if (err instanceof StreamStalledError) {
      try { await reader.cancel?.(err); } catch { /* already closed */ }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
