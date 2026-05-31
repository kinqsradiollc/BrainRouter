import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHistory, historyPrev, historyNext, LIVE } from '../runtime/inputHistory.js';
import { flagSuggestions, applyFlagCompletion, COMMAND_FLAGS } from '../runtime/slashFlags.js';

// ── inputHistory ───────────────────────────────────────────────────────────

test('INPUT-ERGO appendHistory: trims, skips empty, dedupes consecutive, caps', () => {
  let h: string[] = [];
  h = appendHistory(h, '  hello  ');
  assert.deepEqual(h, ['hello']);
  h = appendHistory(h, '   ');     // empty → ignored
  h = appendHistory(h, 'hello');   // consecutive dup → ignored
  assert.deepEqual(h, ['hello']);
  h = appendHistory(h, 'world');
  assert.deepEqual(h, ['hello', 'world']);
  // cap keeps the newest N
  let capped: string[] = [];
  for (let i = 0; i < 10; i++) capped = appendHistory(capped, `c${i}`, 3);
  assert.deepEqual(capped, ['c7', 'c8', 'c9']);
});

test('INPUT-ERGO historyPrev: LIVE → newest, then older, stops at oldest (no wrap)', () => {
  const h = ['a', 'b', 'c'];
  const m1 = historyPrev(h, LIVE);
  assert.deepEqual(m1, { index: 2, value: 'c' });
  const m2 = historyPrev(h, m1.index);
  assert.deepEqual(m2, { index: 1, value: 'b' });
  const m3 = historyPrev(h, m2.index);
  assert.deepEqual(m3, { index: 0, value: 'a' });
  const m4 = historyPrev(h, m3.index); // already oldest → stay
  assert.deepEqual(m4, { index: 0, value: 'a' });
});

test('INPUT-ERGO historyPrev: empty history is a no-op', () => {
  assert.deepEqual(historyPrev([], LIVE), { index: LIVE, value: null });
});

test('INPUT-ERGO historyNext: walks newer, falls off the end to LIVE + restores draft', () => {
  const h = ['a', 'b', 'c'];
  // from oldest, going newer
  assert.deepEqual(historyNext(h, 0, 'draft'), { index: 1, value: 'b' });
  assert.deepEqual(historyNext(h, 1, 'draft'), { index: 2, value: 'c' });
  // from newest → live draft
  assert.deepEqual(historyNext(h, 2, 'draft'), { index: LIVE, value: 'draft' });
  // from LIVE → no-op
  assert.deepEqual(historyNext(h, LIVE, 'draft'), { index: LIVE, value: null });
});

// ── slashFlags ─────────────────────────────────────────────────────────────

test('INPUT-ERGO flagSuggestions: fires only in args mode on a flag token', () => {
  assert.equal(flagSuggestions('/review'), null);          // command palette, not flags
  assert.equal(flagSuggestions('/review '), null);          // trailing space → nothing partial
  assert.equal(flagSuggestions('/review foo'), null);       // not a flag token
  // "--f" is a prefix of BOTH --fix and --force, so it matches both.
  assert.deepEqual(flagSuggestions('/review --f')!.matches.map((m) => m.flag).sort(), ['--fix', '--force']);
  const s = flagSuggestions('/review --fi');
  assert.ok(s);
  assert.equal(s!.command, '/review');
  assert.equal(s!.token, '--fi');
  assert.deepEqual(s!.matches.map((m) => m.flag), ['--fix']);
});

test('INPUT-ERGO flagSuggestions: bare "--" lists all remaining flags; excludes already-used', () => {
  const all = flagSuggestions('/review --');
  assert.deepEqual(all!.matches.map((m) => m.flag).sort(), ['--fix', '--force']);
  // --fix already present earlier → only --force suggested
  const partial = flagSuggestions('/review --fix --');
  assert.deepEqual(partial!.matches.map((m) => m.flag), ['--force']);
});

test('INPUT-ERGO flagSuggestions: unknown command or no flags → null', () => {
  assert.equal(flagSuggestions('/unknown --x'), null);
  assert.equal(flagSuggestions('plain text --x'), null);
});

test('INPUT-ERGO applyFlagCompletion: replaces the trailing partial token + trailing space', () => {
  assert.equal(applyFlagCompletion('/review --fi', '--fix'), '/review --fix ');
  assert.equal(applyFlagCompletion('/review --fix --fo', '--force'), '/review --fix --force ');
  assert.equal(applyFlagCompletion('/agents create --ow', '--ownership'), '/agents create --ownership ');
});

test('INPUT-ERGO COMMAND_FLAGS: registry is well-formed (every flag starts with - and is unique per cmd)', () => {
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    assert.ok(cmd.startsWith('/'), `command ${cmd} should start with /`);
    const seen = new Set<string>();
    for (const f of flags) {
      assert.ok(f.flag.startsWith('-') && f.desc.length > 0, `${cmd} ${f.flag} must be a --flag with a description`);
      assert.ok(!seen.has(f.flag), `${cmd} has duplicate flag ${f.flag}`);
      seen.add(f.flag);
    }
  }
});
