/**
 * REAL API integration test — boots the actual desktop agent host headless
 * (brainrouter-desktop/electron/host.ts `main()`, no Electron, no stub) and drives
 * it with the REAL RemoteTransport over a real loopback WebSocket, asserting that
 * EVERY query the mobile screens make resolves with real, correctly-shaped data
 * from THIS repo. This is the "no mock" contract: each assertion encodes exactly
 * the fields the consuming screen reads, so a drift between the app and the real
 * host fails here instead of silently on-device.
 *
 *   Run:  npm run test:api   (tsx --test --test-force-exit host/api.integration.test.mjs)
 *
 * Boot recipe (see docs): redirect HOME/USERPROFILE to a throwaway test-home with a
 * minimal `{ activeServer:'', servers:{} }` config (loadConfig hard-exits otherwise),
 * set BRAINROUTER_HOST_EMBEDDED so host.js doesn't self-boot, point the workspace at
 * this repo, then retry a cheap query until the async boot has wired its handler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..'); // the git worktree root (real repo)
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
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms))]);

const srv = await startHostServer({ port: 0, main, exitOnFatal: false });
const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WebSocket });

// Wait for connect, then for the async boot to register its inbound handler.
{
  const start = Date.now();
  while (t.status() !== 'connected') {
    if (Date.now() - start > 5000) throw new Error('connect timeout');
    await sleep(20);
  }
  const readyStart = Date.now();
  for (;;) {
    try { await withTimeout(t.query('list-models'), 1500, 'ready'); break; }
    catch { if (Date.now() - readyStart > 25000) throw new Error('host never ready'); await sleep(300); }
  }
}

const q = (name, args) => withTimeout(t.query(name, args), 10000, name);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

test.after(async () => { t.dispose(); await srv.close(); });

// ── data queries: each asserts the exact fields its screen consumes ──

test('list-models → { models[], current } (SettingsScreen)', async () => {
  const r = await q('list-models');
  assert.ok(isObj(r), 'object');
  assert.ok(Array.isArray(r.models), 'models is array');
  assert.equal(typeof r.current, 'string', 'current is string');
});

test('changed-files → array of { status, path } (ChangesScreen)', async () => {
  const r = await q('changed-files');
  assert.ok(Array.isArray(r), 'bare array (NOT { files })');
  assert.ok(r.length > 0, 'this worktree has uncommitted changes');
  for (const f of r.slice(0, 5)) {
    assert.equal(typeof f.status, 'string', 'item.status');
    assert.equal(typeof f.path, 'string', 'item.path');
  }
});

test('git-info → { files, insertions, deletions, branch } (ChangesScreen aggregate)', async () => {
  const r = await q('git-info');
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.insertions, 'number', 'insertions');
  assert.equal(typeof r.deletions, 'number', 'deletions');
  assert.equal(typeof r.files, 'number', 'files');
});

test('context-usage → { used, window, pct } (SessionScreen ring)', async () => {
  const r = await q('context-usage');
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.used, 'number', 'used');
  assert.equal(typeof r.pct, 'number', 'pct (used by the ring directly)');
  assert.equal(typeof r.window, 'number', 'window');
});

test('worktrees → { porcelain, current } (WorktreesScreen parses porcelain)', async () => {
  const r = await q('worktrees');
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.porcelain, 'string', 'porcelain');
  assert.ok(r.porcelain.includes('worktree '), 'real `git worktree list --porcelain` output');
});

test('list-files → { files: string[] } non-empty (FilesScreen)', async () => {
  const r = await q('list-files');
  assert.ok(isObj(r) && Array.isArray(r.files), '{ files: [] }');
  assert.ok(r.files.length > 0, 'real repo files');
  assert.equal(typeof r.files[0], 'string', 'string paths');
});

test('read-file → { content } with real file bytes (FileViewer/Editor)', async () => {
  const r = await q('read-file', { path: 'CLAUDE.md' });
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.content, 'string', 'content');
  assert.ok(r.content.includes('BrainRouter'), 'real CLAUDE.md content');
});

test('review-current → { run, gate } (Review/Changes; run may be null)', async () => {
  const r = await q('review-current');
  assert.ok(isObj(r), 'object');
  assert.ok('run' in r, 'has run (null when no review has run — screen guards with ?.)');
  assert.ok('gate' in r, 'has gate');
  if (r.gate) {
    assert.equal(typeof r.gate.status, 'string', 'gate.status');
    assert.equal(typeof r.gate.blocked, 'boolean', 'gate.blocked');
  }
});

test('config-snapshot → { model, workspaceRoot } (Settings/About)', async () => {
  const r = await q('config-snapshot');
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.model, 'string', 'model');
  assert.equal(typeof r.workspaceRoot, 'string', 'workspaceRoot');
});

test('term-run → { output } from the real shell (TerminalScreen)', async () => {
  const r = await q('term-run', { cmd: 'echo brainrouter-api-test' });
  assert.ok(isObj(r), 'object');
  assert.equal(typeof r.output, 'string', 'output');
  assert.ok(r.output.includes('brainrouter-api-test'), 'real echo output');
});

// ── list queries that are empty in this repo: assert they resolve as the right
//    container shape (the screens render empty states; item fields are shared
//    @kinqs/brainrouter-types and verified against the host handlers). ──

for (const name of ['list-sessions', 'plan-history', 'requirement-list', 'annotation-list', 'artifact-list', 'schedule-list', 'ci-checks', 'track-items', 'fleet', 'tasks-list']) {
  test(`${name} → array`, async () => {
    const r = await q(name);
    assert.ok(Array.isArray(r), `${name} is an array`);
  });
}

test('search → array of hits (SearchScreen)', async () => {
  const r = await q('search', { q: 'host' });
  assert.ok(Array.isArray(r), 'array');
  for (const h of r.slice(0, 3)) assert.equal(typeof h.snippet, 'string', 'hit.snippet');
});

test('plan-state → { items[] } (PlanScreen)', async () => {
  const r = await q('plan-state');
  assert.ok(isObj(r) && Array.isArray(r.items), '{ items: [] }');
});

test('commands-catalog → { categories[] } (command palette)', async () => {
  const r = await q('commands-catalog');
  assert.ok(isObj(r), 'object');
  assert.ok(Array.isArray(r.categories), 'categories array');
});

// ── Layer-1 promise methods (RemoteTransport) over the same channel ──

test('workspaceRecents() → { current, recents[] } (ChatsScreen)', async () => {
  const r = await withTimeout(t.workspaceRecents(), 10000, 'workspaceRecents');
  assert.ok(isObj(r), 'object');
  assert.ok('current' in r, 'current');
  assert.ok(Array.isArray(r.recents), 'recents array');
});

test('globalDashboard() → { workspaces[] } (ActivityScreen)', async () => {
  const r = await withTimeout(t.globalDashboard(), 10000, 'globalDashboard');
  assert.ok(isObj(r) && Array.isArray(r.workspaces), '{ workspaces: [] }');
  if (r.workspaces[0]) {
    assert.equal(typeof r.workspaces[0].workspaceRoot, 'string', 'w.workspaceRoot');
    assert.ok(Array.isArray(r.workspaces[0].tasks), 'w.tasks array');
  }
});

test('isWorkspaceTrusted() + trustedWorkspaces() + markActivity() (ConnectScreen)', async () => {
  const trusted = await withTimeout(t.isWorkspaceTrusted(workspaceRoot), 10000, 'isWorkspaceTrusted');
  assert.equal(typeof trusted.trusted, 'boolean', 'isWorkspaceTrusted.trusted');
  const all = await withTimeout(t.trustedWorkspaces(), 10000, 'trustedWorkspaces');
  assert.ok(Array.isArray(all.trusted), 'trustedWorkspaces.trusted array');
  const act = await withTimeout(t.markActivity(workspaceRoot, 'integration-test'), 10000, 'markActivity');
  assert.equal(act.ok, true, 'markActivity.ok');
});

// ── agent command channel is live end-to-end (turn lifecycle) ──

test('start-turn drives the real core: a turn lifecycle event comes back', async () => {
  const kinds = [];
  const off = t.onEvent((m) => kinds.push(m.event?.kind));
  try {
    t.send({ kind: 'start-turn', prompt: 'ping', sessionKey: 'integration' });
    const start = Date.now();
    // The core emits a turn-lifecycle/notice/error event even without an LLM key
    // configured — we only assert the command channel is wired, not a completion.
    while (Date.now() - start < 8000) {
      if (kinds.some((k) => k && (k.includes('turn') || k === 'error' || k === 'notice' || k === 'assistant-delta'))) break;
      await sleep(50);
    }
    assert.ok(
      kinds.some((k) => k && (k.includes('turn') || k === 'error' || k === 'notice' || k === 'assistant-delta')),
      `host responded to start-turn (got: ${kinds.filter(Boolean).join(',') || 'nothing'})`,
    );
  } finally {
    off();
  }
});
