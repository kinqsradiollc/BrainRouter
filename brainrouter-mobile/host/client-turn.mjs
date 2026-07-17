// Manual e2e client: connect to an ALREADY-RUNNING brainrouter-host and run one
// turn EXACTLY the way the app's "New chat" does — mint a key with newSessionKey,
// resume-session it, start-turn, and fold the stream through the app's
// reduceTranscript. Proves the whole wire against a live host + model.
//   node host/client-turn.mjs [port] [prompt]
import { WebSocket } from 'ws';
import { RemoteTransport } from '../src/transport/RemoteTransport.ts';
import { reduceTranscript, emptyTranscript } from '../src/domain/session/transcript.ts';
import { newSessionKey } from '../src/domain/session/newSessionKey.ts';

const port = process.argv[2] || '3747';
const prompt = process.argv[3] || 'In one short sentence, what is the capital of France?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout:' + l)), ms))]);

const t = new RemoteTransport({ url: `ws://127.0.0.1:${port}`, WebSocketImpl: WebSocket });
const sessionKey = newSessionKey();

// wait to connect (RemoteTransport auto-retries), then for the host to be ready
{
  const s = Date.now();
  while (t.status() !== 'connected') { if (Date.now() - s > 15000) throw new Error('connect timeout'); await sleep(50); }
  const rs = Date.now();
  for (;;) {
    try { await withTimeout(t.query('config-snapshot'), 1500, 'ready'); break; }
    catch { if (Date.now() - rs > 25000) throw new Error('host not ready'); await sleep(300); }
  }
}

let state = emptyTranscript();
let done = false;
let shown = '';
t.onEvent((m) => {
  state = reduceTranscript(state, m);
  const a = state.items.filter((r) => r.kind === 'assistant').map((r) => r.text).join('');
  if (a.length > shown.length) { process.stdout.write(a.slice(shown.length)); shown = a; }
  if (m.event?.kind === 'turn-complete' || m.event?.kind === 'turn-end') done = true;
});

console.log(`new chat key: ${sessionKey}`);
console.log(`PROMPT: ${prompt}`);
console.log('----- reply (clean, <think> routed away) -----');
t.send({ kind: 'resume-session', sessionKey });
t.send({ kind: 'start-turn', prompt });

const start = Date.now();
while (!done && Date.now() - start < 180000) await sleep(100);
const asst = state.items.filter((r) => r.kind === 'assistant').map((r) => r.text).join('').trim();
const reasoning = state.items.filter((r) => r.kind === 'reasoning').map((r) => r.text).join('');
console.log(`\n----- done (${Math.round((Date.now() - start) / 1000)}s, completed=${done}) -----`);
console.log(`reasoning row: ${reasoning ? reasoning.slice(0, 100) + '…' : '(none)'}`);
console.log(`ASSISTANT bubble: ${asst || '(none)'}`);
t.dispose();
process.exit(done ? 0 : 1);
