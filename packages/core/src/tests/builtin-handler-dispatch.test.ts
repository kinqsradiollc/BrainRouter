// ADR-041 D8 Phase 1 — the builtin-tool handler registry + dispatch shim, proven
// on the planner family (the first tools migrated out of the 66-case switch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';
import {
  builtinToolHandler,
  registeredHandlerNames,
} from '../extension/builtin/handlers/index.js';

const PLANNER = ['planner_today', 'planner_find', 'planner_add', 'planner_schedule', 'planner_complete'];

// The Agent surface the planner tools read: none. A bare object suffices, exactly
// as the other invokeBuiltinToolRuntime tests build their `this`.
const host = () => ({ silent: false, agentDepth: 0, tier: 'chat' });

test('D8 — the planner tools dispatch through the registry, not the switch', () => {
  for (const name of PLANNER) {
    assert.ok(builtinToolHandler(name), `${name} has a registered handler`);
    assert.ok(registeredHandlerNames().has(name), `${name} is in the registered set`);
  }
  // A tool still living in the switch must NOT be in the registry — the registry
  // holds exactly the migrated tools, so the coverage stays partitioned.
  assert.equal(builtinToolHandler('run_command'), undefined, 'run_command is still switch-dispatched');
});

test('D8 — migrated planner tools behave byte-for-byte as before (round-trip + validation)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-planner-'));
  const prev = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const added = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_add', { title: 'ship D8' }));
    assert.equal(typeof added.id, 'string');
    assert.equal(added.title, 'ship D8');

    const found = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_find', { query: 'ship' }));
    assert.ok(found.items.some((i: { id: string }) => i.id === added.id), 'planner_find returns the added item');

    const today = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_today', {}));
    assert.ok(Array.isArray(today.items), 'planner_today returns an items array');
    assert.ok('syncState' in today && 'drift' in today, 'planner_today keeps its summary shape');

    const completed = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_complete', { itemId: added.id }));
    assert.deepEqual(completed, { id: added.id, completed: true });

    // The exact validation errors the switch case threw are preserved verbatim.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host(), 'planner_add', {}), /A title is required/);
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host(), 'planner_schedule', { itemId: 'x', estimateMinutes: 0 }),
      /A positive estimate is required/,
    );
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host(), 'planner_complete', { itemId: 'nope' }),
      /No planner item/,
    );
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
