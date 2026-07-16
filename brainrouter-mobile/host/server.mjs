/**
 * brainrouter-host (mobile) — the WebSocket server the mobile app's
 * RemoteTransport pairs with. It runs the SAME agent host as the desktop
 * (brainrouter-desktop/electron/host.ts `main()`), only swapping Electron IPC
 * for a WebSocket via the host's injectable transport seam. So every agent
 * command, event, and the ~140 query handlers are reused verbatim — no fork.
 *
 * One host per workspace (this process). The phone connects/reconnects; a bounded
 * ring buffer replays the events the client missed while offline (the `hello`
 * afterSeq → gap-free resume, WF-7).
 *
 * `startHostServer({ port, main })` is exported with `main` injectable, so the wire
 * layer — handshake, framing, query↔result correlation, and the replay ring — is
 * exercised end-to-end against the real RemoteTransport in
 * `host/wire.integration.test.mjs`, a scripted stub standing in for the Node-only
 * desktop runtime. When run directly this file boots the real desktop `main`.
 *
 * Run on the machine with the workspace (needs `ws` + the built desktop/core dist).
 * Point it at a LOCAL model with the BRAINROUTER_LLM_* env — no config file needed:
 *   cd brainrouter-mobile/host && npm install
 *   BRAINROUTER_DESKTOP_WORKSPACE=/abs/path/to/repo \
 *   BRAINROUTER_LLM_ENDPOINT=http://localhost:9000/v1 \
 *   BRAINROUTER_LLM_MODEL=Qwen3.5-9B-Q4_K_M.gguf \
 *   node server.mjs
 * (Or, with a real ~/.config/brainrouter/config.json on this machine, just `npm start`.)
 *
 * Then pair the app to  ws://<this-machine-LAN-ip>:3747 .
 */
import { WebSocketServer } from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RING_CAP = 2000;

// Interfaces that are NOT reachable from the network — safe to serve an
// unauthenticated host on (local dev / adb-forwarded). Anything else exposes
// the agent host (which can run shell commands) to the LAN, so it requires a token.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** True if `host` is a loopback bind address. */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host));
}

/**
 * Constant-time device-token comparison (CWE-306). Both sides must be non-empty
 * and equal; a length mismatch short-circuits (timingSafeEqual throws on
 * unequal-length buffers). `expected === ''` means "no token configured" and is
 * handled by the caller (auth disabled), so it never matches here.
 */
export function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (expected.length === 0 || provided.length === 0) return false;
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/**
 * Start the host WS server, bridging the currently-paired WebSocket to the agent
 * host `main(transport)`. Resolves once the socket is listening.
 *
 * @param {object}   opts
 * @param {number}   [opts.port=0]          TCP port (0 = OS-assigned, for tests).
 * @param {string}   [opts.host]            Bind address. Default 127.0.0.1 (loopback) —
 *                                          set BRAINROUTER_HOST_BIND=0.0.0.0 for LAN pairing.
 * @param {string}   [opts.token]           Pre-shared device token. Default $BRAINROUTER_HOST_TOKEN.
 *                                          When set, every client must present it in `hello`.
 * @param {Function} opts.main              Agent host entrypoint `(transport) => Promise<void>`.
 * @param {number}   [opts.ringCap=2000]    Replay-ring capacity (events).
 * @param {boolean}  [opts.exitOnFatal=true] process.exit(1) if `main` rejects (off in tests).
 * @returns {Promise<{ wss: import('ws').WebSocketServer, host: string, port: number, close: () => Promise<void> }>}
 */
export async function startHostServer({
  port = 0,
  host = process.env.BRAINROUTER_HOST_BIND || '127.0.0.1',
  token = process.env.BRAINROUTER_HOST_TOKEN || '',
  main,
  ringCap = RING_CAP,
  exitOnFatal = true,
} = {}) {
  if (typeof main !== 'function') {
    throw new Error('startHostServer requires `main` (the agent host entrypoint)');
  }

  // The agent host can run shell commands, so an UNAUTHENTICATED server must
  // never be reachable off-box. Refuse to bind a non-loopback interface unless a
  // device token is configured (CWE-306). Loopback (local dev / adb-forward) is fine.
  const authRequired = token.length > 0;
  if (!authRequired && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind brainrouter-host to non-loopback ${host} without a device token. ` +
        `Set BRAINROUTER_HOST_TOKEN for LAN pairing, or bind to 127.0.0.1 (BRAINROUTER_HOST_BIND).`,
    );
  }

  let socket = null;
  const handlers = new Set();
  const ring = []; // [{ seq, frame }] — bounded replay buffer (WF-7)

  const transport = {
    keepAlive: true, // a server transport must NOT process.exit on agent shutdown
    send: (msg) => {
      if (msg && typeof msg.seq === 'number') {
        ring.push({ seq: msg.seq, frame: JSON.stringify(msg) });
        if (ring.length > ringCap) ring.shift();
      }
      if (socket && socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(msg));
    },
    onMessage: (handler) => handlers.add(handler),
  };

  const wss = new WebSocketServer({ port, host });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (ws) => {
    socket = ws;
    // A socket must present a valid `hello` token before ANY command is handled.
    // When no token is configured (loopback dev) the connection is trusted from
    // the start, preserving the zero-config local flow.
    let authed = !authRequired;
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return; // tolerate noise on the wire (matches core.handle's guard)
      }
      if (msg && msg.kind === 'hello') {
        if (authRequired && !tokenMatches(token, msg.token)) {
          try { ws.close(4001, 'unauthorized'); } catch { /* already closing */ }
          return; // CWE-306 — reject an unpaired/forged device
        }
        authed = true;
        const after = typeof msg.afterSeq === 'number' ? msg.afterSeq : 0;
        for (const { seq, frame } of ring) if (seq > after) ws.send(frame); // gap-free replay
        return;
      }
      if (!authed) return; // drop any command received before a valid hello
      // Isolate each handler: malformed input that makes one throw must not take
      // down the socket (or the process) — it would be a trivial DoS (CWE-248).
      for (const h of handlers) {
        try { h(msg); } catch (err) { console.error('[brainrouter-host] handler error:', err); }
      }
    });
    ws.on('close', () => {
      if (socket === ws) socket = null;
    });
    ws.on('error', () => {
      if (socket === ws) socket = null;
    });
  });

  // Boot the agent host once (called synchronously so a stub registers its inbound
  // handler before the server returns; the real desktop main then keeps the process
  // alive via its own handles — watchers, mcp client, …).
  try {
    const booted = main(transport);
    if (booted && typeof booted.catch === 'function') {
      booted.catch((err) => {
        console.error('[brainrouter-host] fatal:', err);
        if (exitOnFatal) process.exit(1);
      });
    }
  } catch (err) {
    console.error('[brainrouter-host] fatal:', err);
    if (exitOnFatal) process.exit(1);
  }

  return {
    wss,
    host,
    port: wss.address().port,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

/**
 * Build an LLMConfig from env so the host can target a LOCAL OpenAI-compatible
 * model (llama.cpp / LM Studio / Ollama) without editing ~/.config/brainrouter.
 * Returns null when not set (→ fall back to the user's real config). `endpoint`
 * is the OpenAI base URL ending in /v1 (the agent POSTs to {endpoint}/chat/completions).
 */
export function llmFromEnv(env = process.env) {
  const endpoint = env.BRAINROUTER_LLM_ENDPOINT;
  const model = env.BRAINROUTER_LLM_MODEL;
  if (!endpoint || !model) return null;
  return {
    provider: env.BRAINROUTER_LLM_PROVIDER || 'lmstudio',
    model,
    endpoint,
    apiKey: env.BRAINROUTER_LLM_API_KEY || 'sk-local',
  };
}

// ── Run directly: boot the real desktop agent host over a WS on $BRAINROUTER_HOST_PORT.
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  // Optional local-model override: write a minimal config into a host-local home
  // and redirect HOME/USERPROFILE there, so loadConfig() finds the model WITHOUT
  // touching the user's real ~/.config/brainrouter/config.json.
  const llm = llmFromEnv();
  if (llm) {
    const home = path.join(path.dirname(fileURLToPath(import.meta.url)), '.host-home');
    fs.mkdirSync(path.join(home, '.config', 'brainrouter'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'brainrouter', 'config.json'),
      JSON.stringify({ activeServer: '', servers: {}, llm }, null, 2),
    );
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    // Log only the model — the endpoint URL can carry an internal host/IP (CWE-532).
    console.log(`[brainrouter-host] LLM override → ${llm.model}`);
  }
  process.env.BRAINROUTER_HOST_EMBEDDED = '1'; // tell host.ts not to self-boot on import
  const { main } = await import('../../brainrouter-desktop/dist-electron/host.js');
  const { host, port } = await startHostServer({
    port: Number(process.env.BRAINROUTER_HOST_PORT ?? 3747),
    main,
  });
  const auth = process.env.BRAINROUTER_HOST_TOKEN ? 'device token required' : 'no token (loopback only)';
  console.log(`[brainrouter-host] listening on ws://${host}:${port} — ${auth}`);
}
