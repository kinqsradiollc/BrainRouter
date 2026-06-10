/**
 * DESK-1 — agent-host core: the pure command router between the protocol and
 * the agent runtime. `host.ts` is a thin bootstrap that builds the REAL agent
 * (same loadConfig / McpClientPool / Agent as the CLI — that's the
 * settings-reuse contract) and hands it here; tests hand in a fake. No
 * Electron imports in this file, so the whole router is unit-testable.
 */
import { createCallbackBridge, createEnvelopeWriter, InteractionBroker, isAgentCommand, } from '@kinqs/brainrouter-agent-protocol';
export function createHostCore(input) {
    const emit = createEnvelopeWriter(input.agent.sessionKey, input.send);
    const broker = new InteractionBroker();
    let turnRunning = false;
    // Bridge: every RunTurnCallbacks callback becomes a protocol event. The
    // bridge object is reused across turns (the envelope writer owns seq).
    const callbacks = createCallbackBridge(emit);
    async function startTurn(prompt) {
        if (turnRunning) {
            emit({ kind: 'turn-error', message: 'A turn is already running — interrupt it first or queue the prompt.' });
            return;
        }
        turnRunning = true;
        emit({ kind: 'turn-start', prompt });
        try {
            const answer = await input.agent.runTurn(prompt, callbacks);
            emit({ kind: 'turn-complete', answer });
        }
        catch (err) {
            emit({ kind: 'turn-error', message: err instanceof Error ? err.message : String(err) });
        }
        finally {
            turnRunning = false;
        }
    }
    async function handle(message) {
        if (!isAgentCommand(message))
            return; // tolerate noise on the wire
        const cmd = message;
        switch (cmd.kind) {
            case 'start-turn':
                await startTurn(cmd.prompt);
                return;
            case 'interrupt': {
                // v1: dismiss pending approvals so a blocked turn fails closed and
                // unwinds. Hard mid-LLM abort lands with DESK-2's AbortSignal work.
                const dismissed = broker.dismissAll();
                emit({ kind: 'status', text: `Interrupt requested${dismissed ? ` — dismissed ${dismissed} pending approval(s)` : ''}.` });
                return;
            }
            case 'interaction-response': {
                const ok = broker.resolve(cmd.id, cmd.response);
                if (!ok)
                    emit({ kind: 'status', text: `Stale interaction response ignored (${cmd.id}).` });
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
                }
                catch (err) {
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
