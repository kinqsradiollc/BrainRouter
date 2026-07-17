// Live agent-turn test against a LOCAL model — drives the REAL host + REAL
// RemoteTransport exactly like the mobile Session screen (useActiveSession):
// resume-session → start-turn → fold the event stream through the app's own
// `reduceTranscript`. Proves the full wired loop end-to-end on real hardware.
//
//   Model: Qwen3.5-9B-Q4_K_M.gguf via llama.cpp's OpenAI API on :9000
//   Run:   npx tsx host/qwen-turn.mjs ["your prompt"]
//
// Safety: auto-DENIES any approval request so no mutating tool runs in this repo.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');
const testHome = path.join(here, '.test-home');
fs.mkdirSync(path.join(testHome, '.config', 'brainrouter'), { recursive: true });
fs.writeFileSync(
  path.join(testHome, '.config', 'brainrouter', 'config.json'),
  JSON.stringify(
    {
      activeServer: '',
      servers: {},
      llm: {
        provider: 'lmstudio', // local OpenAI-compatible server (llama.cpp), empty-key OK
        model: 'Qwen3.5-9B-Q4_K_M.gguf',
        endpoint: 'http://localhost:9000/v1', // → POST /v1/chat/completions
        apiKey: 'sk-local',
      },
    },
    null,
    2,
  ),
);
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.BRAINROUTER_HOST_EMBEDDED = '1';
process.env.BRAINROUTER_DESKTOP_WORKSPACE = workspaceRoot;

const { WebSocket } = await import('ws');
const { startHostServer } = await import('./server.mjs');
const { RemoteTransport } = await import('../src/transport/RemoteTransport.ts');
const { reduceTranscript, emptyTranscript } = await import('../src/domain/session/transcript.ts');
const { main } = await import('../../brainrouter-desktop/dist-electron/host.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = process.argv[2] || 'In one short sentence, what is the capital of France? Answer directly without using any tools.';
const SESSION = 'qwen-test';

const srv = await startHostServer({ port: 0, main, exitOnFatal: false });
const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WebSocket });

// connect, then wait for the async host boot to wire its inbound handler
{
  const start = Date.now();
  while (t.status() !== 'connected') { if (Date.now() - start > 5000) throw new Error('connect timeout'); await sleep(20); }
  const rs = Date.now();
  for (;;) {
    try { await Promise.race([t.query('config-snapshot'), new Promise((_, r) => setTimeout(() => r(new Error('to')), 1500))]); break; }
    catch { if (Date.now() - rs > 25000) throw new Error('host not ready'); await sleep(300); }
  }
}

const snap = await t.query('config-snapshot');
console.log(`host ready · model="${snap.model}" provider="${snap.provider}" endpoint=${snap.endpoint}`);
console.log(`PROMPT: ${PROMPT}`);
console.log('----- streaming assistant reply -----');

let state = emptyTranscript();
let shown = '';
let done = false;
let fatal = null;
const kinds = [];
const errDetails = [];

t.onEvent((m) => {
  const e = m.event;
  if (!e) return;
  kinds.push(e.kind);
  // Safety backstop: refuse any approval so a mutating tool can't run here.
  if (e.kind === 'interaction-request' && e.request?.id) {
    t.send({ kind: 'interaction-response', id: e.request.id, response: { type: 'confirm', approved: false } });
  }
  if (e.kind === 'error') fatal = e.message || e.error || JSON.stringify(e);
  if (e.kind === 'turn-error' || e.kind === 'error') errDetails.push(JSON.stringify(e).slice(0, 300));
  state = reduceTranscript(state, m);
  // stream the assembled assistant text (the app's reducer output) incrementally
  const asst = state.items.filter((r) => r.kind === 'assistant').map((r) => r.text).join('');
  if (asst.length > shown.length) { process.stdout.write(asst.slice(shown.length)); shown = asst; }
  if (e.kind === 'turn-complete' || e.kind === 'turn-end') done = true;
});

t.send({ kind: 'resume-session', sessionKey: SESSION });
t.send({ kind: 'start-turn', prompt: PROMPT });

const start = Date.now();
while (!done && !fatal && Date.now() - start < 180000) await sleep(100);
const secs = Math.round((Date.now() - start) / 100) / 10;

console.log('\n----- result -----');
console.log(`completed=${done} fatal=${fatal ? JSON.stringify(fatal).slice(0, 300) : 'none'} elapsed=${secs}s`);
console.log(`event kinds: ${[...new Set(kinds.filter(Boolean))].join(', ')}`);
const reasoningFinal = state.items.filter((r) => r.kind === 'reasoning').map((r) => r.text).join('\n');
if (reasoningFinal) console.log(`REASONING (separate row, ${reasoningFinal.length} chars): ${reasoningFinal.slice(0, 300)}`);
const asstFinal = state.items.filter((r) => r.kind === 'assistant').map((r) => r.text).join('').trim();
const clean = !asstFinal.includes('<think>') && !asstFinal.includes('</think>');
console.log(`ASSISTANT (${asstFinal.length} chars, think-tags=${clean ? 'STRIPPED ✓' : 'PRESENT ✗'}): ${asstFinal.slice(0, 600) || '(no assistant text)'}`);
for (const r of state.items.filter((r) => r.kind === 'tool')) console.log(`TOOL: ${r.tool} [${r.status}] ${r.summary ?? ''}`);
for (const r of state.items.filter((r) => r.kind === 'notice')) console.log(`NOTICE[${r.level}]: ${r.text.slice(0, 200)}`);
if (state.tokens) console.log(`tokens: prompt=${state.tokens.promptTokens} completion=${state.tokens.completionTokens} calls=${state.tokens.calls}`);
for (const d of errDetails) console.log(`ERR-EVENT: ${d}`);

t.dispose();
await srv.close();
process.exit(fatal && !done ? 1 : 0);
