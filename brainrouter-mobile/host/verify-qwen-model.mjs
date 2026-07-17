// Proves the model-picker fix end-to-end against the REAL Qwen host: the active
// model is Qwen, modelOptions() surfaces it in the picker, and a chat turn works.
//   npx tsx host/verify-qwen-model.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');
const testHome = path.join(here, '.test-home');
fs.mkdirSync(path.join(testHome, '.config', 'brainrouter'), { recursive: true });
fs.writeFileSync(
  path.join(testHome, '.config', 'brainrouter', 'config.json'),
  JSON.stringify({ activeServer: '', servers: {}, llm: { provider: 'lmstudio', model: 'Qwen3.5-9B-Q4_K_M.gguf', endpoint: 'http://localhost:9000/v1', apiKey: 'sk-local' } }, null, 2),
);
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.BRAINROUTER_HOST_EMBEDDED = '1';
process.env.BRAINROUTER_DESKTOP_WORKSPACE = workspaceRoot;

const { WebSocket } = await import('ws');
const { startHostServer } = await import('./server.mjs');
const { RemoteTransport } = await import('../src/transport/RemoteTransport.ts');
const { modelOptions, normalizeModels } = await import('../src/domain/session/sessionControls.ts');
const { reduceTranscript, emptyTranscript } = await import('../src/domain/session/transcript.ts');
const { newSessionKey } = await import('../src/domain/session/newSessionKey.ts');
const { main } = await import('../../brainrouter-desktop/dist-electron/host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout:' + l)), ms))]);

const srv = await startHostServer({ port: 0, main, exitOnFatal: false });
const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WebSocket });
{
  const s = Date.now();
  while (t.status() !== 'connected') { if (Date.now() - s > 5000) throw new Error('connect'); await sleep(20); }
  const rs = Date.now();
  for (;;) { try { await withTimeout(t.query('list-models'), 1500, 'ready'); break; } catch { if (Date.now() - rs > 25000) throw new Error('not ready'); await sleep(300); } }
}

try {
  const snap = await t.query('config-snapshot');
  const lm = await t.query('list-models');
  console.log('config-snapshot.model :', snap.model);
  console.log('list-models          :', JSON.stringify(lm));
  const opts = modelOptions(normalizeModels(lm.models ?? []), snap.model); // exactly what the app does
  console.log('MODEL PICKER shows   :', JSON.stringify(opts));
  console.log('Qwen visible in picker:', opts.some((m) => /qwen/i.test(m.id)));

  let state = emptyTranscript();
  let done = false;
  t.onEvent((m) => { state = reduceTranscript(state, m); if (m.event?.kind === 'turn-complete' || m.event?.kind === 'turn-end') done = true; });
  t.send({ kind: 'resume-session', sessionKey: newSessionKey() });
  t.send({ kind: 'start-turn', prompt: 'In one short sentence, what is the capital of France?' });
  const start = Date.now();
  while (!done && Date.now() - start < 120000) await sleep(100);
  const asst = state.items.filter((r) => r.kind === 'assistant').map((r) => r.text).join('').trim();
  console.log(`CHAT reply (${Math.round((Date.now() - start) / 1000)}s, ok=${done}): ${asst || '(no reply — is the model on :9000?)'}`);
} catch (e) {
  console.log('FAILED:', e.message);
} finally {
  t.dispose();
  await srv.close();
  process.exit(0);
}
