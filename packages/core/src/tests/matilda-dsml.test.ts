import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DSML_TOOL_CALL_CLOSE,
  DSML_TOOL_CALL_OPEN,
  createDsmlInterceptor,
  parseDsmlToolCallPayload,
  type DsmlToolCall,
} from '../provider/providers/matilda/dsml.js';

// ADR-058 D13 — the two DSML payload dialects the live Matilda model and its SDK
// use, and the streaming interceptor that lifts them out of the token stream.
const BAR = '｜';
const param = (name: string, value: string) => `<${BAR}DSML${BAR}parameter name="${name}" string="true">${value}</${BAR}DSML${BAR}parameter>`;
const PARAM_BLOCK = `${DSML_TOOL_CALL_OPEN}\n${param('name', 'read_local_file')}\n${param('arguments', '{"path": "/Users/anh/notes.txt"}')}\n${DSML_TOOL_CALL_CLOSE}`;

test('markers use the fullwidth bar (U+FF5C), not ASCII |', () => {
  assert.equal(DSML_TOOL_CALL_OPEN, '<｜DSML｜tool_call>');
  assert.equal(DSML_TOOL_CALL_CLOSE, '</｜DSML｜tool_call>');
});

test('parse: the parameter dialect the live model emits', () => {
  const call = parseDsmlToolCallPayload(`\n${param('name', 'read_local_file')}\n${param('arguments', '{"path": "/x"}')}\n`);
  assert.deepEqual(call, { name: 'read_local_file', arguments: '{"path": "/x"}' });
});

test('parse: the JSON dialect from the SDK contract (arguments or args, optional id)', () => {
  assert.deepEqual(parseDsmlToolCallPayload('{"name":"f","arguments":{"a":1},"id":"c1"}'), { name: 'f', arguments: '{"a":1}', id: 'c1' });
  assert.deepEqual(parseDsmlToolCallPayload('{"name":"f","args":{"a":1}}'), { name: 'f', arguments: '{"a":1}' });
  assert.deepEqual(parseDsmlToolCallPayload('{"name":"f"}'), { name: 'f', arguments: '{}' });
});

test('parse: non-JSON argument text is wrapped so `arguments` is always a JSON document', () => {
  const call = parseDsmlToolCallPayload(param('name', 'echo') + param('arguments', 'hello world'));
  assert.equal(call?.name, 'echo');
  assert.deepEqual(JSON.parse(call!.arguments), { input: 'hello world' });
});

test('parse: garbage yields null (the block stays visible text)', () => {
  assert.equal(parseDsmlToolCallPayload('not a call'), null);
  assert.equal(parseDsmlToolCallPayload('{"nope":1}'), null);
});

function run(chunks: string[], flush = true): { text: string; calls: DsmlToolCall[] } {
  let text = '';
  const calls: DsmlToolCall[] = [];
  const it = createDsmlInterceptor((t) => { text += t; }, (c) => calls.push(c));
  for (const c of chunks) it.push(c);
  if (flush) it.flush();
  return { text, calls };
}

test('interceptor: plain text passes through untouched', () => {
  assert.deepEqual(run(['Hello ', 'world']), { text: 'Hello world', calls: [] });
});

test('interceptor: a block split character-by-character across deltas is lifted out, surrounding text kept', () => {
  const full = `I'll read that file for you.\n\n${PARAM_BLOCK}\nDone.`;
  const out = run([...full]); // one char per delta
  assert.equal(out.text, "I'll read that file for you.\n\n\nDone.");
  assert.deepEqual(out.calls, [{ name: 'read_local_file', arguments: '{"path": "/Users/anh/notes.txt"}' }]);
});

test('interceptor: a partial OPEN marker at a chunk boundary is never leaked as text', () => {
  let text = '';
  const it = createDsmlInterceptor((t) => { text += t; }, () => {});
  it.push('before <｜DS');           // could still become a marker — must be held
  assert.equal(text, 'before ');
  it.push('ML｜tool_call>' + '{"name":"f"}' + DSML_TOOL_CALL_CLOSE + ' after');
  assert.equal(text, 'before  after');
});

test('interceptor: an unterminated block at end of stream is surfaced verbatim, not swallowed', () => {
  const out = run(['x ', DSML_TOOL_CALL_OPEN, '{"name":"f"']);
  assert.equal(out.text, `x ${DSML_TOOL_CALL_OPEN}{"name":"f"`);
  assert.deepEqual(out.calls, []);
});

test('interceptor: two blocks in one stream yield two calls in order', () => {
  const two = `${DSML_TOOL_CALL_OPEN}{"name":"a"}${DSML_TOOL_CALL_CLOSE} mid ${DSML_TOOL_CALL_OPEN}{"name":"b","arguments":{"k":2}}${DSML_TOOL_CALL_CLOSE}`;
  const out = run([two]);
  assert.equal(out.text, ' mid ');
  assert.deepEqual(out.calls.map((c) => c.name), ['a', 'b']);
});

test('interceptor: reset() drops held state (server `replace`)', () => {
  let text = '';
  const it = createDsmlInterceptor((t) => { text += t; }, () => {});
  it.push('partial ' + DSML_TOOL_CALL_OPEN + '{"name":');
  it.reset();
  it.push('fresh');
  it.flush();
  assert.equal(text, 'partial fresh');
});

test('payload: the live single-line dialect with the model\'s own keys (tool/params, no string attr) parses', () => {
  const block = `<${BAR}DSML${BAR}tool_call> <${BAR}DSML${BAR}parameter name="tool">list_dir</${BAR}DSML${BAR}parameter> <${BAR}DSML${BAR}parameter name="params">{"path": "."}</${BAR}DSML${BAR}parameter> </${BAR}DSML${BAR}tool_call>`;
  const calls: Array<{ name: string; arguments: string }> = [];
  let text = '';
  const i = createDsmlInterceptor((t) => { text += t; }, (c) => calls.push(c));
  i.push('Let me start by exploring the codebase:\n\n');
  for (const piece of block.match(/.{1,7}/gs)!) i.push(piece);
  i.flush();
  assert.equal(text, 'Let me start by exploring the codebase:\n\n', 'nothing of the block leaks into visible text');
  assert.deepEqual(calls, [{ name: 'list_dir', arguments: '{"path": "."}' }]);
});

test('payload: name/argument synonyms and bare parameter elements', () => {
  const p = (n: string, v: string) => `<${BAR}DSML${BAR}parameter name="${n}">${v}</${BAR}DSML${BAR}parameter>`;
  assert.deepEqual(parseDsmlToolCallPayload(`${p('function', 'read_file')}${p('input', '{"path":"a"}')}`), { name: 'read_file', arguments: '{"path":"a"}' });
  assert.deepEqual(parseDsmlToolCallPayload(`${p('tool_name', 'grep_search')}${p('parameters', 'not json')}`), { name: 'grep_search', arguments: '{"input":"not json"}' });
  // No argument container: the other parameters ARE the arguments (JSON-typed when they parse).
  assert.deepEqual(parseDsmlToolCallPayload(`${p('tool', 'read_file')}${p('path', 'src/index.ts')}${p('limit', '40')}${p('id', 'c9')}`), { name: 'read_file', arguments: '{"path":"src/index.ts","limit":40}', id: 'c9' });
  assert.deepEqual(parseDsmlToolCallPayload('{"tool":"list_dir","params":{"path":"."}}'), { name: 'list_dir', arguments: '{"path":"."}' });
  assert.equal(parseDsmlToolCallPayload(`${p('params', '{}')}`), null, 'no name under any key → not a call');
});
