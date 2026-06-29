import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHORTCUTS,
  chordToString,
  parseChord,
  chordSignature,
  resolveShortcuts,
  matchChord,
  expandTemplates,
} from '../ui/shortcuts.js';

test('DEFAULT_SHORTCUTS: unique ids and no colliding default bindings', () => {
  const ids = DEFAULT_SHORTCUTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(resolveShortcuts({}).conflicts, [], 'defaults do not collide');
});

test('chordToString: mac glyphs in a stable order', () => {
  assert.equal(chordToString({ key: 'd', meta: true, shift: true }), '⇧⌘D');
  assert.equal(chordToString({ key: '`', ctrl: true }), '⌃`');
  assert.equal(chordToString({ key: 's', meta: true }), '⌘S');
});

test('parseChord: +-form, glyph-form, and invalid input', () => {
  assert.equal(chordSignature(parseChord('Shift+Cmd+D')!), chordSignature({ key: 'd', shift: true, meta: true }));
  assert.equal(chordSignature(parseChord('⇧⌘D')!), chordSignature({ key: 'd', shift: true, meta: true }));
  assert.equal(chordSignature(parseChord('Ctrl+K')!), chordSignature({ key: 'k', ctrl: true }));
  assert.equal(parseChord(''), null);
  assert.equal(parseChord('Cmd'), null, 'modifiers with no key is not a chord');
});

test('parse ∘ stringify round-trips every default binding', () => {
  for (const a of DEFAULT_SHORTCUTS) {
    const round = parseChord(chordToString(a.defaultChord));
    assert.ok(round, `${a.id} re-parses`);
    assert.equal(chordSignature(round!), chordSignature(a.defaultChord), `${a.id} round-trips`);
  }
});

test('resolveShortcuts: valid override applies; invalid/unknown fall back; collisions reported', () => {
  const r = resolveShortcuts({ save: 'Shift+Cmd+S', 'command-palette': 'not a chord', 'no-such-action': 'Cmd+Z' });
  assert.equal(chordSignature(r.bindings.save), chordSignature({ key: 's', shift: true, meta: true }), 'override applied');
  assert.equal(chordSignature(r.bindings['command-palette']), chordSignature({ key: 'k', meta: true }), 'invalid override → default');
  assert.ok(!('no-such-action' in r.bindings), 'unknown action ignored');

  // force a collision: bind new-session onto save's default chord
  const c = resolveShortcuts({ 'new-session': 'Cmd+S' });
  assert.ok(c.conflicts.some(([a, b]) => (a === 'save' && b === 'new-session') || (a === 'new-session' && b === 'save')), 'collision detected');
});

test('matchChord: pressed chord → action id', () => {
  const { bindings } = resolveShortcuts({});
  assert.equal(matchChord({ key: 's', meta: true }, bindings), 'save');
  assert.equal(matchChord({ key: 'D', meta: true, shift: true }, bindings), 'toggle-diff', 'case-insensitive key');
  assert.equal(matchChord({ key: 'z', meta: true }, bindings), null, 'unbound chord → null');
});

test('expandTemplates: date/time tokens + brace escaping', () => {
  const now = new Date(2026, 5, 29, 13, 5); // local 2026-06-29 13:05
  assert.equal(expandTemplates('Today is {date}.', now), 'Today is 2026-06-29.');
  assert.equal(expandTemplates('{time}', now), '13:05');
  assert.equal(expandTemplates('{datetime}', now), '2026-06-29 13:05');
  assert.match(expandTemplates('{iso}', now), /^\d{4}-\d\d-\d\dT\d\d:\d\d/);
  assert.equal(expandTemplates('literal {{date}} stays', now), 'literal {date} stays', 'doubled braces escape');
  assert.equal(expandTemplates('unknown {foo} untouched', now), 'unknown {foo} untouched');
});
