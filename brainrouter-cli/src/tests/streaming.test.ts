import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { callOpenAIStream } from '../agent/agent.js';
import { extractAtToken, applyAtCompletion, getFileIndex, matchFiles } from '../cli/ink/fileIndex.js';

/**
 * Spin up a tiny TCP server that pretends to be the OpenAI chat-completions
 * endpoint and emits a canned SSE stream. We can then call callOpenAIStream
 * against it and assert it accumulates content + deltas correctly.
 *
 * Using raw `net` (not http) so we have full control over chunk boundaries —
 * SSE parsers tend to break when a delta arrives split across two TCP reads,
 * so we deliberately split mid-JSON to stress the framing logic.
 */
import net from 'node:net';

function makeSseServer(frames: string[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          // Send response head.
          sock.write(
            'HTTP/1.1 200 OK\r\n' +
            'Content-Type: text/event-stream\r\n' +
            'Cache-Control: no-cache\r\n' +
            'Connection: close\r\n' +
            '\r\n',
          );
          // Emit each frame with a tiny inter-frame gap.
          (async () => {
            for (const frame of frames) {
              sock.write(frame);
              await new Promise((r) => setTimeout(r, 1));
            }
            sock.end();
          })();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

test('callOpenAIStream: accumulates text deltas and fires onTextDelta in order', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n',
    // Deliberately split a frame across the TCP write boundary.
    'data: {"choices":[{"delta":',
    '{"content":"world!"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ];
  const server = await makeSseServer(frames);
  const seen: string[] = [];
  try {
    const result = await callOpenAIStream(
      { provider: 'openai', endpoint: server.url, apiKey: 'sk-test', model: 'mock' } as any,
      [{ role: 'user', content: 'hi' }],
      [],
      {},
      {
        onTextDelta: (t) => seen.push(t),
      },
    );
    assert.equal(result.content, 'Hello, world!');
    assert.deepEqual(seen, ['Hel', 'lo, ', 'world!']);
    assert.equal(result.usage?.prompt_tokens, 10);
    assert.equal(result.usage?.completion_tokens, 3);
    assert.equal(result.toolCalls, undefined);
  } finally {
    server.close();
  }
});

test('callOpenAIStream: assembles tool_calls fragmented across frames by index', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"foo.ts\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const server = await makeSseServer(frames);
  try {
    const result = await callOpenAIStream(
      { provider: 'openai', endpoint: server.url, apiKey: 'sk-test', model: 'mock' } as any,
      [{ role: 'user', content: 'read it' }],
      [],
    );
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0].id, 'call_1');
    assert.equal(result.toolCalls?.[0].function.name, 'read_file');
    assert.equal(result.toolCalls?.[0].function.arguments, '{"path":"foo.ts"}');
  } finally {
    server.close();
  }
});

test('extractAtToken: matches trailing @-token, ignores @ followed by space', () => {
  assert.equal(extractAtToken('hello @src/fo'), 'src/fo');
  assert.equal(extractAtToken('@'), '');
  assert.equal(extractAtToken('@src'), 'src');
  assert.equal(extractAtToken('@foo bar'), null);
  assert.equal(extractAtToken('no at sign here'), null);
});

test('applyAtCompletion: replaces trailing @-token with chosen path + trailing space', () => {
  assert.equal(applyAtCompletion('hello @src/fo', 'src/foo.ts'), 'hello @src/foo.ts ');
  assert.equal(applyAtCompletion('@', 'README.md'), '@README.md ');
});

test('matchFiles: ranks exact basename, then starts-with, then path-contains', () => {
  const idx = [
    'src/foo.ts',
    'src/utils/foo-helper.ts',
    'docs/foo.md',
    'foo.ts',
  ];
  const out = matchFiles(idx, 'foo.ts', 8);
  // foo.ts at root is an exact basename match → first.
  assert.equal(out[0], 'foo.ts');
  // src/foo.ts is also exact-basename → second (shorter wins tie via path-length).
  assert.equal(out[1], 'src/foo.ts');
});

test('getFileIndex: enumerates files under a workspace within the cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src/a.ts'), '');
  fs.writeFileSync(path.join(tmp, 'README.md'), '');
  // node_modules should be filtered out.
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'node_modules/lib.js'), '');
  const idx = getFileIndex(tmp);
  assert.ok(idx.includes('README.md'));
  assert.ok(idx.includes(path.join('src', 'a.ts')));
  assert.ok(!idx.some((p) => p.startsWith('node_modules')), 'node_modules filtered');
});
