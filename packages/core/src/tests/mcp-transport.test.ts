/** ADR-021 (0.4.17) — MCP transport validation and trusted-stdio regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMcpHttpHeaders,
  buildStdioTransport,
  validateMcpStdioEnvironment,
} from '../mcp/client/transport.js';

test('MCP HTTP headers normalize authorization case and do not add a second credential', () => {
  assert.deepEqual(buildMcpHttpHeaders({
    headers: { AUTHORIZATION: 'Custom credential', 'X-Project': 'alpha' },
    apiKey: 'fallback-key',
  }), {
    authorization: 'Custom credential',
    'x-project': 'alpha',
  });
  assert.deepEqual(buildMcpHttpHeaders({ apiKey: 'fallback-key' }), {
    authorization: 'Bearer fallback-key',
  });
});

test('MCP HTTP transport rejects invalid headers and API keys without echoing secrets', () => {
  const secret = 'do-not-echo-this-secret';
  const invalid: Array<Parameters<typeof buildMcpHttpHeaders>[0]> = [
    { headers: { 'X-Project': `alpha\r\n${secret}` } },
    { headers: { 'Bad Header': secret } },
    { apiKey: `${secret}\0tail` },
  ];
  for (const config of invalid) {
    assert.throws(
      () => buildMcpHttpHeaders(config),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
  }
});

test('MCP stdio environment rejects invalid entries and preserves multiline values', () => {
  const multiline = '-----BEGIN DATA-----\nline two\n-----END DATA-----';
  assert.deepEqual({ ...validateMcpStdioEnvironment({ SAFE_KEY: multiline }) }, { SAFE_KEY: multiline });
  const invalid: Array<Record<string, string>> = [
    { 'BAD=KEY': 'value' },
    { 'BAD\0KEY': 'value' },
    { SAFE_KEY: 'value\0tail' },
  ];
  for (const configured of invalid) {
    assert.throws(() => validateMcpStdioEnvironment(configured));
  }
});

test('trusted stdio construction preserves arbitrary command arguments', () => {
  const transport = buildStdioTransport({
    type: 'stdio',
    command: 'sh',
    args: ['-c', 'printf trusted-config'],
  });
  const params = (transport as unknown as {
    _serverParams: { command: string; args?: string[] };
  })._serverParams;
  assert.equal(params.command, 'sh');
  assert.deepEqual(params.args, ['-c', 'printf trusted-config']);
});
