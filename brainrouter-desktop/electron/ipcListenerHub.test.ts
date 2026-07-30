import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcListenerHub } from './ipcListenerHub.cjs';

type NativeListener = (event: unknown, payload: unknown) => void;

class FakeIpcSource {
  private readonly listeners = new Map<string, Set<NativeListener>>();
  onCalls = 0;
  removeCalls = 0;

  on(channel: string, listener: NativeListener): void {
    this.onCalls += 1;
    const channelListeners = this.listeners.get(channel) ?? new Set();
    channelListeners.add(listener);
    this.listeners.set(channel, channelListeners);
  }

  removeListener(channel: string, listener: NativeListener): void {
    this.removeCalls += 1;
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener({}, payload);
    }
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

test('many renderer subscribers share one native IPC listener', () => {
  const source = new FakeIpcSource();
  const hub = createIpcListenerHub<number>(source, 'agent-event');
  const received = Array.from({ length: 16 }, () => [] as number[]);
  const unsubscribe = received.map((values) => hub.subscribe((value) => values.push(value)));

  assert.equal(source.listenerCount('agent-event'), 1);
  assert.equal(source.onCalls, 1);

  source.emit('agent-event', 42);
  assert.ok(received.every((values) => values[0] === 42));

  for (const off of unsubscribe.slice(0, -1)) off();
  assert.equal(source.listenerCount('agent-event'), 1);
  assert.equal(source.removeCalls, 0);

  unsubscribe.at(-1)?.();
  assert.equal(source.listenerCount('agent-event'), 0);
  assert.equal(source.removeCalls, 1);
});

test('unsubscribe is idempotent and a later subscriber reattaches once', () => {
  const source = new FakeIpcSource();
  const hub = createIpcListenerHub<string>(source, 'agent-event');
  const first = hub.subscribe(() => {});

  first();
  first();
  assert.equal(source.listenerCount('agent-event'), 0);
  assert.equal(source.removeCalls, 1);

  const received: string[] = [];
  const second = hub.subscribe((value) => received.push(value));
  assert.equal(source.listenerCount('agent-event'), 1);
  assert.equal(source.onCalls, 2);

  source.emit('agent-event', 'ready');
  assert.deepEqual(received, ['ready']);
  second();
  assert.equal(source.listenerCount('agent-event'), 0);
});

test('duplicate callbacks retain independent subscription lifecycles', () => {
  const source = new FakeIpcSource();
  const hub = createIpcListenerHub<string>(source, 'agent-event');
  const received: string[] = [];
  const listener = (value: string) => received.push(value);
  const unsubscribeFirst = hub.subscribe(listener);
  const unsubscribeSecond = hub.subscribe(listener);

  source.emit('agent-event', 'twice');
  assert.deepEqual(received, ['twice', 'twice']);

  unsubscribeFirst();
  source.emit('agent-event', 'once');
  assert.deepEqual(received, ['twice', 'twice', 'once']);
  assert.equal(source.listenerCount('agent-event'), 1);

  unsubscribeSecond();
  assert.equal(source.listenerCount('agent-event'), 0);
});

test('a subscriber may unsubscribe during delivery without skipping peers', () => {
  const source = new FakeIpcSource();
  const hub = createIpcListenerHub<string>(source, 'agent-event');
  const received: string[] = [];
  let unsubscribeFirst = () => {};

  unsubscribeFirst = hub.subscribe((value) => {
    received.push(`first:${value}`);
    unsubscribeFirst();
  });
  const unsubscribeSecond = hub.subscribe((value) => received.push(`second:${value}`));

  source.emit('agent-event', 'one');
  source.emit('agent-event', 'two');

  assert.deepEqual(received, ['first:one', 'second:one', 'second:two']);
  assert.equal(source.listenerCount('agent-event'), 1);
  unsubscribeSecond();
  assert.equal(source.listenerCount('agent-event'), 0);
});
