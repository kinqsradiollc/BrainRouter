import test from 'node:test';
import assert from 'node:assert/strict';
import { captureConsoleOutput } from '../cli/ink/consoleCapture.js';
import { filterPaletteCommands, tailReasoning, REASONING_TAIL_CHARS, buildReasoningWindow, REASONING_VISIBLE_LINES } from '../cli/ink/ChatApp.js';

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

// --- Live-stream reasoning trailing-window --------------------------------
// Long chains-of-thought used to grow unbounded in the live dim-italic
// block and reflow the whole Ink frame on every 80ms flush. tailReasoning
// caps the visible window so streaming feels stable.

test('tailReasoning: short inputs pass through unchanged', () => {
  const short = 'thinking about the problem';
  assert.equal(tailReasoning(short), short);
});

test('tailReasoning: input exactly at the cap passes through unchanged', () => {
  const exact = 'x'.repeat(REASONING_TAIL_CHARS);
  assert.equal(tailReasoning(exact), exact);
});

test('tailReasoning: long inputs are tail-truncated with an ellipsis prefix', () => {
  const long = 'word '.repeat(800); // 4000 chars, well over 1500
  const out = tailReasoning(long);
  assert.ok(out.startsWith('… '), `expected ellipsis prefix, got: ${out.slice(0, 20)}`);
  // Tail window is REASONING_TAIL_CHARS minus the word-boundary trim, so
  // the result must be shorter than the input but within ~REASONING_TAIL_CHARS + 2.
  assert.ok(out.length < long.length);
  assert.ok(out.length <= REASONING_TAIL_CHARS + 4);
});

// --- Stable-height reasoning window --------------------------------------
// buildReasoningWindow wraps the visible reasoning text to terminal width
// and keeps only the LAST REASONING_VISIBLE_LINES wrapped lines. This is
// what eliminates the "keep scrolling while thinking" bug: the rendered
// reasoning block has a constant row count, so the Ink frame doesn't
// grow as the model streams more tokens, so the terminal never scrolls.

test('buildReasoningWindow: empty input returns empty string', () => {
  assert.equal(buildReasoningWindow('', 80), '');
});

test('buildReasoningWindow: short input fits in one line', () => {
  const out = buildReasoningWindow('thinking briefly', 80);
  assert.equal(out, 'thinking briefly');
});

test('buildReasoningWindow: caps line count at REASONING_VISIBLE_LINES', () => {
  // Build 20 short lines via newlines.
  const input = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
  const out = buildReasoningWindow(input, 80);
  const outLines = out.split('\n');
  assert.equal(outLines.length, REASONING_VISIBLE_LINES);
  // Window keeps the TAIL — last visible line should be line-20.
  assert.equal(outLines.at(-1), 'line-20');
});

test('buildReasoningWindow: word-wraps long single lines to terminal width', () => {
  // 200-char single "line" of repeated short words, terminal width 40.
  const words = Array.from({ length: 40 }, () => 'word').join(' '); // ~199 chars
  const out = buildReasoningWindow(words, 40);
  for (const line of out.split('\n')) {
    // Each wrapped line must fit within the effective width (cols - 4).
    assert.ok(line.length <= 36, `line too long (${line.length}): ${line}`);
  }
});

test('buildReasoningWindow: total line count never exceeds the cap even for huge inputs', () => {
  const huge = 'sentence here. '.repeat(1000); // ~15000 chars
  const out = buildReasoningWindow(huge, 80);
  assert.ok(out.split('\n').length <= REASONING_VISIBLE_LINES);
});

test('tailReasoning: word-boundary trim avoids mid-word fragment at start', () => {
  // Trim only kicks in when a space appears within the first 80 chars of
  // the tail slice. Build input so the tail slice starts ~20 chars into
  // a word, with the next space comfortably under that 80-char cap.
  // Slice = last REASONING_TAIL_CHARS of input. To trigger trim, a space
  // must appear within the first 80 chars of that slice. Place the space
  // one char past the slice start so firstSpace lands at index 1.
  const input = 'x'.repeat(REASONING_TAIL_CHARS + 1) + ' ' + 'y'.repeat(REASONING_TAIL_CHARS - 1);
  const out = tailReasoning(input);
  assert.ok(out.startsWith('… '));
  // After ellipsis+space, the next char should NOT be 'x' — the leading
  // x-fragment up to the first space should have been dropped.
  assert.ok(!out.startsWith('… x'), `expected word-boundary trim, got: ${out.slice(0, 20)}`);
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

test('captureConsoleOutput: captures legacy slash-command console output and restores console', async () => {
  const originalLog = console.log;
  const captured = await captureConsoleOutput(async () => {
    console.log('Local Workspace Tools:');
    console.warn('  Warning: %s', 'offline');
    return 42;
  });

  assert.equal(captured.result, 42);
  assert.equal(captured.output, 'Local Workspace Tools:\n  Warning: offline\n');
  assert.equal(console.log, originalLog);
});

test('captureConsoleOutput: restores console when wrapped command throws', async () => {
  const originalError = console.error;
  await assert.rejects(
    () => captureConsoleOutput(() => {
      console.error('before failure');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(console.error, originalError);
});
