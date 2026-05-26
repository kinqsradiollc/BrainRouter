import readline from 'node:readline';

/**
 * Restore stdin to a state where readline (or any other consumer) can
 * own it, AFTER an Ink app has unmounted.
 *
 * Why this is necessary:
 *   Ink's `App.js` calls `stdin.unref()` during its `disableRawMode`
 *   cleanup (node_modules/ink/build/components/App.js:137). `unref()`
 *   removes the stdin handle from the event-loop refcount. Once Ink
 *   hands stdin back, NOTHING in the event loop keeps Node alive —
 *   readline's 'readable' listener does NOT auto-ref the stream.
 *   Node sees zero refs, fires `beforeExit`, and exits cleanly with
 *   no `close` event.
 *
 *   Symptom: the post-wizard REPL printed its banner ("Type /help…")
 *   and then the process exited to bash. No `Goodbye!` from
 *   readline's close handler — readline never got a chance to run.
 *
 * Fix order (matters):
 *   1. `process.stdin.ref()` — counter Ink's unref so the event loop
 *      doesn't drain.
 *   2. `process.stdin.resume()` — re-enable flowing/readable events.
 *      Ink may have paused via `stdin.read()` draining.
 *   3. `setRawMode(true)` on TTY — readline expects raw mode for
 *      keypress events. Ink restored it to false on unmount.
 *   4. `readline.emitKeypressEvents(process.stdin)` — re-arm the
 *      keypress decoder. Ink's `clearInputState` removed the
 *      'readable' listener (App.js:126); we want our handler back.
 *
 * Call this on the next `setImmediate` after `instance.unmount()` /
 * `waitUntilExit()` resolves — Ink writes its final unmount barrier
 * on the next tick (Ink.js:549-554).
 */
export function resetStdinForReadline(): void {
  const stdin = process.stdin;
  try { (stdin as any).ref?.(); } catch { /* node version w/o ref */ }
  try { stdin.resume(); } catch { /* already resumed */ }
  if (stdin.isTTY) {
    try { (stdin as any).setRawMode?.(true); } catch { /* not a real TTY */ }
  }
  try { readline.emitKeypressEvents(stdin); } catch { /* already wired */ }
}

/**
 * Snapshot every listener attached to a stdin event so we can remove
 * them while Ink owns stdin and re-attach them on Ink unmount.
 *
 * Without this, readline's keypress + 'data' listeners stay subscribed
 * while Ink is mounted — both consumers fight for the same bytes,
 * arrow keys go missing, the picker doesn't see Enter, etc. (See
 * `cli-prompt.test.ts` notes on why we use `rl.pause()` AND remove
 * stdin listeners during ask_user_choice.)
 *
 * Usage:
 *   const snap = snapshotStdinListeners(['keypress', 'data']);
 *   try { await runInk(...); } finally { snap.restore(); resetStdinForReadline(); }
 */
export interface StdinListenerSnapshot {
  restore(): void;
}

export function snapshotStdinListeners(events: readonly string[] = ['keypress', 'data']): StdinListenerSnapshot {
  const stdin: any = process.stdin;
  const captured: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  for (const event of events) {
    const listeners = (stdin.listeners?.(event) ?? []) as Array<(...args: any[]) => void>;
    for (const listener of listeners) {
      captured.push({ event, listener });
      try { stdin.removeListener(event, listener); } catch { /* ignore */ }
    }
  }
  return {
    restore() {
      for (const { event, listener } of captured) {
        try { stdin.on(event, listener); } catch { /* ignore */ }
      }
    },
  };
}
