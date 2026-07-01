/**
 * Promise-style one-shot host query for self-contained components (Settings
 * dialogs, pickers) that need request/response data WITHOUT threading state
 * through App/useAgentEvents. Subscribes its own bridge listener, sends a
 * uniquely-tagged query, resolves on the matching `query-result`, then
 * unsubscribes. Unrelated ids pass through untouched, and useAgentEvents
 * ignores ids it doesn't own — the two listeners coexist.
 */
let bridgeQuerySeq = 0;

interface QueryResultEvent {
  kind?: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

export function bridgeQuery<T>(name: string, args?: Record<string, unknown>, timeoutMs = 25_000): Promise<T> {
  const id = `bq-${++bridgeQuerySeq}-${name}`;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      fn();
    };
    const off = window.brainrouter.onEvent((msg: unknown) => {
      // Events arrive workspace-wrapped ({workspaceRoot, event}) from the host
      // and bare from the dev bridge — accept both shapes.
      const e = ((msg as { event?: QueryResultEvent }).event ?? msg) as QueryResultEvent;
      if (e?.kind !== 'query-result' || e.id !== id) return;
      finish(() => (e.ok ? resolve(e.result as T) : reject(new Error(e.error || `${name} failed`))));
    });
    const timer = setTimeout(() => finish(() => reject(new Error(`${name} timed out`))), timeoutMs);
    window.brainrouter.send({ kind: 'query', id, name, args } as never);
  });
}
