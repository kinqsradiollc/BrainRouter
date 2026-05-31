import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, LspFrameParser } from '../runtime/lsp/framing.js';
import { LspClient, type LspTransport } from '../runtime/lsp/client.js';
import { formatLocations, formatHover, formatSymbols, languageIdFor } from '../runtime/lsp/manager.js';

test('CLI-19 framing: encode → Content-Length header; parser handles split + multiple frames', () => {
  const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x' });
  assert.match(frame, /^Content-Length: \d+\r\n\r\n\{/);
  const parser = new LspFrameParser();
  // feed it one byte at a time → still reassembles
  let msgs: unknown[] = [];
  for (const ch of frame) msgs = msgs.concat(parser.push(ch));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: 1, method: 'x' });
  // two frames in one chunk
  const two = encodeFrame({ id: 2 }) + encodeFrame({ id: 3 });
  const got = new LspFrameParser().push(two) as any[];
  assert.deepEqual(got.map((m) => m.id), [2, 3]);
});

function mockTransport() {
  let msgCb: (m: any) => void = () => {};
  let closeCb: () => void = () => {};
  const sent: any[] = [];
  const transport: LspTransport = {
    send: (frame) => { for (const m of new LspFrameParser().push(frame)) sent.push(m); },
    onMessage: (cb) => { msgCb = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: () => {},
  };
  return { transport, sent, reply: (m: any) => msgCb(m), fireClose: () => closeCb() };
}

test('CLI-19 client: initialize handshake (request → result → initialized) + definition correlation', async () => {
  const mt = mockTransport();
  const client = new LspClient(mt.transport, { timeoutMs: 1000 });
  const initP = client.initialize('file:///w');
  const initMsg = mt.sent.find((m) => m.method === 'initialize');
  assert.ok(initMsg, 'initialize request sent');
  mt.reply({ jsonrpc: '2.0', id: initMsg.id, result: { capabilities: {} } });
  await initP;
  assert.ok(mt.sent.some((m) => m.method === 'initialized'), 'initialized notification sent');

  const defP = client.definition('file:///w/a.ts', { line: 0, character: 0 });
  const defMsg = mt.sent.find((m) => m.method === 'textDocument/definition');
  assert.ok(defMsg);
  mt.reply({ jsonrpc: '2.0', id: defMsg.id, result: [{ uri: 'file:///w/b.ts', range: { start: { line: 4, character: 2 } } }] });
  const r = await defP;
  assert.equal(r[0].uri, 'file:///w/b.ts');
});

test('CLI-19 client: request timeout + server-initiated request gets a reply + close rejects pending', async () => {
  const mt = mockTransport();
  const client = new LspClient(mt.transport, { timeoutMs: 40 });
  await assert.rejects(client.hover('file:///w/a.ts', { line: 0, character: 0 }), /timed out/);

  // server → client request must get a (null) reply so the server doesn't block
  mt.reply({ jsonrpc: '2.0', id: 999, method: 'workspace/configuration', params: {} });
  assert.ok(mt.sent.some((m) => m.id === 999 && Object.prototype.hasOwnProperty.call(m, 'result')));

  const p = client.references('file:///w/a.ts', { line: 0, character: 0 });
  mt.fireClose();
  await assert.rejects(p, /closed/);
});

test('CLI-19 formatters: locations / hover / symbols / languageId', () => {
  assert.deepEqual(formatLocations({ uri: 'file:///w/a.ts', range: { start: { line: 0, character: 0 } } }), ['/w/a.ts:1:1']);
  assert.deepEqual(formatLocations([{ targetUri: 'file:///w/b.ts', targetSelectionRange: { start: { line: 9, character: 4 } } }]), ['/w/b.ts:10:5']);
  assert.equal(formatHover({ contents: { kind: 'markdown', value: 'fn foo(): void' } }), 'fn foo(): void');
  assert.equal(formatHover({ contents: 'plain text' }), 'plain text');
  const syms = formatSymbols([{ name: 'Foo', kind: 5, range: { start: { line: 2 } }, children: [{ name: 'bar', kind: 6, range: { start: { line: 3 } } }] }]);
  assert.equal(syms[0], 'class Foo (L3)');
  assert.equal(syms[1], '  method bar (L4)');
  assert.equal(languageIdFor('src/a.ts'), 'typescript');
  assert.equal(languageIdFor('x.py'), 'python');
  assert.equal(languageIdFor('Makefile'), null);
});
