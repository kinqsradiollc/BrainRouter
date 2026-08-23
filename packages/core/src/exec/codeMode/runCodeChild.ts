/**
 * ADR-041 A41-15 (W3) — the Code Mode child entry.
 *
 * Spawned by `codeModeRunner` as a standalone Node process. It:
 *   - reads the program SOURCE from stdin (so stdout stays the program's own),
 *   - reads the bound tool names from argv[2] (a JSON array),
 *   - speaks the control protocol over the inherited fd 3 (NDJSON): posts `call`,
 *     `heartbeat`, `done`, `error`; receives `result`,
 *   - builds an `agent` object whose `agent.<tool>(args)` / `agent.call(name,args)`
 *     round-trips a `call`→`result` over fd 3,
 *   - runs the source as an async function and reports `done`/`error`.
 *
 * It makes NO security claim about itself — it is a hostile peer; containment is
 * the parent's OS-level budgets + the fact that every tool call is re-authorized
 * on the parent. This file is bundled to dist and executed with `node`.
 */
import fs from 'node:fs';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { encodeLine, createLineFramer, type ResultMessage, type ChildMessage } from './protocol.js';

// Two unidirectional pipes (extra stdio fds are one-way): fd 3 carries child→parent
// (call/heartbeat/done/error), fd 4 carries parent→child (result).
const CONTROL_UP_FD = 3;
const CONTROL_DOWN_FD = 4;

function post(message: ChildMessage): void {
  try {
    fs.writeSync(CONTROL_UP_FD, encodeLine(message));
  } catch {
    /* control channel gone — the parent is tearing us down; nothing to do */
  }
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  stream.setEncoding('utf8');
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

async function main(): Promise<void> {
  let toolNames: string[] = [];
  try {
    const parsed = JSON.parse(process.argv[2] ?? '[]');
    if (Array.isArray(parsed)) toolNames = parsed.map((n) => String(n));
  } catch {
    /* no bindings */
  }

  const source = await readAll(process.stdin);

  // Correlate call→result over fd 3.
  let nextId = 1;
  const pending = new Map<number, { resolve(value: string): void; reject(err: Error): void }>();
  const framer = createLineFramer<ResultMessage>();
  // Read the parent→child pipe as a socket, not a file stream — fs.createReadStream
  // on a pipe fd goes through the libuv threadpool and delivers with high latency;
  // a net.Socket is event-loop-integrated and streams results promptly.
  const control = new net.Socket({ fd: CONTROL_DOWN_FD, readable: true, writable: false });
  control.setEncoding('utf8');
  control.on('data', (chunk: string | Buffer) => {
    for (const message of framer.push(String(chunk)).messages) {
      if (message.t !== 'result') continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.value));
    }
  });
  control.on('error', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('code-mode control channel closed'));
    pending.clear();
  });

  const call = (tool: string, args: Record<string, unknown>): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ t: 'call', id, tool, args: args ?? {} });
    });

  const agent: Record<string, unknown> = { call };
  for (const name of toolNames) {
    if (name === 'call') continue;
    agent[name] = (args: Record<string, unknown> = {}) => call(name, args);
  }

  // Heartbeat: a synchronous busy loop in the program starves this timer, so a
  // missing beat is the parent's signal to kill (the dead-man's-switch).
  const heartbeat = setInterval(() => {
    let activeMs = 0;
    try {
      const elu = performance.eventLoopUtilization?.();
      if (elu && typeof elu.active === 'number') activeMs = elu.active;
    } catch { /* not available on this runtime */ }
    post({ t: 'heartbeat', activeMs });
  }, 100);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as
      new (...args: string[]) => (agent: unknown, console: unknown) => Promise<unknown>;
    const program = new AsyncFunction('agent', 'console', source);
    const result = await program(agent, console);
    clearInterval(heartbeat);
    post({ t: 'done', result: result === undefined ? '' : typeof result === 'string' ? result : safeStringify(result) });
  } catch (err) {
    clearInterval(heartbeat);
    post({ t: 'error', message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  } finally {
    try { control.destroy(); } catch { /* ignore */ }
  }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

void main().then(
  () => process.exit(0),
  (err) => {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
