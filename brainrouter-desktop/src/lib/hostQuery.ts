/**
 * Promise-wrapped host query over the existing `send` / `onEvent` bridge — for
 * self-contained panels that fetch host state without threading it through App.
 * It sends a `{ kind:'query', id, name, args }` command and resolves on the
 * matching `query-result` event. Host events are workspace-wrapped while the
 * browser development bridge emits bare events, so this compatibility wrapper
 * delegates event parsing and cleanup to the shared query transport. It keeps
 * the legacy nullable result used by existing panels.
 */
import { bridgeQuery } from './bridgeQuery.js';

export function hostQuery<T = unknown>(
  name: string,
  args?: Record<string, unknown>,
  expectedWorkspaceRoot?: string,
): Promise<T | null> {
  return bridgeQuery<T>(name, args ?? {}, 8_000, expectedWorkspaceRoot).catch(() => null);
}
