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
  assert.equal(parseDesignArgs(['polish']).action, 'error');
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
