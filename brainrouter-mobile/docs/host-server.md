# brainrouter-host (mobile) — build spec

The `RemoteTransport` client is built + unit-tested; this is the matching server,
specced so it can be built quickly **with the Node runtime in front of you** (it
cannot be verified blind — it drives the real agent + git + filesystem).

## Wire protocol (RemoteTransport ⇄ host)

All frames are JSON over one WebSocket.

- **Client → host:** `AgentCommand` (`start-turn`, `interrupt`, `interaction-response`,
  `query`, `new-session`, `resume-session`, `set-model`, `shutdown`) — fed straight to
  `core.handle(msg)`. Plus one control frame: `{ kind: 'hello', token?, afterSeq }` on
  every (re)connect.
- **Host → client:** `AgentEventMessage` = `{ seq, ts, sessionKey, event }`. `query()`
  results come back as `{ kind: 'query-result', id, ok, result|error }` events (already
  emitted by `createHostCore`). The Layer-1 methods (`workspaceRecents`, …) arrive as
  queries named `workspace-recents`, `workspace-sessions`, `global-dashboard`, … (see
  RemoteTransport) — add these handlers to the host's `queries` map.

## Step 1 — make `host.ts` transport-injectable (additive, desktop-safe)

Four edits in `brainrouter-desktop/electron/host.ts`. All default to today's behavior,
so the desktop is unchanged when no transport is passed:

```ts
export interface HostTransport {
  send: (msg: unknown) => void;
  onMessage: (handler: (msg: unknown) => void) => void;
  keepAlive?: boolean; // a server transport must NOT process.exit on shutdown
}

// L437:  async function main(): Promise<void> {
export async function main(transport?: HostTransport): Promise<void> {

// L479-481 (send):
const send = transport ? transport.send
  : port ? (msg: unknown) => port.postMessage(msg)
  : (msg: unknown) => console.log(JSON.stringify(msg));

// L2787 (onShutdown):
onShutdown: () => { stopWorkspaceWatcher(); void mcpClient.close?.(); if (!transport?.keepAlive) process.exit(0); },

// L2790 (inbound):
if (transport) transport.onMessage((m) => { void core.handle(m); });
else if (port) port.on('message', (e) => { void core.handle(e.data); });
```

For the bottom auto-run, **guard on an env var** (avoids the brittle Windows
`argv`/`import.meta.url` path comparison): wrap `main().catch(...)` in
`if (!process.env.BRAINROUTER_HOST_EMBEDDED) { main().catch(...) }`. The WS adapter sets
`BRAINROUTER_HOST_EMBEDDED=1` before importing, so importing never double-boots.

## Step 2 — the WS adapter (`brainrouter-mobile/host/server.mjs`, run on the dev box)

```js
process.env.BRAINROUTER_HOST_EMBEDDED = '1';
import { WebSocketServer } from 'ws';
import { main } from '../../brainrouter-desktop/dist-electron/host.js';

const wss = new WebSocketServer({ port: Number(process.env.BRAINROUTER_HOST_PORT ?? 3747) });
let ws = null;
const handlers = new Set();
const RING = []; // [{seq, frame}] — bounded event buffer for replay (WF-7)

main({
  keepAlive: true,
  send: (msg) => {
    if (typeof msg?.seq === 'number') { RING.push({ seq: msg.seq, frame: JSON.stringify(msg) }); if (RING.length > 2000) RING.shift(); }
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  },
  onMessage: (handler) => handlers.add(handler),
});

wss.on('connection', (sock) => {
  ws = sock;
  sock.on('message', (data) => {
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m?.kind === 'hello') {                       // auth (token) + replay
      for (const { seq, frame } of RING) if (seq > (m.afterSeq ?? 0)) sock.send(frame);
      return;
    }
    for (const h of handlers) h(m);
  });
  sock.on('close', () => { if (ws === sock) ws = null; });
});
```

Run: `BRAINROUTER_DESKTOP_WORKSPACE=/path/to/repo node host/server.mjs` (needs `ws` +
the built `brainrouter-core`/`brainrouter-desktop` dist).

## Step 3 — close the query gap (verified against host.ts's `queries` map)

Most app queries **already match** the host and work out of the box: `list-sessions`,
`workspace-sessions`, `changed-files`, `plan-state`, `plan-history`, `list-models`,
`context-usage`, `config-snapshot`, `commands-catalog`, `fleet`, `tasks-list`,
`track-items`, `review-current`, and — after the app-side rename done this session —
`requirement-list`, `annotation-list`, `artifact-list`, `schedule-list`, `list-files`,
`read-file`.

**Added to the host's `queries` map this session** (single-workspace returns — this host
serves one workspace — so no uncertain core signatures): `workspace-recents`,
`open-workspace`, `is-workspace-trusted`, `trust-workspace`, `untrust-workspace`,
`trusted-workspaces`, `mark-activity`, `reorder-workspace`, `global-dashboard`
(empty `tasks` for now), and **`worktrees`** (live, via the local `git` helper). So there
are **no more "Unknown query" errors** — every app query resolves.

**All three now implemented** (grounded in the host's own code — not stubs):
- **`search`** → `searchTranscript(readTranscriptTail(…), q, {limit:50})` → `[{ sessionKey, title, snippet }]`.
- **`ci-checks`** → `gh pr checks --json name,state,bucket,link,workflow,startedAt,completedAt` (already `CheckRow[]`).
- **`term-run`** → one-shot `exec(cmd, { cwd: workspaceRoot })` → `{ output }` (combined stdout+stderr).

So **every app query resolves with a real handler** — no "Unknown query", no placeholders. The only
remaining work is purely runtime: build the desktop dist, start the host, pair, and watch the loop.

## Step 4 — verify end-to-end
Pair the app to `ws://<dev-ip>:3747`, then walk UF-03 (send → stream → approve), UF-06
(commit gate), and a reconnect (kill/restart the adapter → events replay from the ring).
Fix on real output. This is the only step that *can't* be done without the runtime.
