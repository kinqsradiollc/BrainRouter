/**
 * DESK-1 — agent-host core: the pure command router between the protocol and
 * the agent runtime. `host.ts` is a thin bootstrap that builds the REAL agent
 * (same loadConfig / McpClientPool / Agent as the CLI — that's the
 * settings-reuse contract) and hands it here; tests hand in a fake. No
 * Electron imports in this file, so the whole router is unit-testable.
 */
import {
  createCallbackBridge,
  createEnvelopeWriter,
  InteractionBroker,
  isAgentCommand,
  type AgentCommand,
  type AgentEventMessage,
  type InteractionResponse,
} from '@kinqs/brainrouter-agent-protocol';

/**
 * The slice of the CLI Agent the host needs — structural, so tests can fake
 * it. `callbacks` is deliberately `any`: the real Agent declares the stricter
 * `RunTurnCallbacks`, and a structural supertype here would be contravariant-
 * incompatible with it.
 */
export interface AgentLike {
  sessionKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runTurn(prompt: string, callbacks: any): Promise<string>;
  /** DESK-2 — cooperative stop; the turn unwinds at the next boundary. */
  requestInterrupt?(): void;
}

/** Named read-only queries the renderer can issue (sessions list, recap, …). */
export type QueryHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface HostCore {
  /** Feed one decoded wire message in; invalid shapes are ignored (logged via status). */
  handle(message: unknown): Promise<void>;
  /** Pending interaction count (exposed for tests + drain-on-shutdown). */
  readonly broker: InteractionBroker;
}

export function createHostCore(input: {
  agent: AgentLike;
  send: (msg: AgentEventMessage) => void;
  queries?: Record<string, QueryHandler>;
  /** Called on `shutdown` after pending interactions are dismissed. */
  onShutdown?: () => void;
}): HostCore {
  const emit = createEnvelopeWriter(input.agent.sessionKey, input.send);
  const broker = new InteractionBroker();
  let turnRunning = false;

  // Bridge: every RunTurnCallbacks callback becomes a protocol event. The
  // bridge object is reused across turns (the envelope writer owns seq).
  const callbacks = createCallbackBridge(emit) as unknown as Record<string, unknown>;

  async function startTurn(prompt: string): Promise<void> {
    if (turnRunning) {
      emit({ kind: 'turn-error', message: 'A turn is already running — interrupt it first or queue the prompt.' });
      return;
    }
    turnRunning = true;
    emit({ kind: 'turn-start', prompt });
    try {
      const answer = await input.agent.runTurn(prompt, callbacks);
      emit({ kind: 'turn-complete', answer });
    } catch (err) {
      emit({ kind: 'turn-error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      turnRunning = false;
    }
  }

  async function handle(message: unknown): Promise<void> {
    if (!isAgentCommand(message)) return; // tolerate noise on the wire
    const cmd = message as AgentCommand;
    switch (cmd.kind) {
      case 'start-turn':
        await startTurn(cmd.prompt);
        return;
      case 'interrupt': {
        // DESK-2 — cooperative stop: flag the agent (it unwinds at the next
        // LLM/tool boundary) AND dismiss pending approvals so a turn blocked
        // on a dialog fails closed instead of hanging.
        input.agent.requestInterrupt?.();
        const dismissed = broker.dismissAll();
        emit({ kind: 'status', text: `Interrupt requested${dismissed ? ` — dismissed ${dismissed} pending approval(s)` : ''}.` });
        return;
      }
      case 'interaction-response': {
        const ok = broker.resolve(cmd.id, cmd.response as InteractionResponse);
        if (!ok) emit({ kind: 'status', text: `Stale interaction response ignored (${cmd.id}).` });
        return;
      }
      case 'query': {
        const handler = input.queries?.[cmd.name];
        if (!handler) {
          emit({ kind: 'query-result', id: cmd.id, ok: false, error: `Unknown query "${cmd.name}".` });
          return;
        }
        try {
          const result = await handler(cmd.args ?? {});
          emit({ kind: 'query-result', id: cmd.id, ok: true, result });
        } catch (err) {
          emit({ kind: 'query-result', id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'shutdown':
        broker.dismissAll();
        input.onShutdown?.();
        return;
    }
  }

  return { handle, broker };
}
