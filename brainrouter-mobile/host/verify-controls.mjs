// Verify the composer-controls surface against the REAL host: config-snapshot
// carries model + prefs{executionMode,reviewPolicy,effort}, and the
// action:set-session-mode query actually changes them.  npx tsx host/verify-controls.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');
const testHome = path.join(here, '.test-home');
fs.mkdirSync(path.join(testHome, '.config', 'brainrouter'), { recursive: true });
fs.writeFileSync(path.join(testHome, '.config', 'brainrouter', 'config.json'), JSON.stringify({ activeServer: '', servers: {} }));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.BRAINROUTER_HOST_EMBEDDED = '1';
process.env.BRAINROUTER_DESKTOP_WORKSPACE = workspaceRoot;

const { WebSocket } = await import('ws');
const { startHostServer } = await import('./server.mjs');
const { RemoteTransport } = await import('../src/transport/RemoteTransport.ts');
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
  console.log('config-snapshot.model:', snap.model);
  console.log('config-snapshot.prefs:', JSON.stringify(snap.prefs));
  const p = snap.prefs || {};
  console.log('prefs has executionMode/reviewPolicy/effort:', 'executionMode' in p && 'reviewPolicy' in p && 'effort' in p);

  console.log('--- set mode=planning/request, effort=high ---');
  const set = await t.query('action:set-session-mode', { executionMode: 'planning', reviewPolicy: 'request', effort: 'high' });
  console.log('action:set-session-mode →', JSON.stringify(set));
  const snap2 = await t.query('config-snapshot');
  console.log('after set → prefs:', JSON.stringify(snap2.prefs));

  const lm = await t.query('list-models');
  console.log('list-models:', JSON.stringify(lm).slice(0, 160));
} catch (e) {
  console.log('FAILED:', e.message);
} finally {
  t.dispose();
  await srv.close();
  process.exit(0);
}
