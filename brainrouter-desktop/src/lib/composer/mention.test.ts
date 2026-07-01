import test from 'node:test';
import assert from 'node:assert/strict';
import { findMentionToken, rankFileMatches, applyMention } from './mention.js';

test('findMentionToken: detects @ at start / after whitespace', () => {
  assert.deepEqual(findMentionToken('@src/ap', 7), { start: 0, query: 'src/ap' });
  assert.deepEqual(findMentionToken('look at @App', 12), { start: 8, query: 'App' });
  assert.deepEqual(findMentionToken('@', 1), { start: 0, query: '' }); // bare @ opens the picker
});

test('findMentionToken: not a mention mid-word (e.g. an email) or after whitespace break', () => {
  assert.equal(findMentionToken('me@example.com', 14), null, 'email @ is not a mention');
  assert.equal(findMentionToken('@foo bar', 8), null, 'caret past a space ends the mention');
  assert.equal(findMentionToken('plain text', 5), null);
});

test('rankFileMatches: basename-prefix > basename-substring > path-substring', () => {
  const files = [
    'src/components/MyApp.tsx', // basename substring (score 1)
    'docs/app-guide.md',        // basename prefix (score 0)
    'app/src/util.ts',          // path substring only (score 2)
    'src/util/zzz.ts',          // no match (dropped)
  ];
  const r = rankFileMatches('app', files);
  assert.equal(r[0], 'docs/app-guide.md', 'basename-prefix ranks first');
  assert.equal(r[1], 'src/components/MyApp.tsx', 'basename-substring next');
  assert.equal(r[2], 'app/src/util.ts', 'path-substring last');
  assert.ok(!r.includes('src/util/zzz.ts'), 'non-matching file dropped');
});

test('rankFileMatches: empty query returns the head; cap respected', () => {
  const files = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
  assert.deepEqual(rankFileMatches('', files, 3), ['f0.md', 'f1.md', 'f2.md']);
  assert.equal(rankFileMatches('f', files, 4).length, 4);
});

test('applyMention: at end of input → path + trailing space, caret after', () => {
  const text = 'see @src/ap';
  const token = findMentionToken(text, text.length)!; // { start: 4, query: 'src/ap' }
  const out = applyMention(text, token, text.length, 'src/App.tsx');
  assert.equal(out.text, 'see src/App.tsx ');
  assert.equal(out.caret, out.text.length);
});

test('applyMention: before existing whitespace → no double space', () => {
  const text = 'see @src/ap and stop';
  const caret = 11; // right after '@src/ap', before the space
  const token = findMentionToken(text, caret)!;
  const out = applyMention(text, token, caret, 'src/App.tsx');
  assert.equal(out.text, 'see src/App.tsx and stop');
  assert.equal(out.text.slice(out.caret), ' and stop');
});
