/** ADR-021 (0.4.17) — renderer MCP input capability-boundary regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopMcpAddInput } from './desktopMcpInput.js';

test('desktop MCP input rejects renderer-controlled stdio execution', () => {
  const result = parseDesktopMcpAddInput({
    id: 'local-tools',
    type: 'stdio',
    command: 'sh',
    args: '-c arbitrary-command',
    env: 'TOKEN=secret',
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'Desktop can add remote HTTP MCP servers only. Configure local stdio servers with brainrouter config.',
  });
  assert.equal(parseDesktopMcpAddInput({ id: 'local-tools' }).ok, false);
});

test('desktop MCP input accepts a bounded HTTP profile', () => {
  const result = parseDesktopMcpAddInput({
    id: 'remote-tools',
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    apiKey: 'test-key',
    headers: 'X-Project=alpha\nX-Mode=review',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.id, 'remote-tools');
  assert.deepEqual({ ...result.config, headers: { ...result.config.headers } }, {
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    apiKey: 'test-key',
    headers: { 'X-Project': 'alpha', 'X-Mode': 'review' },
  });
});

test('desktop MCP input rejects execution and unknown fields on HTTP requests', () => {
  for (const extra of [
    { command: 'sh' },
    { args: ['-c', 'arbitrary-command'] },
    { env: { NODE_OPTIONS: '--require=arbitrary-module' } },
    { unexpected: true },
  ]) {
    const result = parseDesktopMcpAddInput({
      id: 'remote-tools',
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      ...extra,
    });
    assert.deepEqual(result, {
      ok: false,
      error: 'The MCP server request contains unsupported fields.',
    });
  }
});

test('desktop MCP input validates and normalizes the URL before returning config', () => {
  const unsafeUrls = [
    'file:///tmp/server.sock',
    'https://user:password@example.test/mcp',
    'https://example.test/mcp?api_key=query-secret-value',
    'https://example.test/mcp/token/path-secret-value',
    'https://example.test/mcp#fragment-secret-value',
    'not a URL',
    `https://example.test/${'a'.repeat(17 * 1024)}`,
  ];

  for (const url of unsafeUrls) {
    const result = parseDesktopMcpAddInput({ id: 'remote-tools', type: 'http', url });
    assert.equal(result.ok, false, `expected URL to be rejected: ${url.slice(0, 100)}`);
  }

  const safe = parseDesktopMcpAddInput({
    id: 'local-tools',
    type: 'http',
    url: ' http://127.0.0.1:3000/mcp ',
  });
  assert.equal(safe.ok, true);
  if (!safe.ok) return;
  assert.equal(safe.config.url, 'http://127.0.0.1:3000/mcp');
});

test('desktop MCP input rejects header and API-key control characters', () => {
  const cases = [
    { headers: { 'X-Project': 'alpha\r\nInjected: yes' } },
    { headers: 'X-Project=alpha\r\nInjected=yes' },
    { headers: { 'Bad:Name': 'alpha' } },
    { headers: { 'X-Project': 'alpha\0omega' } },
    { apiKey: 'token\r\nInjected: yes' },
  ];

  for (const extra of cases) {
    const result = parseDesktopMcpAddInput({
      id: 'remote-tools',
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      ...extra,
    });
    assert.equal(result.ok, false);
  }
});

test('desktop MCP input bounds and de-duplicates headers', () => {
  const tooManyHeaders = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`X-${index}`, 'value']),
  );
  const duplicate = parseDesktopMcpAddInput({
    id: 'remote-tools',
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: 'X-Project=alpha\nx-project=beta',
  });
  const oversized = parseDesktopMcpAddInput({
    id: 'remote-tools',
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: tooManyHeaders,
  });

  assert.equal(duplicate.ok, false);
  assert.equal(oversized.ok, false);
});
