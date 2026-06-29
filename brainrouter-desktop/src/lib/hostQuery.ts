/**
 * Promise-wrapped host query over the existing `send` / `onEvent` bridge — for
 * self-contained panels that fetch host state without threading it through App.
 * It sends a `{ kind:'query', id, name, args }` command and resolves on the
 * matching `query-result` event (results arrive wrapped in an envelope, so we
 * read `msg.event`). Resolves null on no bridge / timeout / a non-ok result.
 */
export function hostQuery<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    const br = (window as unknown as {
      brainrouter?: { send?: (c: unknown) => void; onEvent?: (l: (m: unknown) => void) => () => void };
    }).brainrouter;
    if (!br?.send || !br?.onEvent) { resolve(null); return; }
    const id = `hq_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let settled = false;
    const off = br.onEvent((msg: unknown) => {
      const ev = (msg as { event?: { kind?: string; id?: string; ok?: boolean; result?: unknown } })?.event;
      if (ev?.kind === 'query-result' && ev.id === id) {
        settled = true;
        off();
        resolve(ev.ok ? (ev.result as T) : null);
      }
    });
    br.send({ kind: 'query', id, name, args: args ?? {} });
    setTimeout(() => { if (!settled) { off(); resolve(null); } }, 8000);
  });
}
