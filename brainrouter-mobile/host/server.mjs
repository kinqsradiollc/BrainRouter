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
 * Run on the machine with the workspace (needs `ws` + the built desktop/core dist):
 *   cd brainrouter-mobile/host && npm install
 *   BRAINROUTER_DESKTOP_WORKSPACE=/abs/path/to/repo BRAINROUTER_HOST_PORT=3747 npm start
 *
 * Then pair the app to  ws://<this-machine-LAN-ip>:3747 .
 */
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const RING_CAP = 2000;

/**
 * Start the host WS server, bridging the currently-paired WebSocket to the agent
 * host `main(transport)`. Resolves once the socket is listening.
 *
 * @param {object}   opts
 * @param {number}   [opts.port=0]          TCP port (0 = OS-assigned, for tests).
 * @param {Function} opts.main              Agent host entrypoint `(transport) => Promise<void>`.
 * @param {number}   [opts.ringCap=2000]    Replay-ring capacity (events).
 * @param {boolean}  [opts.exitOnFatal=true] process.exit(1) if `main` rejects (off in tests).
 * @returns {Promise<{ wss: import('ws').WebSocketServer, port: number, close: () => Promise<void> }>}
 */
export async function startHostServer({ port = 0, main, ringCap = RING_CAP, exitOnFatal = true } = {}) {
  if (typeof main !== 'function') {
    throw new Error('startHostServer requires `main` (the agent host entrypoint)');
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

  const wss = new WebSocketServer({ port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return; // tolerate noise on the wire (matches core.handle's guard)
      }
      if (msg && msg.kind === 'hello') {
        // TODO: validate msg.token against a paired device token.
        const after = typeof msg.afterSeq === 'number' ? msg.afterSeq : 0;
        for (const { seq, frame } of ring) if (seq > after) ws.send(frame); // gap-free replay
        return;
      }
      for (const h of handlers) h(msg);
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
    port: wss.address().port,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

// ── Run directly: boot the real desktop agent host over a WS on $BRAINROUTER_HOST_PORT.
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  process.env.BRAINROUTER_HOST_EMBEDDED = '1'; // tell host.ts not to self-boot on import
  const { main } = await import('../../brainrouter-desktop/dist-electron/host.js');
  const { port } = await startHostServer({
    port: Number(process.env.BRAINROUTER_HOST_PORT ?? 3747),
    main,
  });
  console.log(`[brainrouter-host] listening on ws://0.0.0.0:${port}`);
}
