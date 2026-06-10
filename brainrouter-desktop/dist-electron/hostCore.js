/**
 * DESK-1 — agent-host core: the pure command router between the protocol and
 * the agent runtime. `host.ts` is a thin bootstrap that builds the REAL agent
 * (same loadConfig / McpClientPool / Agent as the CLI — that's the
 * settings-reuse contract) and hands it here; tests hand in a fake. No
 * Electron imports in this file, so the whole router is unit-testable.
 */
import { createCallbackBridge, createEnvelopeWriter, InteractionBroker, isAgentCommand, } from '@kinqs/brainrouter-agent-protocol';
/**
 * DESK-3 — InteractionPort backed by the broker: agent approval/choice asks
 * become `interaction-request` events; the renderer answers with an
 * `interaction-response` command. 5-minute timeout → dismissed → the agent's
 * fail-closed paths (deny / decide-yourself) fire instead of hanging.
 */
export function createBrokerPort(broker, emit, timeoutMs = 300_000) {
    return {
        async confirm(req) {
            const { request, response } = broker.request({ type: 'confirm', ...req }, { timeoutMs });
            emit({ kind: 'interaction-request', request });
            const r = await response;
            return r.type === 'confirm' ? r.approved : false;
        },
        async choice(req) {
            const { request, response } = broker.request({ type: 'choice', ...req }, { timeoutMs });
            emit({ kind: 'interaction-request', request });
            const r = await response;
            return r.type === 'choice' ? r.labels : null;
        },
    };
}
export function createHostCore(input) {
    const emit = createEnvelopeWriter(input.agent.sessionKey, input.send);
    const broker = input.broker ?? new InteractionBroker();
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
                // DESK-2 — cooperative stop: flag the agent (it unwinds at the next
                // LLM/tool boundary) AND dismiss pending approvals so a turn blocked
                // on a dialog fails closed instead of hanging.
                input.agent.requestInterrupt?.();
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
            case 'new-session': {
                const label = (cmd.label ?? `new-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9._-]+/g, '-');
                input.agent.sessionKey = `${input.agent.sessionKey.split(':')[0]}:${label}`;
                input.agent.resetSessionCounters?.();
                input.agent.clearHistory?.();
                emit({ kind: 'session-changed', sessionKey: input.agent.sessionKey, loadedMessages: 0, model: input.agent.getModel?.() ?? '' });
                return;
            }
            case 'resume-session': {
                const entries = input.loadTranscript?.(cmd.sessionKey) ?? [];
                if (entries.length === 0) {
                    emit({ kind: 'turn-error', message: `No transcript found for "${cmd.sessionKey}".` });
                    return;
                }
                input.agent.sessionKey = cmd.sessionKey;
                input.agent.resetSessionCounters?.();
                const loaded = input.agent.loadHistory?.(entries) ?? 0;
                emit({ kind: 'session-changed', sessionKey: cmd.sessionKey, loadedMessages: loaded, model: input.agent.getModel?.() ?? '' });
                return;
            }
            case 'set-model': {
                input.agent.setModel?.(cmd.model);
                if (cmd.persist) {
                    try {
                        input.persistModel?.(cmd.model);
                    }
                    catch (err) {
                        emit({ kind: 'status', text: `Model switched for this session, but persisting failed: ${err instanceof Error ? err.message : err}` });
                        emit({ kind: 'session-changed', sessionKey: input.agent.sessionKey, loadedMessages: -1, model: cmd.model });
                        return;
                    }
                }
                emit({ kind: 'status', text: `Model set to ${cmd.model}${cmd.persist ? ' (saved to config.json — shared with the CLI)' : ''}.` });
                emit({ kind: 'session-changed', sessionKey: input.agent.sessionKey, loadedMessages: -1, model: cmd.model });
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
