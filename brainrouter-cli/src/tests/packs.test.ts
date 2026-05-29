import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePacks, discoverPacks, listPacks, packAgentIds, type PackInfo } from '../orchestration/packs.js';
import { isPackEnabled, readPackState, enablePack, disablePack } from '../state/packStore.js';

function pack(name: string, source: PackInfo['source'], version = '1.0.0'): PackInfo {
  return { name, description: '', version, source, dir: `/x/${source}/${name}`, agentsDir: `/x/${source}/${name}/agents` };
}

test('MAS-P5-T4 resolvePacks: workspace > user > built-in by name', () => {
  const resolved = resolvePacks([
    pack('a', 'builtin', '1'),
    pack('a', 'workspace', '2'),
    pack('a', 'user', '3'),
    pack('b', 'builtin'),
  ]);
  const a = resolved.find((p) => p.name === 'a')!;
  assert.equal(a.source, 'workspace'); // highest tier wins
  assert.equal(a.version, '2');
  assert.equal(resolved.length, 2); // a + b, deduped
});

test('MAS-P5-T4 isPackEnabled: opt-in (only when in the enabled list)', () => {
  assert.equal(isPackEnabled([], 'x'), false);
  assert.equal(isPackEnabled(['x'], 'x'), true);
  assert.equal(isPackEnabled(['y'], 'x'), false);
});

test('MAS-P5-T4 built-in reference packs are discoverable with their agents', () => {
  const packs = discoverPacks();
  const names = packs.map((p) => p.name);
  assert.ok(names.includes('pr-review'), 'pr-review pack should ship built-in');
  assert.ok(names.includes('feature-dev'), 'feature-dev pack should ship built-in');

  const pr = packs.find((p) => p.name === 'pr-review')!;
  const ids = packAgentIds(pr).sort();
  assert.deepEqual(ids, ['bug-reviewer', 'history-reviewer', 'instruction-reviewer', 'test-reviewer']);
});

test('MAS-P5-T4 workspace pack shadows + enable/disable round-trips on disk', () => {
  const ws = mkdtempSync(join(tmpdir(), 'br-packs-'));
  try {
    // a workspace pack named pr-review shadows the built-in one
    const dir = join(ws, '.brainrouter', 'packs', 'pr-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name: 'pr-review', version: '9.9.9' }));

    const resolved = listPacks(ws).find((p) => p.name === 'pr-review')!;
    assert.equal(resolved.source, 'workspace');
    assert.equal(resolved.version, '9.9.9');

    // opt-in: off by default; enable then disable
    assert.equal(isPackEnabled(readPackState(ws).enabled, 'pr-review'), false);
    enablePack(ws, 'pr-review');
    assert.equal(isPackEnabled(readPackState(ws).enabled, 'pr-review'), true);
    disablePack(ws, 'pr-review');
    assert.equal(isPackEnabled(readPackState(ws).enabled, 'pr-review'), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
