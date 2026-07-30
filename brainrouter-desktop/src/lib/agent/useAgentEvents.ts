/**
 * useAgentEvents — the mount-once agent-event subscription extracted from App.tsx.
 *
 * Owns the `window.brainrouter.onEvent` subscription (live turn lifecycle, tool
 * cards, per-session/per-workspace routing) and the `handleQueryResult` router
 * that dispatches every `q-*`/`a-*` query result back onto App state. Everything
 * the bodies touch is App-local state and is injected via `AgentEventsCtx`.
 *
 * The two large handlers live in cohesive sibling modules under
 * `useAgentEvents/`: `onAgentEvent.ts` (the live-event switch) and
 * `handleQueryResult.ts` (the query-result router); shared types + leaf helpers
 * live in `useAgentEvents/types.ts`. This shell wires them together and keeps the
 * public surface (`ToolCatalog`, `AgentEventsCtx`, `getStableRowId`,
 * `useAgentEvents`) unchanged.
 *
 * Behavior is identical to the original in-component code: the effect runs ONCE
 * on mount (empty deps + the intentional eslint-disable), and handleQueryResult
 * is created once (via createHandleQueryResult) so the effect can call it.
 */
import { useEffect, useRef } from 'react';
import type { AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';
import { createHandleQueryResult } from './useAgentEvents/handleQueryResult.js';
import { createOnAgentEvent } from './useAgentEvents/onAgentEvent.js';
import type { AgentEventsCtx } from './useAgentEvents/types.js';

export { getStableRowId } from './useAgentEvents/types.js';
export type { ToolCatalog, AgentEventsCtx } from './useAgentEvents/types.js';

export function useAgentEvents(ctx: AgentEventsCtx): void {
  const { q, refreshSidebar } = ctx;

  // §live-render fix — true once THIS turn has streamed/flushed an assistant row,
  // so turn-complete only appends `answer` when nothing was shown live. A
  // non-streaming endpoint produces no deltas; without this its answer was
  // dropped from the live view and only appeared after a session reload.
  const streamedThisTurnRef = useRef(false);
  // Files the agent edited/wrote THIS turn (path → status), reset at turn-start.
  // At turn-end we ask the host for their numstat and render a Codex-style
  // "Edited N files +X −Y" changeset card in the transcript.
  const turnEditsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const handleQueryResult = createHandleQueryResult(ctx);
    const onAgentEvent = createOnAgentEvent({ ctx, streamedThisTurnRef, turnEditsRef, handleQueryResult });
    const off = window.brainrouter.onEvent((msg: AgentEventMessage) => onAgentEvent(msg));
    refreshSidebar();
    q('q-catalog', 'commands-catalog');
    q('q-snapshot', 'config-snapshot');
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
