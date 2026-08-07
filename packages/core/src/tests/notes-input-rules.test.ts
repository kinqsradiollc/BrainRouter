/**
 * ADR-029 E1 — the line becomes something else as you type it.
 *
 * These are judgements, not mechanics, which is why they are pinned here rather
 * than exercised through a component: whether `C# ` mid-sentence reformats a
 * paragraph, whether `# ` inside a code block makes a heading, whether `--- `
 * on a line with text after the caret eats it. Each of those is a real editor
 * bug with a name, and each is one line of policy in `inputRules.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInputRule, INPUT_RULE_HINTS, undoInputRule } from '../notes/inputRules.js';

const para = (text: string, caret = text.length) =>
  applyInputRule({ kind: 'paragraph' as const, text, caret });

test('the markers E1 names all fire, and consume themselves', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['# ', 'heading', { level: 1 }],
    ['## ', 'heading', { level: 2 }],
    ['### ', 'heading', { level: 3 }],
    ['- ', 'bullet', {}],
    ['* ', 'bullet', {}],
    ['1. ', 'numbered', {}],
    ['[] ', 'todo', { checked: false }],
    ['[x] ', 'todo', { checked: true }],
    ['> ', 'quote', {}],
    ['``` ', 'code', {}],
  ];

  for (const [marker, kind, extra] of cases) {
    const hit = para(`${marker}the rest`, marker.length);
    assert.ok(hit, `${JSON.stringify(marker)} did not fire`);
    assert.equal(hit.kind, kind, marker);
    assert.equal(hit.text, 'the rest', `${marker} must consume its own marker`);
    assert.equal(hit.caret, 0);
    for (const [field, value] of Object.entries(extra)) {
      assert.equal((hit as unknown as Record<string, unknown>)[field], value, `${marker} → ${field}`);
    }
  }
});

test('toggle and callout have markers of their own, because `>` is spoken for', () => {
  // A doubled `>` is unreachable: the single-`>` rule has already fired and
  // consumed the character by the time the second one is typed.
  assert.equal(para('+ fold me', 2)?.kind, 'toggle');
  assert.equal(para('!! watch out', 3)?.kind, 'callout');
});

test('a marker mid-sentence does NOT fire — the classic self-reformatting bug', () => {
  // `# ` must be the entire text before the caret, not a prefix of it.
  assert.equal(applyInputRule({ kind: 'paragraph', text: 'I write C# ', caret: 11 }), null);
  assert.equal(applyInputRule({ kind: 'paragraph', text: 'two - three ', caret: 12 }), null);
});

test('rules never fire inside a code block, where `# ` is a comment', () => {
  assert.equal(applyInputRule({ kind: 'code', text: '# not a heading', caret: 2 }), null);
});

test('a page title is not restyled by a marker, because its text IS the title (E4)', () => {
  assert.equal(applyInputRule({ kind: 'page', text: '# Plan', caret: 2 }), null);
});

test('`--- ` refuses to fire when it would swallow the rest of the line', () => {
  // A divider holds no text, so firing here would silently drop everything
  // after the caret. Refusing is better than eating half a sentence.
  assert.equal(applyInputRule({ kind: 'paragraph', text: '--- and more words', caret: 4 }), null);
  assert.equal(para('--- ', 4)?.kind, 'divider');
});

test('a code fence carries its language through rather than opening a dropdown', () => {
  const hit = para('```ts ', 6);
  assert.equal(hit?.kind, 'code');
  assert.equal(hit?.language, 'ts');
});

test('any starting number begins a numbered list, and the number is thrown away', () => {
  // The ordinal is computed from tree position; a person pasting a list types
  // whatever number they are looking at.
  assert.equal(para('7. seventh', 3)?.kind, 'numbered');
  assert.equal(para('7) seventh', 3)?.kind, 'numbered');
  assert.equal(para('7. seventh', 3)?.text, 'seventh');
});

test('a marker that would not change the block is left alone', () => {
  // `- ` inside a bullet is someone typing a dash. Firing would strip it.
  assert.equal(applyInputRule({ kind: 'bullet', text: '- ', caret: 2 }), null);
  // Same for a heading already at that level — otherwise a person cannot type a
  // literal `#` at the start of their own heading.
  assert.equal(applyInputRule({ kind: 'heading', level: 1, text: '# ', caret: 2 }), null);
});

test('a heading marker at a DIFFERENT level still fires', () => {
  const hit = applyInputRule({ kind: 'heading', level: 1, text: '## smaller', caret: 3 });
  assert.equal(hit?.kind, 'heading');
  assert.equal(hit?.level, 2);
});

test('a rule that just fired can be taken back by the Backspace that follows it', () => {
  // A rule the next keystroke cannot undo has taken the document away from the
  // person who was typing.
  const hit = para('# Heading', 2)!;
  const undone = undoInputRule(hit, 'Heading', 'paragraph');
  assert.equal(undone.kind, 'paragraph');
  assert.equal(undone.text, '# Heading');
  assert.equal(undone.caret, 2);
});

test('the shortcuts panel is fed from the rules themselves, so it cannot lie', () => {
  const ids = INPUT_RULE_HINTS.map((entry) => entry.id);
  assert.ok(ids.includes('heading'));
  assert.ok(ids.includes('todo'));
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rule ids');
});
