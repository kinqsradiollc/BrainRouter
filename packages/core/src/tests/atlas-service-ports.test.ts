import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isServicePortPath, moduleForServicePath, detectServicePorts } from '../atlas/servicePorts.js';
import { buildBaseGraph } from '../atlas/buildGraph.js';

test('isServicePortPath matches service.ts/gateway.ts but not test files', () => {
  assert.equal(isServicePortPath('packages/core/src/exec/service.ts'), true);
  assert.equal(isServicePortPath('packages/core/src/provider/gateway.ts'), true);
  assert.equal(isServicePortPath('brainrouter/src/memory/tree/service.ts'), true);
  assert.equal(isServicePortPath('packages/core/src/tests/exec-service.test.ts'), false);
  assert.equal(isServicePortPath('packages/core/src/exec/execPolicy.ts'), false);
});

test('moduleForServicePath strips src/ + filename to the module path', () => {
  assert.equal(moduleForServicePath('packages/core/src/exec/service.ts'), 'exec');
  assert.equal(moduleForServicePath('packages/core/src/provider/gateway.ts'), 'provider');
  assert.equal(moduleForServicePath('brainrouter/src/memory/tree/service.ts'), 'memory/tree');
});

test('detectServicePorts finds port files in a built graph, grouped by module', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'svcports-'));
  try {
    fs.mkdirSync(path.join(ws, 'src', 'exec'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'src', 'provider'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'exec', 'service.ts'), 'export function createExecService() { return {}; }\n');
    fs.writeFileSync(path.join(ws, 'src', 'exec', 'execPolicy.ts'), 'export function decide() { return 1; }\n');
    fs.writeFileSync(path.join(ws, 'src', 'provider', 'gateway.ts'), 'export function createModelGateway() { return {}; }\n');

    const graph = buildBaseGraph(ws);
    const { ports, byModule } = detectServicePorts(graph);
    const modules = ports.map((p) => p.module);

    assert.ok(modules.includes('exec'), 'detects exec/service.ts');
    assert.ok(modules.includes('provider'), 'detects provider/gateway.ts');
    assert.ok(byModule['exec']?.endsWith('exec/service.ts'));
    assert.ok(byModule['provider']?.endsWith('provider/gateway.ts'));
    // a non-port file in the same module is not counted
    assert.equal(ports.some((p) => p.path.endsWith('execPolicy.ts')), false);
    // file-level only — no duplicate entries for the same path
    assert.equal(new Set(ports.map((p) => p.path)).size, ports.length);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
