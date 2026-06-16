import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlashInput, type DeskCommand } from './commands.js';

const cmd = (base: string, wire: DeskCommand['wire']): DeskCommand =>
  ({ cmd: base, base, desc: '', category: '', wire });

const CMDS: DeskCommand[] = [
  cmd('/diff', { kind: 'panel', panel: 'diff' }),
  cmd('/goal', { kind: 'bridge', cmd: 'goal', takesArgs: true }),
  cmd('/review', { kind: 'cli' }),
  cmd('/schedule', { kind: 'cli' }),
];

test('plain text is not a slash command (becomes an LLM turn)', () => {
  assert.equal(resolveSlashInput('hello world', CMDS).kind, 'not-slash');
  assert.equal(resolveSlashInput('  fix the reranker bug', CMDS).kind, 'not-slash');
});

test('a known command routes through the registry — never the LLM', () => {
  const r = resolveSlashInput('/diff', CMDS);
  assert.equal(r.kind, 'command');
  if (r.kind === 'command') assert.equal(r.command.base, '/diff');
});

test('an UNKNOWN slash is classified unknown, NOT sent as a prompt', () => {
  const r = resolveSlashInput('/totally-made-up some args', CMDS);
  assert.equal(r.kind, 'unknown');
  if (r.kind === 'unknown') assert.equal(r.base, '/totally-made-up');
});

test('a bridge command typed with args runs immediately with those args', () => {
  const r = resolveSlashInput('/goal ship 0.4.15', CMDS);
  assert.equal(r.kind, 'bridge');
  if (r.kind === 'bridge') { assert.equal(r.cmd, 'goal'); assert.equal(r.args, 'ship 0.4.15'); }
});

test('bridge fast-path resolves even with an empty catalog (pre-load race)', () => {
  const r = resolveSlashInput('/ps', []);
  assert.equal(r.kind, 'bridge');
  if (r.kind === 'bridge') assert.equal(r.cmd, 'ps');
});

test('review / schedule route to a command (cli fallback), never to the LLM', () => {
  for (const input of ['/review', '/schedule']) {
    assert.equal(resolveSlashInput(input, CMDS).kind, 'command', `${input} is routed, not a prompt`);
  }
});
