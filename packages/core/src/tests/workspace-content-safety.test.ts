/**
 * Repository evidence and model-authored instruction
 * drafts share one high-confidence credential detector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { containsWorkspaceSecretMaterial } from '../workspace/workspaceContentSafety.js';

test('workspace content safety detects common credential shapes', () => {
  const credentials = [
    'OPENAI_API_KEY=sk-abcdefghijklmnop',
    'BRAINROUTER_API_KEY=br_abcdefghijklmnop',
    'GITHUB_TOKEN=github_pat_abcdefghijklmnop',
    'SLACK_TOKEN=xoxb-12345678-abcdefghijkl',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'CLIENT_SECRET=abcdefghijklmnop',
    'SESSION_TOKEN=abcdefghijklmnop',
    'GOOGLE_API_KEY=AIzaSyD1234567890abcdefghijklmnop',
    'DATABASE_URL=postgres://user:password@database.example/app',
    'endpoint=https://user:password@example.test/private',
    'token=eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturepart',
    'Authorization: Bearer abcdefghijklmnop',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'callback=https://example.test/?access_token=abcdefghijklmnop',
  ];
  for (const credential of credentials) {
    assert.equal(containsWorkspaceSecretMaterial(credential), true, credential);
  }
});

test('workspace content safety does not reject ordinary instructions or environment references', () => {
  const safe = [
    '# Project instructions\nRun the focused tests before merging.\n',
    'Read the token budget from the configuration.',
    'const token = process.env.ACCESS_TOKEN;',
    'DATABASE_URL=${DATABASE_URL}',
    'API_KEY=<provided by the user>',
    'Authorization is required for protected routes.',
  ];
  for (const content of safe) {
    assert.equal(containsWorkspaceSecretMaterial(content), false, content);
  }
});

test('workspace content safety fails closed for truncated URL userinfo', () => {
  const partialCredential = 'endpoint=https://user:password123';

  assert.equal(containsWorkspaceSecretMaterial(partialCredential), false);
  assert.equal(containsWorkspaceSecretMaterial(partialCredential, { truncated: true }), true);
  assert.equal(containsWorkspaceSecretMaterial('endpoint=https://localhost:3000'), false);
});
