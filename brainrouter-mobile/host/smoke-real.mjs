// One-shot smoke: boot the REAL desktop agent host headless, talk to it with the
// REAL RemoteTransport over a real WebSocket, and run real queries against THIS
// repo (no stub, no mock). Proves the live API path before the full test suite.
//   Run:  npx tsx host/smoke-real.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../brainrouter-mobile/host
const workspaceRoot = path.resolve(here, '..', '..'); // the git worktree root (real repo)

// loadConfig() hard-exits if ~/.config/brainrouter/config.json is absent. Redirect
// HOME/USERPROFILE to a throwaway test home with a minimal config so we never touch
// the user's real home. servers:{} ⇒ no MCP connect ⇒ fast boot; llm falls back to
// the empty-key default (queries need no LLM). MUST be set before host.js imports config.ts.
const testHome = path.join(here, '.test-home');
const cfgDir = path.join(testHome, '.config', 'brainrouter');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ activeServer: '', servers: {} }, null, 2));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;

process.env.BRAINROUTER_HOST_EMBEDDED = '1'; // don't let host.js self-boot on import
process.env.BRAINROUTER_DESKTOP_WORKSPACE = workspaceRoot;
console.log('os.homedir() ->', os.homedir());

const { WebSocket } = await import('ws');
const { startHostServer } = await import('./server.mjs');
const { RemoteTransport } = await import('../src/transport/RemoteTransport.ts');
const { main } = await import('../../brainrouter-desktop/dist-electron/host.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms))]);

console.log('workspace:', workspaceRoot);
const srv = await startHostServer({ port: 0, main, exitOnFatal: false });
console.log('host listening on port', srv.port);
const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WebSocket });

async function waitConnected() {
  const start = Date.now();
  while (t.status() !== 'connected') {
    if (Date.now() - start > 5000) throw new Error('connect timeout');
    await sleep(20);
  }
}

// The real main() registers its inbound handler only after async boot (config +
// MCP). Retry a cheap query until one resolves → the host is ready to serve.
async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < 25000) {
    try {
      await withTimeout(t.query('list-models'), 1500, 'ready-probe');
      return Math.round((Date.now() - start) / 100) / 10;
    } catch {
      await sleep(400);
    }
  }
  throw new Error('host never became ready');
}

try {
  await waitConnected();
  console.log('CONNECTED');
  const readyS = await waitReady();
  console.log(`READY after ~${readyS}s`);

  const probes = [
    ['list-models', {}],
    ['changed-files', {}],
    ['worktrees', {}],
    ['list-files', {}],
    ['config-snapshot', {}],
    ['workspace-recents', {}],
  ];
  for (const [name, args] of probes) {
    try {
      const r = await withTimeout(t.query(name, args), 8000, name);
      console.log(`OK   ${name} -> ${JSON.stringify(r).slice(0, 180)}`);
    } catch (e) {
      console.log(`ERR  ${name} -> ${e.message}`);
    }
  }
} catch (e) {
  console.log('SMOKE FAILED:', e.message);
} finally {
  t.dispose();
  await srv.close();
  process.exit(0);
}
