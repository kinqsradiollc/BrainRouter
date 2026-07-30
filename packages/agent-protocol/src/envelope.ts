/**
 * Stateful event-envelope writer.
 *
 * Sequence stamping is kept separate from callback projection so transports
 * can reuse either concern independently.
 */

import type { AgentEventMessage } from './events.js';
import type { EmitEvent } from './callbackBridge.js';

/** Stamp seq + ts + sessionKey onto raw events. One writer per session stream. */
export function createEnvelopeWriter(
  sessionKey: string,
  send: (msg: AgentEventMessage) => void,
  now: () => number = () => Date.now(),
): EmitEvent {
  let seq = 0;
  return (event) => send({ seq: ++seq, ts: now(), sessionKey, event });
}
