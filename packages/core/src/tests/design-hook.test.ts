/**
 * ADR-056 D-B2 — the design hook: off by default (byte-neutral), the immediate
 * tier reports ≤ 5 findings for the one file just written, the full tier walks
 * every UI file the turn wrote within its byte cap, non-UI writes are ignored,
 * silent agents are left alone — and, driven through a real turn, a write_file
 * of a page with a tell puts the findings into the NEXT turn's context, never
 * the tool result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { designHookBlock, designHookAfterWrite, designHookAtTurnEnd, DESIGN_HOOK_LIMITS, isDesignHookTarget } from '../design/index.js';
import { setCliKnobOverride, _resetCliKnobsCache, getCliKnobs, resolveCliKnobs } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

let _gate: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> { const run = _gate.then(fn, fn); _gate = run.then(() => undefined, () => undefined); return run; }
const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
const cb = { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any;
const TELL = '<!doctype html><html><head><style>.card{border-left:4px solid #e11d48}</style></head><body><div class="card">x</div><img src="a.png"><marquee>hi</marquee></body></html>';

test('B2 the knob resolves to off by default and accepts the three tiers', () => {
  _resetCliKnobsCache();
  assert.equal(getCliKnobs().design.hook, 'off');
  setCliKnobOverride({ design: { hook: 'full' } }); assert.equal(getCliKnobs().design.hook, 'full');
  setCliKnobOverride({ design: { hook: 'immediate' } }); assert.equal(getCliKnobs().design.hook, 'immediate');
  // Overrides are trusted (post-resolution); the config reader is what validates.
  assert.equal(resolveCliKnobs({ cli: { design: { hook: 'nope' } } } as never).design.hook, 'off');
  assert.equal(resolveCliKnobs({ cli: { design: { hook: 'immediate' } } } as never).design.hook, 'immediate');
  _resetCliKnobsCache();
});

test('B2 designHookBlock bounds each tier and ignores non-UI files', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'page.html'), TELL);
    fs.writeFileSync(path.join(ws, 'src', 'x.ts'), 'export const x = 1;');
    assert.equal(designHookBlock(ws, ['src/x.ts'], 'full'), '');
    const immediate = designHookBlock(ws, ['src/page.html'], 'immediate');
    assert.match(immediate, /^Design check \(immediate\) on 1 file you wrote: 1 error, 2 warnings\./);
    assert.match(immediate, /- side-stripe-border src\/page\.html/); assert.match(immediate, /- missing-alt/);
    assert.ok(immediate.length <= DESIGN_HOOK_LIMITS.immediateChars);
    const many = Array.from({ length: 20 }, (_, i) => { const p = `src/p${i}.html`; fs.writeFileSync(path.join(ws, p), TELL); return p; });
    const full = designHookBlock(ws, many, 'full');
    assert.match(full, /^Design check \(full\) on 15 files/);
    assert.ok(full.length <= DESIGN_HOOK_LIMITS.fullChars);
    assert.ok(!/src\/p15\.html/.test(full), 'the 16th file is beyond the full-tier file cap');
    // The immediate tier shows at most five findings and says how many it left out.
    fs.writeFileSync(path.join(ws, 'src', 'gallery.html'), `<!doctype html><html><body>${'<img src="a.png">'.repeat(7)}</body></html>`);
    const capped = designHookBlock(ws, ['src/gallery.html'], 'immediate');
    assert.equal((capped.match(/^- missing-alt/gm) ?? []).length, DESIGN_HOOK_LIMITS.immediateFindings);
    assert.match(capped, /… 2 more/);
    assert.equal(designHookBlock(ws, ['../outside.html'], 'full'), '', 'outside the workspace is not read');
    assert.ok(isDesignHookTarget('a.tsx') && !isDesignHookTarget('a.py'));
  });
});

test('B2 the tiers gate on the knob, silence, and reviewed execution', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.writeFileSync(path.join(ws, 'page.html'), TELL);
    const agent = { workspaceRoot: ws, silent: false, reviewSourceSafety: false, pendingStopContext: '' };
    _resetCliKnobsCache();
    designHookAfterWrite(agent, 'page.html'); designHookAtTurnEnd(agent, ['page.html']);
    assert.equal(agent.pendingStopContext, '', 'off by default');
    setCliKnobOverride({ design: { hook: 'immediate' } });
    designHookAfterWrite(agent, 'page.html'); assert.match(agent.pendingStopContext, /Design check \(immediate\)/);
    agent.pendingStopContext = ''; designHookAtTurnEnd(agent, ['page.html']); assert.equal(agent.pendingStopContext, '', 'immediate tier has no turn-end pass');
    setCliKnobOverride({ design: { hook: 'full' } });
    designHookAtTurnEnd(agent, ['page.html']); assert.match(agent.pendingStopContext, /Design check \(full\)/);
    const silent = { ...agent, silent: true, pendingStopContext: '' }; designHookAfterWrite(silent, 'page.html'); assert.equal(silent.pendingStopContext, '');
    const reviewed = { ...agent, reviewSourceSafety: true, pendingStopContext: '' }; designHookAtTurnEnd(reviewed, ['page.html']); assert.equal(reviewed.pendingStopContext, '');
    _resetCliKnobsCache();
  });
});

test('B2 through a real turn: a written page with tells reaches the NEXT turn as stop-hook context', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    setCliKnobOverride({ design: { hook: 'full' } });
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, { workspaceRoot: workspace, launchCwd: workspace, silent: false });
    const bodies: any[] = [];
    let served = false;
    const of = globalThis.fetch;
    const lastUser = (body: any): string => { const users = (body.messages ?? []).filter((m: any) => m.role === 'user'); const last = users[users.length - 1]; return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''); };
    try {
      globalThis.fetch = (async (_url: string, init: any) => {
        const body = JSON.parse(init.body); bodies.push(body);
        if (lastUser(body).startsWith('please write the landing page') && !served) {
          served = true;
          return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/landing.html', content: TELL }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      await agent.runTurn('please write the landing page', cb);
      await agent.runTurn('what next?', cb);
    } finally { globalThis.fetch = of; _resetCliKnobsCache(); }
    const turn2 = bodies.find((b) => lastUser(b).includes('what next?'));
    assert.ok(turn2, 'turn 2 captured');
    assert.match(lastUser(turn2), /\[stop-hook context\]/);
    assert.match(lastUser(turn2), /Design check \((immediate|full)\)/);
    assert.match(lastUser(turn2), /side-stripe-border src\/landing\.html/);
    // The tool result itself carried no findings — the hook informs the next turn, it does not edit the result.
    const toolMsg = bodies.flatMap((b) => b.messages ?? []).find((m: any) => m.role === 'tool');
    assert.ok(toolMsg && !/side-stripe-border/.test(String(toolMsg.content)));
  }));
});
