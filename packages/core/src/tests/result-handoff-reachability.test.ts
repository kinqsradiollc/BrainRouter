/**
 * A handoff is only a handoff when the model can call `extract_result`.
 *
 * Seen live (session 3cbe409e…:new-4e1b638f…): a workspace tool profile denied
 * `extract_result`, so a 37 KB `docs/architecture.md` came back as an 800-char
 * preview plus `resultRef=res_1sh8j`, the model did as the notice told it, got
 * "denied by the active workspace tool-profile policy", and re-read the same
 * three files fifteen times. The text was in the cache the whole time behind a
 * key nothing in that turn could turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHandoffForModel,
  formatUnexpandableTruncation,
  makeResultHandoff,
} from '../util/result/resultHandoff.js';

const DOC = `${'HEAD '.repeat(400)}${'MIDDLE '.repeat(4000)}${'TAIL '.repeat(400)}`;

test('when the result CAN be expanded, the notice still points at extract_result', () => {
  const { handoff } = makeResultHandoff(DOC, { previewChars: 800 });
  const shown = formatHandoffForModel(handoff, { label: 'read_file' });
  assert.match(shown, /resultRef=/);
  assert.match(shown, /Call extract_result/);
});

test('when it CANNOT, the model is told so, and told what to do instead', () => {
  const shown = formatUnexpandableTruncation(DOC, 1200, { label: 'read_file' });
  assert.ok(!/resultRef=/.test(shown), 'no key is offered for a door that will not open');
  assert.ok(!/Call extract_result/.test(shown), 'never instruct a call the turn will refuse');
  assert.match(shown, /CANNOT be expanded in this workspace/);
  assert.match(shown, /re-running the same call will return this same truncated text/,
    'the sentence that stops the re-read loop');
  assert.match(shown, /Read a narrower range/);
});

test('the truncation keeps the tail — a file\'s status usually lives at its end', () => {
  const shown = formatUnexpandableTruncation(DOC, 1200, { label: 'read_file' });
  assert.ok(shown.startsWith('HEAD'), 'the head survives');
  assert.ok(shown.trimEnd().endsWith('TAIL'), 'and so does the tail');
  assert.ok(!shown.includes('MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE MIDDLE'),
    'the middle is what is spent');
  assert.match(shown, /\d+ of \d+ characters omitted/);
});

test('a result that fits is returned untouched, with no notice at all', () => {
  assert.equal(formatUnexpandableTruncation('small enough', 1200), 'small enough');
});
