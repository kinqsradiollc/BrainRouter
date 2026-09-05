/**
 * ADR-056 D-A5 — `/diagram`: the argument parser routes every subcommand and
 * kind; `validate` and `render` run deterministically against a file in the
 * workspace and print the receipt; `<kind> <brief>` hands the agent a bounded
 * brief that ends in diagram_render with the derived slug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diagramFixture, diagramPaths } from '@kinqs/brainrouter-core/diagram';
import { parseDiagramArgs, diagramAuthoringPrompt, tryHandleDiagramCommand } from '../cli/commands/diagram/index.js';
import os from 'node:os';
import { makeAgent } from './_helpers.js';

/** `withTempWorkspace` is synchronous and tears down in `finally`; these tests await, so they own their directory. */
async function inTempWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-diagram-'));
  try { await fn(ws); } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

test('D-A5 parseDiagramArgs routes subcommands, kinds, flags, and errors', () => {
  assert.deepEqual(parseDiagramArgs([]), { action: 'help' });
  assert.deepEqual(parseDiagramArgs(['list']), { action: 'list' });
  assert.deepEqual(parseDiagramArgs(['validate', 'a.json']), { action: 'validate', file: 'a.json' });
  assert.deepEqual(parseDiagramArgs(['render', 'a.json', '--slug', 'my-map', '--theme=light']), { action: 'render', file: 'a.json', slug: 'my-map', theme: 'light' });
  assert.equal(parseDiagramArgs(['render', 'a.json', '--slug', '../x']).action, 'error');
  assert.equal(parseDiagramArgs(['render', 'a.json', '--theme', 'neon']).action, 'error');
  assert.deepEqual(parseDiagramArgs(['render', 'a.json', '--no-verify']), { action: 'render', file: 'a.json', verify: false });
  assert.deepEqual(parseDiagramArgs(['draft', '--layers', 'API,Memory', '--prefix', 'packages/core', '--slug', 'core-map']), { action: 'draft', layers: ['API', 'Memory'], pathPrefix: 'packages/core', slug: 'core-map' });
  assert.equal(parseDiagramArgs(['draft', '--bogus', 'x']).action, 'error');
  assert.deepEqual(parseDiagramArgs(['diff', 'my-map', '--base', 'origin/main', '--open']), { action: 'diff', slug: 'my-map', base: 'origin/main', open: true });
  assert.equal(parseDiagramArgs(['diff']).action, 'error');
  assert.deepEqual(parseDiagramArgs(['show', 'my-map']), { action: 'show', slug: 'my-map' });
  assert.deepEqual(parseDiagramArgs(['sequence', 'checkout', 'flow']), { action: 'author', kind: 'sequence', brief: 'checkout flow' });
  assert.equal(parseDiagramArgs(['architecture']).action, 'error');
  assert.equal(parseDiagramArgs(['mindmap', 'x']).action, 'error');
});

test('D-A6 parseDiagramArgs routes import with kind/slug/title and rejects bad values', () => {
  assert.deepEqual(parseDiagramArgs(['import', 'docs/flow.mmd']), { action: 'import', file: 'docs/flow.mmd' });
  assert.deepEqual(parseDiagramArgs(['import', 'docs/flow.mmd', '--kind', 'workflow', '--slug', 'checkout', '--title', 'Checkout']), { action: 'import', file: 'docs/flow.mmd', kind: 'workflow', slug: 'checkout', title: 'Checkout' });
  assert.equal(parseDiagramArgs(['import', 'x.mmd', '--kind', 'pie']).action, 'error');
  assert.equal(parseDiagramArgs(['import']).action, 'error');
});

test('D-A5 the authoring brief names the kind, the cap, evidence, and the render slug', () => {
  const p = diagramAuthoringPrompt('architecture', 'the review subsystem', 'the-review-subsystem');
  assert.match(p, /^Produce a architecture diagram of: the review subsystem/);
  assert.match(p, /at most 12 primary elements/);
  assert.match(p, /Never infer a relationship from file proximity/);
  assert.match(p, /diagram_render with `slug: "the-review-subsystem"`/);
});

test('D-A5 /diagram validate + render + show + list run against a workspace file', async () => {
  await inTempWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, 'map.json'), JSON.stringify(diagramFixture('dataflow')));
    const agent = makeAgent(ws);
    const ctx = (args: string[]) => ({ command: '/diagram', args, agent, mcpClient: {}, config: {}, rl: {}, repl: { runAgentTurn: () => {} } }) as any;
    const v = await captureLogs(async () => { assert.equal(await tryHandleDiagramCommand(ctx(['validate', 'map.json'])), true); });
    assert.match(v, /valid dataflow diagram/);
    const r = await captureLogs(async () => { await tryHandleDiagramCommand(ctx(['render', 'map.json', '--slug', 'flows', '--theme', 'light'])); });
    assert.match(r, /checks 9\/9/);
    const p = diagramPaths(ws, 'flows');
    assert.ok(fs.existsSync(p.html) && fs.existsSync(p.spec) && fs.existsSync(p.receipt));
    assert.ok(fs.readFileSync(p.html, 'utf8').includes('data-theme="light"'));
    const s = await captureLogs(async () => { await tryHandleDiagramCommand(ctx(['show', 'flows'])); });
    assert.match(s, /Events to dashboard/);
    const l = await captureLogs(async () => { await tryHandleDiagramCommand(ctx(['list'])); });
    assert.match(l, /flows\s+dataflow\s+Events to dashboard/);
    assert.equal(await tryHandleDiagramCommand({ ...ctx([]), command: '/other' }), false);
  });
});

test('D-A5 /diagram <kind> <brief> runs an agent turn with the bounded brief', async () => {
  await inTempWorkspace(async (ws) => {
    const prompts: string[] = [];
    const ctx = { command: '/diagram', args: ['lifecycle', 'job', 'states'], agent: makeAgent(ws), mcpClient: {}, config: {}, rl: {}, repl: { runAgentTurn: (p: string) => prompts.push(p) } } as any;
    await captureLogs(async () => { assert.equal(await tryHandleDiagramCommand(ctx), true); });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /^Produce a lifecycle diagram of: job states/);
    assert.match(prompts[0], /slug: "job-states"/);
  });
});

test('D-A6 /diagram import writes a fresh spec from a Mermaid file and reports what was not transcribed', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-diagram-import-'));
  try {
    fs.mkdirSync(path.join(ws, 'docs'));
    fs.writeFileSync(path.join(ws, 'docs', 'flow.mmd'), 'flowchart LR\n  A([Start]) --> B{Ready?}\n  B -->|yes| C[Ship]\n  C --> D([Done])\n  style C fill:#0f0\n');
    const agent = makeAgent(ws);
    const ctx = (args: string[]) => ({ command: '/diagram', args, agent, mcpClient: {}, config: {}, rl: {}, repl: {} }) as any;
    const out = await captureLogs(async () => { assert.equal(await tryHandleDiagramCommand(ctx(['import', 'docs/flow.mmd', '--slug', 'ship-flow'])), true); });
    assert.match(out, /imported workflow: 4 nodes, 3 edges/); assert.match(out, /not transcribed: style C/); assert.match(out, /direction LR ignored/);
    const spec = JSON.parse(fs.readFileSync(path.join(ws, '.brainrouter', 'diagrams', 'ship-flow.json'), 'utf8')) as { kind: string; nodes: Array<{ shape?: string }> };
    assert.equal(spec.kind, 'workflow'); assert.deepEqual(spec.nodes.map((n) => n.shape), ['start', 'decision', 'step', 'end']);
    assert.ok(!fs.readFileSync(path.join(ws, '.brainrouter', 'diagrams', 'ship-flow.json'), 'utf8').includes('#0f0'));
    const bad = await captureLogs(async () => { await tryHandleDiagramCommand(ctx(['import', '../outside.mmd'])); });
    assert.match(bad, /inside the workspace/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
