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
    headers: 'X-Project=alpha\r\nX-Mode=review',
    command: 'sh',
    args: '-c ignored',
    env: 'NODE_OPTIONS=--require=ignored',
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

test('desktop MCP input rejects header and API-key control characters', () => {
  const cases = [
    { headers: { 'X-Project': 'alpha\r\nInjected: yes' } },
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
