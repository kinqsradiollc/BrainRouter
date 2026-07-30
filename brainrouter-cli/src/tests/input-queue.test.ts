import test from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../runtime/input/inputQueue.js';

test('C2 InputQueue enqueue: ordered, returns id + 1-based position', () => {
  const q = new InputQueue();
  const a = q.enqueue('first');
  const b = q.enqueue('second');
  assert.deepEqual([a.position, b.position], [1, 2]);
  assert.notEqual(a.id, b.id, 'ids are distinct');
  assert.equal(q.size, 2);
  assert.deepEqual(q.list().map((i) => i.text), ['first', 'second']);
});

test('C2 InputQueue list: returns a copy (caller cannot mutate internal state)', () => {
  const q = new InputQueue();
  q.enqueue('x');
  q.list()[0].text = 'tampered';
  assert.equal(q.list()[0].text, 'x', 'internal item unchanged');
});

test('C2 InputQueue dequeue: FIFO', () => {
  const q = new InputQueue();
  q.enqueue('1'); q.enqueue('2'); q.enqueue('3');
  assert.equal(q.dequeue()?.text, '1');
  assert.equal(q.dequeue()?.text, '2');
  assert.equal(q.size, 1);
  assert.equal(new InputQueue().dequeue(), undefined, 'empty → undefined');
});

test('C2 InputQueue removeAt: 1-based, out-of-range is a no-op', () => {
  const q = new InputQueue();
  q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
  assert.equal(q.removeAt(2)?.text, 'b');
  assert.deepEqual(q.list().map((i) => i.text), ['a', 'c']);
  assert.equal(q.removeAt(0), undefined);
  assert.equal(q.removeAt(99), undefined);
  assert.equal(q.size, 2, 'no-op removals left it intact');
});

test('C2 InputQueue removeById + clear', () => {
  const q = new InputQueue();
  const a = q.enqueue('a');
  q.enqueue('b');
  assert.equal(q.removeById(a.id)?.text, 'a');
  assert.equal(q.removeById(a.id), undefined, 'already removed');
  q.enqueue('c');
  assert.equal(q.clear(), 2, 'cleared b + c');
  assert.equal(q.size, 0);
});
