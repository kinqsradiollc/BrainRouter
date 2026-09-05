/**
 * ADR-056 D-B1 — `/design`: the parser routes detect/rules/help and rejects
 * unknown rules; `detect` runs the deterministic detector over a workspace file
 * and prints findings grouped by file; `rules` lists the catalogue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDesignArgs, tryHandleDesignCommand } from '../cli/commands/design/index.js';
import { makeAgent } from './_helpers.js';

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

test('B1 parseDesignArgs routes subcommands and validates rule ids', () => {
  assert.deepEqual(parseDesignArgs([]), { action: 'help' });
  assert.deepEqual(parseDesignArgs(['rules']), { action: 'rules' });
  assert.deepEqual(parseDesignArgs(['detect']), { action: 'detect', paths: [] });
  assert.deepEqual(parseDesignArgs(['detect', 'src', 'index.html', '--rules', 'missing-alt,marquee', '--json']), { action: 'detect', paths: ['src', 'index.html'], rules: ['missing-alt', 'marquee'], json: true });
  assert.equal(parseDesignArgs(['detect', '--rules', 'nope']).action, 'error');
  assert.deepEqual(parseDesignArgs(['polish']), { action: 'verb', verb: 'polish', targets: [] });
  assert.deepEqual(parseDesignArgs(['critique', 'src/pages', '--mode', 'operate', '--world=editorial']), { action: 'verb', verb: 'critique', targets: ['src/pages'], mode: 'operate', world: 'editorial' });
  assert.equal(parseDesignArgs(['polish', '--mode', 'loud']).action, 'error');
  assert.equal(parseDesignArgs(['polish', '--world', 'narnia']).action, 'error');
  assert.equal(parseDesignArgs(['polish', '--world', 'brutalist-skill']).action, 'verb');
  assert.equal(parseDesignArgs(['sparkle']).action, 'error');
  assert.deepEqual(parseDesignArgs(['verbs']), { action: 'verbs' });
  assert.equal(parseDesignArgs(['audit']).action, 'verb', 'audit is the skill verb, not a detector alias');
  assert.deepEqual(parseDesignArgs(['detect', '--browser']), { action: 'detect', paths: [], browser: true });
  assert.deepEqual(parseDesignArgs(['hooks']), { action: 'hooks' });
  assert.deepEqual(parseDesignArgs(['hooks', 'on']), { action: 'hooks', tier: 'full' });
  assert.deepEqual(parseDesignArgs(['hooks', 'immediate']), { action: 'hooks', tier: 'immediate' });
  assert.equal(parseDesignArgs(['hooks', 'loud']).action, 'error');
});

test('B1 /design detect runs over a workspace file and prints grouped findings; /design rules lists the catalogue', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-design-'));
  try {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'page.html'), '<!doctype html><html><head><style>.card{border-left:4px solid #e11d48}</style></head><body><div class="card">x</div><img src="a.png"></body></html>');
    const agent = makeAgent(ws);
    const ctx = (args: string[]) => ({ command: '/design', args, agent, mcpClient: {}, config: {}, rl: {}, repl: {} }) as any;
    const out = await captureLogs(async () => { assert.equal(await tryHandleDesignCommand(ctx(['detect', 'src'])), true); });
    assert.match(out, /Design detector/); assert.match(out, /src\/page\.html/); assert.match(out, /side-stripe-border/); assert.match(out, /missing-alt/);
    const browser = await captureLogs(async () => { await tryHandleDesignCommand(ctx(['detect', 'src', '--browser'])); });
    assert.match(browser, /Browser engine unavailable here/);
    const json = await captureLogs(async () => { await tryHandleDesignCommand(ctx(['detect', 'src/page.html', '--json'])); });
    const parsed = JSON.parse(json) as { findings: Array<{ rule: string }>; errors: number };
    assert.ok(parsed.findings.some((f) => f.rule === 'missing-alt')); assert.equal(parsed.errors, 1);
    const rules = await captureLogs(async () => { await tryHandleDesignCommand(ctx(['rules'])); });
    assert.match(rules, /gradient-text/); assert.match(rules, /design-system-font/);
    assert.equal(await tryHandleDesignCommand({ ...ctx([]), command: '/other' }), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('B4 /design <verb> hands a bounded brief to the skill runner and the agent turn', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-design-verb-'));
  try {
    const agent = makeAgent(ws);
    const turns: string[] = [];
    const mcpClient = { callTool: async () => { throw new Error('no mcp in this test'); } };
    const ctx = { command: '/design', args: ['polish', 'src/pages', '--mode', 'operate'], agent, mcpClient, config: {}, rl: {}, repl: { runAgentTurn: (p: string) => { turns.push(p); } } } as any;
    const out = await captureLogs(async () => { assert.equal(await tryHandleDesignCommand(ctx), true); });
    assert.equal(turns.length, 1, `no turn ran; output was: ${out}`);
    assert.match(turns[0], /\/design polish: run the `polish` verb of the `hallmark` design skill/);
    assert.match(turns[0], /references\/verbs\/polish\.md/); assert.match(turns[0], /Mode: operate/); assert.match(turns[0], /src\/pages/);
    assert.equal(agent.activeSkill, 'hallmark');
    const verbs = await captureLogs(async () => { await tryHandleDesignCommand({ ...ctx, args: ['verbs'] }); });
    assert.match(verbs, /critique/); assert.match(verbs, /typeset/); assert.match(verbs, /product/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('B5 /design critique runs the review in an isolated side agent, then the detector, then synthesis through the skill', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-design-critique-'));
  try {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'page.html'), '<!doctype html><html><head><style>.card{border-left:4px solid #e11d48}</style></head><body><div class="card">x</div></body></html>');
    const agent = makeAgent(ws);
    const turns: string[] = []; const sidePrompts: string[] = [];
    const repl = {
      runAgentTurnAsync: async (p: string, o: any) => { sidePrompts.push(p); assert.equal(o.agent.silent, true, 'the review agent must be silent/isolated'); o.agent.chatHistory.push({ role: 'assistant', content: 'Fit: weak.\n{"hierarchy": 6, "clarity": 5, "resonance": 4}' }); },
      runAgentTurn: (p: string) => { turns.push(p); },
    };
    const mcpClient = { callTool: async () => { throw new Error('no mcp in this test'); } };
    const out = await captureLogs(async () => { assert.equal(await tryHandleDesignCommand({ command: '/design', args: ['critique', 'src/page.html'], agent, mcpClient, config: {}, rl: {}, repl } as any), true); });
    assert.equal(sidePrompts.length, 1); assert.ok(!/side-stripe-border/.test(sidePrompts[0]), 'the review saw detector output');
    assert.equal(turns.length, 1, `no synthesis turn; output: ${out}`);
    assert.match(turns[0], /Design review \(isolated subagent\)/); assert.match(turns[0], /Fit: weak/); assert.match(turns[0], /side-stripe-border/);
    assert.equal(turns[0].startsWith('Degraded'), false);
    assert.equal(agent.activeSkill, 'hallmark');
    assert.ok(fs.existsSync(path.join(ws, '.brainrouter', 'design', 'critiques', 'src-page-html')), 'no snapshot dir');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
