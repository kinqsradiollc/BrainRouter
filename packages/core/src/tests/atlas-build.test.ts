import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractSymbols } from '../atlas/pipeline/extract.js';
import { buildBaseGraph } from '../atlas/pipeline/buildGraph.js';
import { validateAtlasGraph } from '../atlas/pipeline/validate.js';
import { isAtlasGraph } from '@kinqs/brainrouter-types';

test('ATLAS-2 extractSymbols: TypeScript functions, classes, imports', () => {
  const src = [
    "import { helper } from './util';",
    "import React from 'react';",
    "export class Widget {",
    "  render() { return 1; }",
    "}",
    "export function build(x: number): number {",
    "  return x + 1;",
    "}",
    "const arrow = (a) => a * 2;",
  ].join('\n');
  const s = extractSymbols('typescript', src);
  const fnNames = s.functions.map((f) => f.name).sort();
  assert.ok(fnNames.includes('build'), 'finds function declaration');
  assert.ok(fnNames.includes('arrow'), 'finds arrow const');
  assert.ok(s.classes.some((c) => c.name === 'Widget'), 'finds class');
  assert.deepEqual(s.imports.map((i) => i.module).sort(), ['./util', 'react']);
  const widget = s.classes.find((c) => c.name === 'Widget')!;
  assert.equal(widget.lineRange[0], 3);
  assert.ok(widget.lineRange[1] >= 5, 'class block end found via brace matching');
});

test('ATLAS-2 extractSymbols: Python def/class/import via indentation', () => {
  const src = ['import os', 'from .mod import thing', 'class Foo:', '    def method(self):', '        return 1', 'def top():', '    pass'].join('\n');
  const s = extractSymbols('python', src);
  assert.ok(s.classes.some((c) => c.name === 'Foo'));
  assert.ok(s.functions.some((f) => f.name === 'top'));
  assert.ok(s.functions.some((f) => f.name === 'method'));
  assert.deepEqual(s.imports.map((i) => i.module).sort(), ['.mod', 'os']);
});

test('ATLAS-2 buildBaseGraph: nodes, contains + imports edges, validates clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-proj', dependencies: { react: '^18' } }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nA demo project for the atlas builder test, more than twenty chars.');
    fs.writeFileSync(path.join(dir, 'src/util.ts'), 'export function helper(a: number) { return a; }\n');
    fs.writeFileSync(path.join(dir, 'src/index.ts'), "import { helper } from './util';\nexport class App { run() { return helper(1); } }\n");

    const g = buildBaseGraph(dir, { now: '2026-06-22T00:00:00Z' });
    assert.ok(isAtlasGraph(g));
    assert.equal(g.project.name, 'demo-proj');
    assert.ok(g.project.languages.includes('typescript'));
    assert.ok(g.project.frameworks?.includes('React'));
    assert.ok(g.project.description && g.project.description.length > 0);

    const ids = new Set(g.nodes.map((n) => n.id));
    assert.ok(ids.has('file:src/index.ts'));
    assert.ok(ids.has('file:src/util.ts'));
    assert.ok(ids.has('function:src/util.ts:helper'));
    assert.ok(ids.has('class:src/index.ts:App'));

    // contains edge: file → its class
    assert.ok(g.edges.some((e) => e.source === 'file:src/index.ts' && e.target === 'class:src/index.ts:App' && e.type === 'contains'));
    // imports edge: index.ts → util.ts (resolved relative import)
    assert.ok(g.edges.some((e) => e.source === 'file:src/index.ts' && e.target === 'file:src/util.ts' && e.type === 'imports'));

    // ATLAS-17: deterministic layers derived from directory structure (no LLM)
    assert.ok(g.layers.length >= 2, 'should derive layers from the directory structure');
    const srcLayer = g.layers.find((l) => l.name === 'src');
    assert.ok(srcLayer, 'a "src" layer should exist');
    assert.ok(srcLayer!.nodeIds.includes('file:src/index.ts') && srcLayer!.nodeIds.includes('file:src/util.ts'));
    assert.ok(g.layers.some((l) => l.name === '(root)'), 'root-level files form a "(root)" layer');

    const v = validateAtlasGraph(g);
    assert.ok(v.ok, `graph should validate: ${v.errors.join('; ')}`);
    assert.equal(v.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ATLAS-2 validateAtlasGraph: flags a dangling edge as an error', () => {
  const v = validateAtlasGraph({
    schemaVersion: 1, kind: 'codebase',
    project: { name: 'x', languages: [], analyzedAt: '2026-06-22T00:00:00Z' },
    nodes: [{ id: 'file:a.ts', type: 'file', name: 'a.ts' }],
    edges: [{ source: 'file:a.ts', target: 'file:ghost.ts', type: 'imports' }],
    layers: [], tour: [],
  });
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => e.includes('ghost.ts')));
});
