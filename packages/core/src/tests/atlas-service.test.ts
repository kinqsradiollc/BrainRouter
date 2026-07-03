import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAtlasGraph } from '@kinqs/brainrouter-types';
import { createAtlasService, AtlasService } from '../atlas/service/service.js';
import { atlasGraphFile, readAtlasGraph, atlasGraphStats } from '../atlas/store/atlasStore.js';
import { scanWorkspace } from '../atlas/pipeline/scan.js';
import { validateAtlasGraph } from '../atlas/pipeline/validate.js';

test('AtlasService is a per-workspace facade — delegates to the atlas pipeline', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-svc-'));
  try {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'foo.ts'), 'export function foo(): number { return 1; }\n');

    const svc = createAtlasService(ws);
    assert.ok(svc instanceof AtlasService);
    assert.equal(svc.graphFile(), atlasGraphFile(ws));
    assert.equal(svc.read(), readAtlasGraph(ws));
    assert.equal(svc.read(), null);

    // scan parity (file list is deterministic for the same tree).
    assert.equal(svc.scan().files.length, scanWorkspace(ws).files.length);
    assert.ok(svc.scan().files.length > 0);

    const graph = svc.build();
    assert.ok(isAtlasGraph(graph));
    assert.ok(graph.nodes.length > 0);

    // store round-trip — read back what we saved (timestamp-independent).
    svc.save(graph);
    assert.notEqual(svc.read(), null);
    assert.deepEqual(svc.read(), readAtlasGraph(ws));

    // pure helpers match the module 1:1.
    assert.deepEqual(svc.stats(graph), atlasGraphStats(graph));
    assert.deepEqual(svc.validate(graph), validateAtlasGraph(graph));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
