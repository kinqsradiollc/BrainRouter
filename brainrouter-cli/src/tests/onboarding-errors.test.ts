/** CLI onboarding failures stay useful without becoming a credential or terminal-control sink. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeOnboardingError } from '../cli/commands/init/onboardingErrors.js';

test('workspace onboarding errors redact credential assignments and authorization values', () => {
  const output = safeOnboardingError(
    new Error('probe failed: OPENAI_API_KEY="sk-live-secret"; Authorization: Bearer abc.def.ghi'),
  );
  assert.equal(output.includes('sk-live-secret'), false);
  assert.equal(output.includes('abc.def.ghi'), false);
  assert.match(output, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(output, /Bearer \[REDACTED\]/);
});

test('workspace onboarding errors hide credentialed URLs and known token shapes', () => {
  const output = safeOnboardingError(
    'request to https://person:password@example.test/path failed with ghp_1234567890abcdef',
  );
  assert.equal(output.includes('person'), false);
  assert.equal(output.includes('password'), false);
  assert.equal(output.includes('ghp_1234567890abcdef'), false);
  assert.match(output, /\[URL\]/);
});

test('workspace onboarding errors remove control sequences, collapse lines, and bound output', () => {
  const output = safeOnboardingError(`\u001b[31mfirst\u001b[0m\nsecond\u0000 ${'x'.repeat(1_000)}`);
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.includes('\u0000'), false);
  assert.equal(output.includes('\n'), false);
  assert.equal(output.length, 320);
  assert.match(output, /^first second x+/);
  assert.match(output, /\.\.\.$/);
});

test('workspace onboarding errors fall back when coercion is unsafe or empty', () => {
  const hostile = { toString(): string { throw new Error('do not expose'); } };
  assert.equal(safeOnboardingError(hostile), 'Workspace setup failed.');
  assert.equal(safeOnboardingError('  \n\t '), 'Workspace setup failed.');
});
