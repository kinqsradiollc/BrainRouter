import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSort, scoreSlashCommand, type SlashCommand } from '../cli/slashSuggest.js';

const COMMANDS: SlashCommand[] = [
  { cmd: '/help',    description: 'Get help with commands' },
  { cmd: '/config',  description: 'Settings panel' },
  { cmd: '/login',   description: 'MCP profile editor' },
  { cmd: '/init',    description: 'Re-run onboarding wizard' },
  { cmd: '/clear',   description: 'Clear chat history' },
  { cmd: '/compact', description: 'LLM-driven compaction' },
  { cmd: '/mcp',     description: 'List MCP profiles' },
  { cmd: '/where',   description: 'Single-screen state view' },
];

test('scoreSlashCommand: empty query → score 0 (everything matches)', () => {
  assert.equal(scoreSlashCommand(COMMANDS[0], ''), 0);
});

test('scoreSlashCommand: command prefix match scores 0 (best)', () => {
  assert.equal(scoreSlashCommand({ cmd: '/help', description: 'X' }, 'he'), 0);
  assert.equal(scoreSlashCommand({ cmd: '/help', description: 'X' }, 'h'), 0);
});

test('scoreSlashCommand: command substring (non-prefix) scores 1', () => {
  // "lp" appears inside "help" (h-e-LP) — not a prefix
  assert.equal(scoreSlashCommand({ cmd: '/help', description: 'X' }, 'lp'), 1);
});

test('scoreSlashCommand: description-only match scores 2', () => {
  assert.equal(scoreSlashCommand({ cmd: '/foo', description: 'configure MCP profiles' }, 'profile'), 2);
});

test('scoreSlashCommand: no match scores 3', () => {
  assert.equal(scoreSlashCommand({ cmd: '/foo', description: 'bar' }, 'xyz'), 3);
});

test('scoreSlashCommand: case-insensitive', () => {
  assert.equal(scoreSlashCommand({ cmd: '/Config', description: 'X' }, 'CON'), 0);
});

test('filterAndSort: empty query returns first MAX_VISIBLE commands in original order', () => {
  const out = filterAndSort(COMMANDS, '');
  assert.equal(out.length, 6, 'MAX_VISIBLE = 6');
  assert.deepEqual(out.map((c) => c.cmd), COMMANDS.slice(0, 6).map((c) => c.cmd));
});

test('filterAndSort: "c" prefix bucket comes before substring bucket', () => {
  const out = filterAndSort(COMMANDS, 'c');
  // /config, /clear, /compact match by prefix (score 0)
  // /mcp matches by substring (score 1)
  assert.ok(out.some((c) => c.cmd === '/config'));
  assert.ok(out.some((c) => c.cmd === '/clear'));
  assert.ok(out.some((c) => c.cmd === '/compact'));
  // /mcp ("mcp" contains "c") — substring match
  const mcpIdx = out.findIndex((c) => c.cmd === '/mcp');
  const configIdx = out.findIndex((c) => c.cmd === '/config');
  if (mcpIdx >= 0 && configIdx >= 0) {
    assert.ok(configIdx < mcpIdx, '/config (prefix) should rank above /mcp (substring)');
  }
});

test('filterAndSort: drops non-matching commands (score 3)', () => {
  const out = filterAndSort(COMMANDS, 'help');
  // Only /help matches by command; /init or /where don't.
  assert.ok(out.some((c) => c.cmd === '/help'));
  assert.ok(!out.some((c) => c.cmd === '/init'));
});

test('filterAndSort: stable order — within the same bucket, original index wins', () => {
  // All three of /config /clear /compact start with "c" → score 0.
  // Their original order in COMMANDS is /config (1), /clear (4), /compact (5).
  const out = filterAndSort(COMMANDS, 'c');
  const prefixBucket = out.filter((c) => ['/config', '/clear', '/compact'].includes(c.cmd));
  assert.deepEqual(
    prefixBucket.map((c) => c.cmd),
    ['/config', '/clear', '/compact'],
    'preserves original order within the prefix bucket',
  );
});

test('filterAndSort: caps at MAX_VISIBLE even with many matches', () => {
  const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({
    cmd: `/cmd${i}`, description: 'X',
  }));
  const out = filterAndSort(many, 'cmd');
  assert.equal(out.length, 6);
});
