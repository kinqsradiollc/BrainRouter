import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerPort, createHostCore, isUnsavedNewSessionKey } from './hostCore.js';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
function fakeAgent(behavior) {
    return {
        sessionKey: 'sess-test',
        runTurn: behavior ?? (async (prompt, cb) => {
            cb.onStatusUpdate('working');
            cb.onAssistantDelta('hi');
            return `answer to: ${prompt}`;
        }),
    };
}
const collect = () => {
    const out = [];
    return { out, send: (m) => out.push(m) };
};
test('start-turn: streams bridged events between turn-start and turn-complete', async () => {
    const { out, send } = collect();
    const core = createHostCore({ agent: fakeAgent(), send });
    await core.handle({ kind: 'start-turn', prompt: 'do it' });
    const kinds = out.map((m) => m.event.kind);
    assert.deepEqual(kinds, ['turn-start', 'status', 'assistant-delta', 'turn-complete']);
    assert.deepEqual(out.map((m) => m.seq), [1, 2, 3, 4], 'monotonic envelope seq');
    const done = out[3].event;
    assert.equal(done.answer, 'answer to: do it');
    assert.ok(out.every((m) => m.sessionKey === 'sess-test'));
});
test('start-turn: forwards inline images to runTurn opts (vision)', async () => {
    const { send } = collect();
    let seenImages;
    const agent = {
        sessionKey: 'sess-img',
        runTurn: async (_p, _cb, opts) => { seenImages = opts?.images; return 'ok'; },
    };
    const core = createHostCore({ agent, send });
    await core.handle({ kind: 'start-turn', prompt: 'what is this?', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] });
    assert.deepEqual(seenImages, [{ mediaType: 'image/png', dataBase64: 'AAAA' }]);
});
test('observeTurnEvent: receives the turn tool stream tagged with the turn sessionKey (verification scoping)', async () => {
    const { send } = collect();
    const seen = [];
    const agent = {
        sessionKey: 'sess-A',
        runTurn: async (_p, cb) => {
            cb.onToolStart('run_command', { command: 'npm test' }, 'c1');
            cb.onToolEnd('run_command', { success: true, summary: '12 passed' }, 'c1');
            return 'done';
        },
    };
    const core = createHostCore({
        agent,
        send,
        observeTurnEvent: (sessionKey, event) => {
            if (event.kind === 'tool-start')
                seen.push({ sessionKey, kind: event.kind, tool: event.tool, command: event.args?.command, callId: event.callId });
            else if (event.kind === 'tool-end')
                seen.push({ sessionKey, kind: event.kind, tool: event.tool, callId: event.callId, ok: event.ok });
        },
    });
    await core.handle({ kind: 'start-turn', prompt: 'run the tests' });
    const start = seen.find((s) => s.kind === 'tool-start');
    const end = seen.find((s) => s.kind === 'tool-end');
    assert.ok(start, 'observer saw tool-start');
    assert.equal(start?.sessionKey, 'sess-A', 'tagged with the turn session key (survives a later switch)');
    assert.equal(start?.tool, 'run_command');
    assert.equal(start?.command, 'npm test');
    assert.equal(start?.callId, 'c1');
    assert.equal(end?.callId, 'c1');
    assert.equal(end?.ok, true);
});
test('start-turn: a throwing turn emits turn-error and unlocks the next turn', async () => {
    const { out, send } = collect();
    let calls = 0;
    const core = createHostCore({
        agent: fakeAgent(async () => { calls++; if (calls === 1)
            throw new Error('boom'); return 'ok'; }),
        send,
    });
    await core.handle({ kind: 'start-turn', prompt: 'a' });
    assert.equal(out[out.length - 1].event.kind, 'turn-error');
    await core.handle({ kind: 'start-turn', prompt: 'b' });
    assert.equal(out[out.length - 1].event.kind, 'turn-complete', 'turnRunning latch released after error');
});
test('start-turn while running → turn-error (no concurrent turns)', async () => {
    const { out, send } = collect();
    let release;
    const gate = new Promise((r) => { release = r; });
    const core = createHostCore({
        agent: fakeAgent(async () => { await gate; return 'done'; }),
        send,
    });
    const first = core.handle({ kind: 'start-turn', prompt: 'long' });
    await core.handle({ kind: 'start-turn', prompt: 'second' });
    assert.ok(out.some((m) => m.event.kind === 'turn-error' &&
        m.event.message.includes('already running')));
    release();
    await first;
});
test('DESK-5q resume during a running turn is deferred until the turn unwinds', async () => {
    const { out, send } = collect();
    let release;
    const gate = new Promise((r) => { release = r; });
    let interrupted = false;
    const agent = {
        sessionKey: 'sess:A',
        runTurn: async () => { await gate; return 'done-A'; },
        requestInterrupt: () => { interrupted = true; },
        resetSessionCounters: () => { },
        loadHistory: () => 7,
        getModel: () => 'm',
    };
    const core = createHostCore({ agent, send, loadTranscript: () => [{ role: 'user', content: 'hi' }] });
    const first = core.handle({ kind: 'start-turn', prompt: 'long A' });
    // switch to B while A is still running
    await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' });
    // The switch must NOT have applied yet: agent still on A, no session-changed,
    // interrupt requested, and a "stopping…" status surfaced.
    assert.equal(agent.sessionKey, 'sess:A', 'agent.sessionKey not swapped mid-turn');
    assert.ok(interrupted, 'running turn was interrupted');
    assert.ok(!out.some((m) => m.event.kind === 'session-changed'), 'no session-changed before the turn ends');
    assert.ok(out.some((m) => m.event.kind === 'status' && /Stopping the current turn/.test(m.event.text)));
    release();
    await first;
    // Now the deferred switch has applied.
    assert.equal(agent.sessionKey, 'sess:B', 'deferred switch applied after the turn ended');
    const sc = out.find((m) => m.event.kind === 'session-changed');
    assert.ok(sc && sc.event.sessionKey === 'sess:B');
});
test('DESK-5v concurrent sessions: a mid-turn switch spawns a second agent and never stops the first', async () => {
    const { out, send } = collect();
    let releaseA, releaseB;
    const gateA = new Promise((r) => { releaseA = r; });
    const gateB = new Promise((r) => { releaseB = r; });
    let interruptedA = false;
    const agentA = {
        sessionKey: 'sess:A',
        runTurn: async (_p, cb) => { cb.onAssistantDelta('A'); await gateA; return 'done-A'; },
        requestInterrupt: () => { interruptedA = true; },
        resetSessionCounters: () => { }, loadHistory: () => 3, getModel: () => 'm',
    };
    const agentB = {
        sessionKey: 'sess:spawn',
        runTurn: async (_p, cb) => { cb.onAssistantDelta('B'); await gateB; return 'done-B'; },
        resetSessionCounters: () => { }, loadHistory: () => 5, getModel: () => 'm', clearHistory: () => { },
    };
    const core = createHostCore({
        agent: agentA, send,
        spawnAgent: () => agentB, // a second session gets its own agent
        loadTranscript: (k) => (k === 'sess:B' ? [{ role: 'user', content: 'hi' }] : []),
    });
    const firstA = core.handle({ kind: 'start-turn', prompt: 'long A' }); // A running
    await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' }); // switch mid-turn
    assert.equal(interruptedA, false, 'switching sessions did NOT stop the running turn');
    assert.equal(agentA.sessionKey, 'sess:A', 'the running agent keeps its own session/history');
    assert.equal(agentB.sessionKey, 'sess:B', 'the spawned agent took the switched-to session');
    const scB = out.find((m) => m.event.kind === 'session-changed' && m.event.sessionKey === 'sess:B');
    assert.ok(scB, 'session-changed to B emitted immediately, while A is still running');
    // Start a turn in B — runs concurrently, no "already running" rejection.
    const firstB = core.handle({ kind: 'start-turn', prompt: 'long B' });
    assert.ok(!out.some((m) => m.event.kind === 'turn-error'), 'a concurrent turn in another session is allowed');
    releaseA();
    releaseB();
    await Promise.all([firstA, firstB]);
    const completes = out.filter((m) => m.event.kind === 'turn-complete');
    assert.deepEqual(completes.map((m) => m.sessionKey).sort(), ['sess:A', 'sess:B'], 'both sessions completed, each tagged with its own key');
    assert.ok(out.some((m) => m.sessionKey === 'sess:A' && m.event.kind === 'assistant-delta'), "A's stream stayed tagged A");
    assert.ok(out.some((m) => m.sessionKey === 'sess:B' && m.event.kind === 'assistant-delta'), "B's stream stayed tagged B");
});
test('session-changed carries the AUTHORITATIVE running flag so the renderer can clear a stale "working…"', async () => {
    const { out, send } = collect();
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const agentA = {
        sessionKey: 'sess:A',
        runTurn: async (_p, cb) => { cb.onAssistantDelta('A'); await gateA; return 'done-A'; },
        resetSessionCounters: () => { }, loadHistory: () => 1, getModel: () => 'm',
    };
    const agentB = {
        sessionKey: 'sess:spawn', runTurn: async () => 'done-B',
        resetSessionCounters: () => { }, loadHistory: () => 1, getModel: () => 'm', clearHistory: () => { },
    };
    const core = createHostCore({
        agent: agentA, send, spawnAgent: () => agentB,
        transcriptExists: (k) => k === 'sess:A' || k === 'sess:B',
    });
    const runningOf = (key) => {
        const scs = out.filter((m) => m.event.kind === 'session-changed' && m.event.sessionKey === key);
        return scs.length ? scs[scs.length - 1].event.running : undefined;
    };
    const turnA = core.handle({ kind: 'start-turn', prompt: 'long A' }); // A is now running
    await core.handle({ kind: 'resume-session', sessionKey: 'sess:B' }); // switch to B (idle)
    assert.equal(runningOf('sess:B'), false, 'switching to an idle session reports running:false');
    await core.handle({ kind: 'resume-session', sessionKey: 'sess:A' }); // back to A, still mid-turn
    assert.equal(runningOf('sess:A'), true, 'refocusing a still-running session reports running:true (authoritative)');
    releaseA();
    await turnA;
});
test('interaction-response resolves the broker; stale ids are ignored politely', async () => {
    const { out, send } = collect();
    const core = createHostCore({ agent: fakeAgent(), send });
    const { request, response } = core.broker.request({ type: 'confirm', title: 'Run it?' });
    await core.handle({ kind: 'interaction-response', id: request.id, response: { type: 'confirm', approved: true } });
    assert.deepEqual(await response, { type: 'confirm', approved: true });
    await core.handle({ kind: 'interaction-response', id: 'ir_999', response: { type: 'confirm', approved: true } });
    assert.ok(out.some((m) => m.event.kind === 'status' && m.event.text.includes('Stale')));
});
test('interrupt dismisses pending approvals (fail-closed unwind)', async () => {
    const { send } = collect();
    const core = createHostCore({ agent: fakeAgent(), send });
    const a = core.broker.request({ type: 'confirm', title: 'a' });
    await core.handle({ kind: 'interrupt' });
    assert.deepEqual(await a.response, { type: 'dismissed' });
    assert.equal(core.broker.pendingCount, 0);
});
test('query: routes to handlers; unknown names error; thrown handlers error', async () => {
    const { out, send } = collect();
    const core = createHostCore({
        agent: fakeAgent(),
        send,
        queries: {
            'list-sessions': () => [{ sessionKey: 's1' }],
            'explode': () => { throw new Error('nope'); },
        },
    });
    await core.handle({ kind: 'query', id: 'q1', name: 'list-sessions' });
    await core.handle({ kind: 'query', id: 'q2', name: 'missing' });
    await core.handle({ kind: 'query', id: 'q3', name: 'explode' });
    const results = out.filter((m) => m.event.kind === 'query-result');
    assert.deepEqual(results.map((r) => [r.event.id, r.event.ok]), [['q1', true], ['q2', false], ['q3', false]]);
    assert.deepEqual(results[0].event.result, [{ sessionKey: 's1' }]);
});
test('garbage on the wire is ignored; shutdown dismisses + calls onShutdown', async () => {
    const { out, send } = collect();
    let shut = false;
    const core = createHostCore({ agent: fakeAgent(), send, onShutdown: () => { shut = true; } });
    await core.handle('garbage');
    await core.handle({ kind: 'unknown-thing' });
    assert.equal(out.length, 0);
    const p = core.broker.request({ type: 'confirm', title: 'x' });
    await core.handle({ kind: 'shutdown' });
    assert.deepEqual(await p.response, { type: 'dismissed' });
    assert.equal(shut, true);
});
test('interrupt flags the agent for a cooperative stop', async () => {
    const { send } = collect();
    let flagged = false;
    const agent = { ...fakeAgent(), requestInterrupt: () => { flagged = true; } };
    const core = createHostCore({ agent, send });
    await core.handle({ kind: 'interrupt' });
    assert.equal(flagged, true);
});
test('new-session: fresh key + cleared history + session-changed event', async () => {
    const { out, send } = collect();
    let cleared = false;
    const agent = {
        ...fakeAgent(), sessionKey: 'root:old',
        clearHistory: () => { cleared = true; },
        resetSessionCounters: () => { },
        getModel: () => 'test-model',
    };
    const core = createHostCore({ agent, send });
    await core.handle({ kind: 'new-session', label: 'My Chat!' });
    assert.equal(cleared, true);
    assert.equal(agent.sessionKey, 'root:My-Chat-');
    const ev = out.find((m) => m.event.kind === 'session-changed').event;
    assert.equal(ev.loadedMessages, 0);
});
test('DESK-6t resume-session: switches + emits count, but LAZY-loads history on the first turn (not on resume)', async () => {
    const { out, send } = collect();
    let loadedWith = [];
    const agent = {
        ...fakeAgent(),
        resetSessionCounters: () => { },
        loadHistory: (entries) => { loadedWith = entries; return entries.length; },
        getModel: () => 'm',
    };
    const core = createHostCore({
        agent, send,
        loadTranscript: (key) => (key === 'sess-known' ? [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] : []),
    });
    await core.handle({ kind: 'resume-session', sessionKey: 'sess-known' });
    // Resume switches the session + emits a SENTINEL loadedMessages (1 = "has
    // history to render") — OOM-safe: it no longer full-reads the transcript just
    // to count; the renderer fetches the real rows via the bounded transcript query.
    assert.equal(agent.sessionKey, 'sess-known');
    const sc = out.find((m) => m.event.kind === 'session-changed').event;
    assert.equal(sc.loadedMessages, 1);
    // …but does NOT load the transcript into the agent yet (the expensive part is lazy).
    assert.equal(loadedWith.length, 0, 'history is NOT loaded on resume');
    // It loads on the FIRST turn (when the user actually sends a message).
    await core.handle({ kind: 'start-turn', prompt: 'continue' });
    assert.equal(loadedWith.length, 2, 'history loaded on the first turn');
    await core.handle({ kind: 'resume-session', sessionKey: 'missing' });
    assert.ok(out.some((m) => m.event.kind === 'turn-error' && m.event.message.includes('missing')));
});
test('new-session after lazy resume does not load the previous transcript on first turn', async () => {
    const { send } = collect();
    let transcriptLoads = 0;
    let historyLoads = 0;
    let cleared = 0;
    const agent = {
        ...fakeAgent(),
        sessionKey: 'root:old',
        clearHistory: () => { cleared++; },
        resetSessionCounters: () => { },
        loadHistory: (entries) => { historyLoads++; return entries.length; },
        getModel: () => 'm',
    };
    const core = createHostCore({
        agent,
        send,
        loadTranscript: (key) => {
            transcriptLoads++;
            return key === 'root:big-session' ? [{ role: 'user', content: 'large previous transcript' }] : [];
        },
    });
    await core.handle({ kind: 'resume-session', sessionKey: 'root:big-session' });
    assert.equal(transcriptLoads, 1, 'resume may check existence in the no-transcriptExists fallback');
    assert.equal(historyLoads, 0, 'lazy resume has not loaded the previous transcript into the agent');
    await core.handle({ kind: 'new-session', label: 'fresh' });
    assert.equal(cleared, 1, 'fresh chat cleared the reused agent history');
    await core.handle({ kind: 'start-turn', prompt: 'brand new prompt' });
    assert.equal(historyLoads, 0, 'fresh chat did not ingest the lazily-resumed transcript');
    assert.equal(agent.sessionKey, 'root:fresh');
});
test('set-model: switches + persists; persist failure degrades gracefully', async () => {
    const { out, send } = collect();
    let model = 'old';
    const agent = { ...fakeAgent(), setModel: (m) => { model = m; }, getModel: () => model };
    let persisted = '';
    const core = createHostCore({ agent, send, persistModel: (m) => { persisted = m; } });
    await core.handle({ kind: 'set-model', model: 'gpt-5.5', persist: true });
    assert.equal(model, 'gpt-5.5');
    assert.equal(persisted, 'gpt-5.5');
    assert.ok(out.some((m) => m.event.kind === 'status' && m.event.text.includes('shared with the CLI')));
    const failing = createHostCore({ agent, send, persistModel: () => { throw new Error('disk full'); } });
    await failing.handle({ kind: 'set-model', model: 'x', persist: true });
    assert.ok(out.some((m) => m.event.kind === 'status' && m.event.text.includes('persisting failed')));
});
test('createBrokerPort: confirm/choice round-trip + dismissal fails closed', async () => {
    const broker = new InteractionBroker();
    const emitted = [];
    const port = createBrokerPort(broker, (e) => emitted.push(e), 1_000);
    const confirmP = port.confirm({ title: 'Run?', dangerous: true, tool: 'run_command' });
    assert.equal(emitted[0].request.type, 'confirm');
    broker.resolve(emitted[0].request.id, { type: 'confirm', approved: true });
    assert.equal(await confirmP, true);
    const choiceP = port.choice({ question: 'Pick', header: 'P', options: [{ label: 'A', description: 'a' }] });
    broker.resolve(emitted[1].request.id, { type: 'choice', labels: ['A'] });
    assert.deepEqual(await choiceP, ['A']);
    const dismissedP = port.confirm({ title: 'ignored' });
    broker.resolve(emitted[2].request.id, { type: 'dismissed' });
    assert.equal(await dismissedP, false, 'dismissed confirm = deny');
});
test('turn-complete is followed by tokens-updated when the agent exposes usage', async () => {
    const { out, send } = collect();
    const agent = {
        ...fakeAgent(),
        sessionUsage: { promptTokens: 1200, completionTokens: 80, calls: 3, turns: 1 },
    };
    const core = createHostCore({ agent, send });
    await core.handle({ kind: 'start-turn', prompt: 'x' });
    const kinds = out.map((m) => m.event.kind);
    assert.deepEqual(kinds.slice(-2), ['turn-complete', 'tokens-updated']);
    const tok = out[out.length - 1].event;
    assert.equal(tok.promptTokens, 1200);
});
// Item 10 — per-session model (set-model scope + restore on spawn).
function modelAgent(key = 'sess-test') {
    return {
        sessionKey: key,
        _model: 'init-model',
        runTurn: async () => 'ok',
        resetSessionCounters() { },
        setModel(m) { this._model = m; },
        getModel() { return this._model; },
    };
}
test('set-model persist:false saves for THIS SESSION only (not global config)', async () => {
    const { out, send } = collect();
    const global = [];
    const session = [];
    const agent = modelAgent();
    const core = createHostCore({
        agent, send,
        persistModel: (m) => global.push(m),
        setSessionModel: (k, m) => session.push([k, m]),
    });
    await core.handle({ kind: 'set-model', model: 'gpt-5.5', persist: false });
    assert.deepEqual(session, [['sess-test', 'gpt-5.5']], 'wrote per-session override');
    assert.deepEqual(global, [], 'did NOT touch global config');
    assert.equal(agent.getModel?.(), 'gpt-5.5', 'applied in-memory immediately');
    const sc = out.find((m) => m.event.kind === 'session-changed');
    assert.equal(sc.event.model, 'gpt-5.5');
});
test('set-model persist:true saves the GLOBAL default (not per-session)', async () => {
    const { send } = collect();
    const global = [];
    const session = [];
    const cleared = [];
    const core = createHostCore({
        agent: modelAgent(), send,
        persistModel: (m) => global.push(m),
        setSessionModel: (k, m) => session.push([k, m]),
        clearSessionModel: (k) => cleared.push(k),
    });
    await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: true });
    assert.deepEqual(global, ['claude-opus-4-8'], 'wrote global config');
    assert.deepEqual(session, [], 'did NOT write a per-session override');
    assert.deepEqual(cleared, ['sess-test'], 'cleared stale per-session model override for the active chat');
});
test('set-model providerName + persist:false → cross-provider PER-SESSION (rebuild LLM, full session override, no global)', async () => {
    const { send } = collect();
    const global = [];
    const sessionLlms = [];
    const rebuilt = [];
    const agent = modelAgent('sess-test');
    agent.setLLMConfig = (c) => { rebuilt.push(c); };
    const core = createHostCore({
        agent, send,
        persistModel: (m) => global.push(m),
        persistProviderModel: (n, m) => global.push(`${n}:${m}`),
        setSessionModel: () => global.push('WRONG-session-model'),
        setSessionLlm: (k, patch) => sessionLlms.push([k, patch]),
        resolveProviderLlm: (_name, model) => ({ provider: 'anthropic', apiKey: 'sk-x', model, endpoint: 'https://api.anthropic.com' }),
    });
    await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: false, providerName: 'my-anthropic' });
    assert.equal(rebuilt[0]?.provider, 'anthropic', 'rebuilt the active agent with the provider config');
    assert.equal(rebuilt[0]?.apiKey, 'sk-x', 'incl. the resolved key (main-process only)');
    assert.deepEqual(sessionLlms, [['sess-test', { provider: 'anthropic', model: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com' }]], 'wrote the FULL session override (no secret)');
    assert.deepEqual(global, [], 'never touched the global default → no sync to other sessions');
});
test('set-model providerName + persist:true → cross-provider GLOBAL default (persistProviderModel + clears session)', async () => {
    const { send } = collect();
    const globalProv = [];
    const cleared = [];
    const agent = modelAgent('sess-test');
    agent.setLLMConfig = () => { };
    const core = createHostCore({
        agent, send,
        persistProviderModel: (n, m) => globalProv.push([n, m]),
        clearSessionModel: (k) => cleared.push(k),
        resolveProviderLlm: (_name, model) => ({ provider: 'anthropic', apiKey: 'sk-x', model, endpoint: 'e' }),
    });
    await core.handle({ kind: 'set-model', model: 'claude-opus-4-8', persist: true, providerName: 'my-anthropic' });
    assert.deepEqual(globalProv, [['my-anthropic', 'claude-opus-4-8']], 'set the GLOBAL default from the connection');
    assert.deepEqual(cleared, ['sess-test'], 'cleared the per-session override');
});
test('a spawned/focused session restores its stored per-session model', async () => {
    const { out, send } = collect();
    const agent = modelAgent('sess-test');
    const core = createHostCore({
        agent, send,
        spawnAgent: (k) => modelAgent(k),
        getSessionModel: (k) => (k === 'sess-test:feature' ? 'qwen3-coder' : undefined),
    });
    await core.handle({ kind: 'new-session', label: 'feature' });
    // The agent now serving sess-test:feature must carry that session's model.
    const sc = out.filter((m) => m.event.kind === 'session-changed').pop();
    assert.equal(sc.sessionKey, 'sess-test:feature');
    assert.equal(sc.event.model, 'qwen3-coder', 'restored per-session model on focus');
});
test('isUnsavedNewSessionKey marks only the new-* session segment', () => {
    assert.equal(isUnsavedNewSessionKey('abc123:new-k1z9'), true);
    assert.equal(isUnsavedNewSessionKey('new-k1z9'), true); // no workspace prefix
    assert.equal(isUnsavedNewSessionKey('abc123:saved-chat'), false);
    assert.equal(isUnsavedNewSessionKey('abc123:newish'), false); // must be the "new-" prefix
    assert.equal(isUnsavedNewSessionKey('abc123:design-note'), false);
});
test('Bug-fix: resuming an unsaved new-* key with no transcript self-heals (no "No transcript found")', async () => {
    const { out, send } = collect();
    const core = createHostCore({ agent: fakeAgent(), send, transcriptExists: () => false });
    await core.handle({ kind: 'resume-session', sessionKey: 'wshash:new-abc12' });
    const kinds = out.map((m) => m.event.kind);
    assert.ok(!kinds.includes('turn-error'), 'a brand-new chat must not hard-error on resume');
    const sc = out.find((m) => m.event.kind === 'session-changed');
    assert.ok(sc, 'self-heals to a fresh session');
    const ev = sc.event;
    assert.equal(ev.sessionKey, 'wshash:new-abc12');
    assert.equal(ev.loadedMessages, 0, 'fresh empty session');
});
test('Bug-fix: resuming a SAVED key with no transcript still emits a controlled error', async () => {
    const { out, send } = collect();
    const core = createHostCore({ agent: fakeAgent(), send, transcriptExists: () => false });
    await core.handle({ kind: 'resume-session', sessionKey: 'wshash:saved-feature' });
    const err = out.find((m) => m.event.kind === 'turn-error');
    assert.ok(err, 'a missing transcript for a real saved session is still an error');
    assert.match(err.event.message, /No transcript found/);
});
