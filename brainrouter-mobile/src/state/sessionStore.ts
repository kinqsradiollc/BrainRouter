/**
 * Session store — the live transcript for the session currently on screen.
 * A Zustand store holds the reduced TranscriptState; `ingest()` folds each
 * inbound event through the pure `reduceTranscript` reducer (domain/session),
 * routing by sessionKey so background sessions don't bleed in. The transport
 * subscription + command-sending live in the `useActiveSession` hook so the
 * Mock and Remote transports stay interchangeable (technical-doc §5/§6).
 *
 * M1 scope: one active session at a time (the Session screen). A global,
 * multi-session event store for Activity/notifications follows in epic 5.
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import type { AgentEventMessage, InteractionResponse } from '../transport/protocol';
import { emptyTranscript, reduceTranscript, type TranscriptState } from '../domain/session/transcript';
import { useTransport } from './TransportProvider';

interface SessionStore extends TranscriptState {
  activeSessionKey: string | null;
  /** Bind the store to a session and clear the prior transcript. */
  open: (sessionKey: string) => void;
  /** Fold one inbound event into the transcript (ignores other sessions). */
  ingest: (msg: AgentEventMessage) => void;
  /** Drop a resolved approval/choice once the user has answered it. */
  clearPending: (id: string) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...emptyTranscript(),
  activeSessionKey: null,
  open: (sessionKey) => set({ ...emptyTranscript(), activeSessionKey: sessionKey }),
  ingest: (msg) => {
    const active = get().activeSessionKey;
    if (active && msg.sessionKey && msg.sessionKey !== active) return;
    set((prev) => reduceTranscript(prev, msg));
  },
  clearPending: (id) => {
    if (get().pendingInteraction?.id === id) set({ pendingInteraction: null });
  },
}));

export interface SessionActions {
  startTurn: (prompt: string) => void;
  interrupt: () => void;
  respond: (id: string, response: InteractionResponse) => void;
}

/**
 * Bind the session store to `sessionKey`: reset on entry, subscribe the
 * transport's event stream into `ingest`, resume the session on the host, and
 * return the command actions the Session screen drives. Read transcript state
 * via `useSessionStore` selectors.
 */
export function useActiveSession(sessionKey: string): SessionActions {
  const transport = useTransport();
  const open = useSessionStore((s) => s.open);
  const ingest = useSessionStore((s) => s.ingest);
  const clearPending = useSessionStore((s) => s.clearPending);

  useEffect(() => {
    open(sessionKey);
    const unsub = transport.onEvent(ingest);
    transport.send({ kind: 'resume-session', sessionKey });
    return unsub;
  }, [transport, sessionKey, open, ingest]);

  const startTurn = useCallback((prompt: string) => transport.send({ kind: 'start-turn', prompt }), [transport]);
  const interrupt = useCallback(() => transport.send({ kind: 'interrupt' }), [transport]);
  const respond = useCallback(
    (id: string, response: InteractionResponse) => {
      transport.send({ kind: 'interaction-response', id, response });
      clearPending(id);
    },
    [transport, clearPending],
  );

  return { startTurn, interrupt, respond };
}
