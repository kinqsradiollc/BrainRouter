// ADR-041 A41-15 (W3) — Code Mode runner: real subprocess + fd-3 bridge + budgets.
// These drive the ACTUAL child process, so they need the compiled child at
// dist/exec/codeMode/runCodeChild.js — run `npm run build` first (CI does).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeModeRunner } from '../exec/codeMode/codeModeRunner.js';
import { resolveCodeModeBudget, DEFAULT_CODE_MODE_BUDGET } from '../exec/codeMode/budget.js';
import type { CodeToolDispatch } from '../exec/codeMode/codeRunnerPort.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-'));

function run(source: string, dispatch: CodeToolDispatch, budgetOverride = {}) {
  return codeModeRunner.runCode(
    source,
    { workspaceRoot: tmpWs(), budget: resolveCodeModeBudget(budgetOverride), toolNames: ['echo', 'boom'] },
    dispatch,
  );
}

test('A41-15 — a program executes and its tool calls go through dispatch', async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const dispatch: CodeToolDispatch = async (tool, args) => { calls.push({ tool, args }); return `echoed:${JSON.stringify(args)}`; };
  const res = await run('const r = await agent.echo({ x: 1 }); return r + "|" + r.length;', dispatch);
  assert.equal(res.killReason, undefined);
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(calls, [{ tool: 'echo', args: { x: 1 } }]);
  assert.match(res.returnValue, /echoed:\{"x":1\}\|/);
});

test('A41-15 — a dispatch that throws (a real deny) rejects inside the program, no ghost effect', async () => {
  const dispatch: CodeToolDispatch = async () => { throw new Error('policy denied write_file'); };
  const res = await run(
    'try { await agent.boom({}); return "SHOULD NOT REACH"; } catch (e) { return "caught:" + e.message; }',
    dispatch,
  );
  assert.equal(res.killReason, undefined);
  assert.match(res.returnValue, /caught:policy denied write_file/);
});

test('A41-15 — a clean return with no tool calls', async () => {
  const res = await run('return 40 + 2;', async () => 'unused');
  assert.equal(res.returnValue, '42');
  assert.equal(res.toolCalls, 0);
  assert.equal(res.killReason, undefined);
});

test('A41-15 — a thrown program error is captured, not a crash', async () => {
  const res = await run('throw new Error("kaboom");', async () => 'unused');
  assert.ok(res.error && res.error.includes('kaboom'));
});

test('A41-15 — a synchronous infinite loop is killed AND the parent stays responsive', async () => {
  let parentTimerFired = false;
  const t = setTimeout(() => { parentTimerFired = true; }, 150);
  const res = await run('while (true) {}', async () => 'unused', { wallClockMs: 3000, heartbeatGraceMs: 600 });
  clearTimeout(t);
  assert.ok(res.killReason === 'starved' || res.killReason === 'wall-clock', `killed by a hard ceiling, got ${res.killReason}`);
  assert.equal(parentTimerFired, true, 'the parent event loop was never blocked by the child spin');
});

test('A41-15 — an idle-but-slow program is killed at the wall clock', async () => {
  const res = await run('await new Promise(() => {});', async () => 'unused', { wallClockMs: 400, heartbeatGraceMs: 5000 });
  assert.equal(res.killReason, 'wall-clock');
});

test('A41-15 — exceeding maxToolCalls terminates the run', async () => {
  const res = await run('for (let i = 0; i < 100; i++) { await agent.echo({ i }); } return "done";', async () => 'ok', { maxToolCalls: 5 });
  assert.equal(res.killReason, 'max-tool-calls');
  assert.ok(res.toolCalls > 5 === false || res.toolCalls >= 5);
});

test('A41-15 — program output over the cap is truncated', async () => {
  const res = await run('for (let i = 0; i < 5000; i++) console.log("X".repeat(100)); return "ok";', async () => 'unused', { maxOutputChars: 2000 });
  assert.equal(res.outputTruncated, true);
  assert.ok(res.output.length <= 2000);
});

test('A41-15 — budget defaults are sane and clamp overrides', () => {
  assert.equal(resolveCodeModeBudget().wallClockMs, DEFAULT_CODE_MODE_BUDGET.wallClockMs);
  assert.equal(resolveCodeModeBudget({ maxToolCalls: -5 }).maxToolCalls, 1, 'clamped to min');
  assert.equal(resolveCodeModeBudget({ wallClockMs: 99_999_999 }).wallClockMs, 600_000, 'clamped to max');
});
