import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpawnAgentTool } from '../orchestration/tools.js';
import { createSession, updateSession, listSessions } from '../orchestration/orchestrator.js';

test('spawn_agent schema exposes overlay (string) + effort (low|medium|high|xhigh)', () => {
  const props = (createSpawnAgentTool().inputSchema as any).properties;
  assert.equal(props.overlay?.type, 'string');
  assert.equal(props.effort?.type, 'string');
  assert.deepEqual(props.effort?.enum, ['low', 'medium', 'high', 'xhigh']);
  // overlay description mentions the cap so the model knows the bound.
  assert.match(String(props.overlay?.description ?? ''), /4000/);
});

test('ChildSessionRecord round-trips the synthetic flag (overlay-spawned child)', () => {
  const prevHome = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-overlay-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-overlay-ws-'));
  process.env.BRAINROUTER_HOME = home;
  try {
    const rec = createSession(ws, { role: 'worker', prompt: 'bespoke task', access: 'write', parentSessionKey: 'p' });
    assert.notEqual(listSessions(ws).find((s) => s.id === rec.id)!.synthetic, true);
    updateSession(ws, rec.id, { synthetic: true });
    assert.equal(listSessions(ws).find((s) => s.id === rec.id)!.synthetic, true);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
