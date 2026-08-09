import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactText,
  redactTranscriptEntry,
} from '../session/transcript/sessionStore.js';

const SECRET_CASES: ReadonlyArray<{
  name: string;
  input: string;
  secret: string;
  marker: string;
}> = [
  {
    name: 'bearer authorization',
    input: 'Authorization: Bearer abcDEF123._~-+/==',
    secret: 'abcDEF123._~-+/==',
    marker: '[REDACTED]',
  },
  {
    name: 'basic authorization',
    input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    secret: 'dXNlcjpwYXNzd29yZA==',
    marker: '[REDACTED]',
  },
  {
    name: 'JWT',
    input: 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
    secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
    marker: '[REDACTED_JWT]',
  },
  {
    name: 'cookie header',
    input: 'Set-Cookie: session="correct-horse-battery-staple"; Path=/',
    secret: 'correct-horse-battery-staple',
    marker: 'Cookie: [REDACTED]',
  },
  {
    name: 'BrainRouter token',
    input: 'token br_abcdefgh12345678',
    secret: 'br_abcdefgh12345678',
    marker: '[REDACTED]',
  },
  {
    name: 'OpenAI-style key',
    input: 'token sk-abcdefgh12345678',
    secret: 'sk-abcdefgh12345678',
    marker: '[REDACTED]',
  },
  {
    name: 'Stripe key',
    input: 'token sk_live_abcdefghij123456',
    secret: 'sk_live_abcdefghij123456',
    marker: '[REDACTED]',
  },
  {
    name: 'GitHub token',
    input: 'token ghp_abcdefgh12345678',
    secret: 'ghp_abcdefgh12345678',
    marker: '[REDACTED]',
  },
  {
    name: 'fine-grained GitHub token',
    input: 'token github_pat_abcdefghij1234567890ABCDEFGHIJ',
    secret: 'github_pat_abcdefghij1234567890ABCDEFGHIJ',
    marker: '[REDACTED]',
  },
  {
    name: 'AWS access key',
    input: 'key AKIA1234567890ABCDEF',
    secret: 'AKIA1234567890ABCDEF',
    marker: '[REDACTED]',
  },
  {
    name: 'Google API key',
    input: 'key AIza1234567890abcdefghij',
    secret: 'AIza1234567890abcdefghij',
    marker: '[REDACTED]',
  },
  {
    name: 'Slack token',
    input: 'token xoxb-1234567890-abcdefghijkl',
    secret: 'xoxb-1234567890-abcdefghijkl',
    marker: '[REDACTED]',
  },
  {
    name: 'private key',
    input: '-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----',
    secret: 'secret-key-material',
    marker: '[REDACTED]',
  },
  {
    name: 'database connection string',
    input: 'dsn postgres://service:correct-horse@db.internal:5432/app',
    secret: 'correct-horse',
    marker: '[REDACTED_CONN_STR]',
  },
  {
    name: 'IPv4 address',
    input: 'host 10.20.30.40',
    secret: '10.20.30.40',
    marker: '[REDACTED_IP]',
  },
  {
    name: 'IPv6 address',
    input: 'host 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    secret: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    marker: '[REDACTED_IP]',
  },
  {
    name: 'environment secret assignment',
    input: 'SERVICE_PASSWORD=correct-horse-battery-staple',
    secret: 'correct-horse-battery-staple',
    marker: '[REDACTED]',
  },
];

test('redactText covers the durable secret classes', () => {
  for (const secretCase of SECRET_CASES) {
    const redacted = redactText(secretCase.input);
    assert.ok(
      !redacted.includes(secretCase.secret),
      `${secretCase.name} value must be removed`,
    );
    assert.ok(
      redacted.includes(secretCase.marker),
      `${secretCase.name} must use its redaction marker`,
    );
  }
});

test('redactText preserves ordinary Basic prose and assignment labels', () => {
  assert.equal(redactText('Basic understanding is useful'), 'Basic understanding is useful');
  assert.equal(
    redactText('SERVICE_PASSWORD=correct-horse-battery-staple'),
    'SERVICE_PASSWORD="[REDACTED]"',
  );
  assert.equal(
    redactText('OPENAI_API_KEY="sk-secretvalue123"'),
    'OPENAI_API_KEY="[REDACTED]"',
  );
});

test('redactTranscriptEntry keeps structured JSON valid while removing header and connection secrets', () => {
  const redacted = redactTranscriptEntry({
    role: 'tool',
    content: {
      headers: 'Set-Cookie: session="correct-horse-battery-staple"; Path=/\nContent-Type: text/plain',
      dsn: 'postgres://service:correct-horse@10.20.30.40:5432/app',
      safe: 'keep this value',
    },
    timestamp: '2026-08-09T00:00:00.000Z',
  });

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes('correct-horse'));
  assert.ok(!serialized.includes('10.20.30.40'));
  assert.equal((redacted.content as { safe: string }).safe, 'keep this value');
  assert.ok(serialized.includes('[REDACTED_CONN_STR]'));
  assert.ok(serialized.includes('Cookie: [REDACTED]'));
});
