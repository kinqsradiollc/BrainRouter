import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDevMcpHttpUrl } from './mcpInput.js';

test('development MCP input rejects unsafe URL shapes without echoing them', () => {
  const urls = [
    'file:///tmp/server.sock',
    'https://user:password@example.test/mcp',
    'https://example.test/mcp?api_key=query-secret',
    'https://example.test/mcp/token/path-secret',
    'https://example.test/%ZZ/mcp%252ftoken%252fencoded-secret',
    'https://example.test/mcp#fragment-secret',
    'not a URL',
    `https://example.test/${'a'.repeat(17 * 1024)}`,
  ];

  for (const url of urls) {
    const result = validateDevMcpHttpUrl(url);
    assert.equal(result.ok, false, `expected URL to be rejected: ${url.slice(0, 100)}`);
    if (result.ok) continue;
    assert.equal(result.error.includes(url), false);
  }
});

test('development MCP input accepts normalized user-configured local and remote endpoints', () => {
  assert.deepEqual(validateDevMcpHttpUrl(' http://127.0.0.1:3000/mcp '), {
    ok: true,
    url: 'http://127.0.0.1:3000/mcp',
  });
  assert.deepEqual(validateDevMcpHttpUrl('https://mcp.example.test'), {
    ok: true,
    url: 'https://mcp.example.test/',
  });
});
