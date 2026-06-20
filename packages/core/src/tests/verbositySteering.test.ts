import test from 'node:test';
import assert from 'node:assert/strict';
import { appendVerbositySteering, VERBOSITY_SENTINEL } from '../prompt/verbositySteering.js';

test('verbosity steering level zero leaves the system prompt byte-for-byte unchanged', () => {
  const prompt = 'base system prompt\n\nrole overlay';
  const result = appendVerbositySteering(prompt, 0);
  assert.strictEqual(result, prompt);
  assert.equal(JSON.stringify(result), JSON.stringify(prompt));
});

test('verbosity steering appends one fixed tail block after overlays', () => {
  const prompt = 'base system prompt\n\nrole overlay';
  const result = appendVerbositySteering(prompt, 3);

  assert.ok(result.startsWith(prompt));
  assert.ok(result.endsWith('</brainrouter-verbosity-steering>'));
  assert.ok(result.includes(VERBOSITY_SENTINEL));
});

test('verbosity steering is idempotent when a prompt is rebuilt', () => {
  const once = appendVerbositySteering('base', 4);
  const twice = appendVerbositySteering(once, 4);
  assert.strictEqual(twice, once);
});
