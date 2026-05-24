import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPaletteCommands } from '../cli/ink/ChatApp.js';

// --- Pure helpers from the Ink chat REPL ---------------------------------
// These are testable without mounting Ink. The orchestration in runChat.tsx
// is exercised end-to-end via the manual smoke test (BRAINROUTER_INK_REPL=1
// brainrouter chat) — there is no headless way to drive Ink's keystroke
// loop. See HANDOFF_INK_REPL.md "Test environment quick-start".

const COMMANDS = [
  { cmd: '/help',    description: 'Get help with commands' },
  { cmd: '/config',  description: 'Settings panel' },
  { cmd: '/clear',   description: 'Clear chat history' },
  { cmd: '/compact', description: 'LLM-driven compaction' },
  { cmd: '/where',   description: 'Single-screen state view' },
  { cmd: '/init',    description: 'Re-run onboarding wizard' },
];

test('filterPaletteCommands: empty query returns the full list in original order', () => {
  const out = filterPaletteCommands(COMMANDS, '');
  assert.equal(out.length, COMMANDS.length);
  assert.equal(out[0].cmd, '/help');
});

test('filterPaletteCommands: prefix matches rank ahead of substring matches', () => {
  // "co" is a prefix of /config and /compact; it's a substring of /clear's
  // description ("Clear chat history" contains no "co" — let's use a clearer
  // example). /compact starts with "co", /config starts with "co".
  const out = filterPaletteCommands(COMMANDS, 'co');
  assert.ok(out.length >= 2);
  // Both /config and /compact start with "co" — both should rank ahead of
  // any non-prefix matches.
  const top = out.slice(0, 2).map((c) => c.cmd);
  assert.ok(top.includes('/config'));
  assert.ok(top.includes('/compact'));
});

test('filterPaletteCommands: description-only matches still appear, ranked lowest', () => {
  // "wizard" appears in /init's description, not its name.
  const out = filterPaletteCommands(COMMANDS, 'wizard');
  assert.equal(out[0].cmd, '/init');
});

test('filterPaletteCommands: case-insensitive', () => {
  const out = filterPaletteCommands(COMMANDS, 'HELP');
  assert.equal(out[0].cmd, '/help');
});

test('filterPaletteCommands: unmatched queries return empty list', () => {
  const out = filterPaletteCommands(COMMANDS, 'zzzznotreal');
  assert.equal(out.length, 0);
});

test('filterPaletteCommands: stable secondary sort by original index for same-score matches', () => {
  // Both /config and /clear contain "c" as a body prefix → score 0; original
  // order in the list is /config, /clear → output must preserve that order.
  const subset = [
    { cmd: '/config', description: 'X' },
    { cmd: '/clear', description: 'Y' },
  ];
  const out = filterPaletteCommands(subset, 'c');
  assert.equal(out[0].cmd, '/config');
  assert.equal(out[1].cmd, '/clear');
});
