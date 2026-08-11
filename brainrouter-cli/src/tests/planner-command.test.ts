/**
 * ADR-038 D5 — personal-planner command reachability.
 *
 * `/plan` is the durable agent-work plan, while `/planner` is the user-scoped
 * personal planner. These tests exercise the real REPL dispatcher so handler
 * ordering and catalog drift cannot silently make either command unreachable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP_CATEGORIES, SLASH_COMMANDS } from '@kinqs/brainrouter-core/command';
import { addItem, listItems } from '@kinqs/brainrouter-core/planner';
import { updatePlan } from '@kinqs/brainrouter-core/task';
import { localDateKey } from '../cli/commands/planner/index.js';
import { handleSlashCommand } from '../cli/prompt/repl.js';
import { withTempWorkspaceAsync } from './_helpers.js';

async function captureLogs(run: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function dispatch(workspaceRoot: string, command: string, args: string[]): Promise<void> {
  const parameters = {
    agent: { workspaceRoot, sessionKey: 'session:planner-command' },
    mcpClient: {},
    config: {},
    rl: {},
    repl: {
      refreshPromptForMode: () => {},
      isProcessing: () => false,
      runAgentTurn: () => {},
      runAgentTurnAsync: async () => {},
    },
  };
  return handleSlashCommand(
    command,
    args,
    parameters.agent as Parameters<typeof handleSlashCommand>[2],
    parameters.mcpClient as Parameters<typeof handleSlashCommand>[3],
    parameters.config as Parameters<typeof handleSlashCommand>[4],
    parameters.rl as Parameters<typeof handleSlashCommand>[5],
    parameters.repl,
  );
}

test('ADR-038 D5: /planner is catalogued independently from the durable /plan command', () => {
  assert.ok(SLASH_COMMANDS.includes('/plan'), 'durable plan remains in completion');
  assert.ok(SLASH_COMMANDS.includes('/planner'), 'personal planner is in completion');
  const rows = HELP_CATEGORIES.flatMap((category) => category.entries);
  assert.ok(rows.some((entry) => entry.cmd.startsWith('/plan ') && /durable CLI task plan/.test(entry.desc)));
  assert.ok(rows.some((entry) => entry.cmd.startsWith('/planner') && /personal planner/.test(entry.desc)));
});

test('ADR-038 D5: Planner today follows the local calendar rather than UTC', () => {
  const melbourneMorning = {
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 11,
    toISOString: () => '2026-08-10T14:30:00.000Z',
  } as unknown as Date;
  assert.equal(localDateKey(melbourneMorning), '2026-08-11');
});

test('ADR-038 D5: /planner capture, list, and complete route through the Core planner store', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const added = await captureLogs(() => dispatch(workspace, '/planner', ['add', 'Write', 'release', 'notes']));
    assert.match(added, /added .*Write release notes/);

    const [item] = listItems(undefined, { includeCompleted: true });
    assert.ok(item, 'capture persisted an item in the Core planner store');

    const listed = await captureLogs(() => dispatch(workspace, '/planner', ['list']));
    assert.match(listed, /Write release notes/, 'list reads the captured Core planner item');

    const completed = await captureLogs(() => dispatch(workspace, '/planner', ['done', item.id.slice(0, 10)]));
    assert.match(completed, /done\s+Write release notes/);
    assert.equal(listItems(undefined, { includeCompleted: true })[0]?.completed?.value, true);
  });
});

test('ADR-038 D5: /plan retains the durable agent-work plan meaning at the REPL dispatcher', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    updatePlan(workspace, {
      explanation: 'Release work',
      plan: [{ step: 'Run hosted checks', status: 'in_progress' }],
    }, 'session:planner-command');

    const output = await captureLogs(() => dispatch(workspace, '/plan', []));
    assert.match(output, /Plan:/);
    assert.match(output, /Run hosted checks/);
    assert.doesNotMatch(output, /your day, across every project/);
  });
});

test('ADR-038: /planner reports source-owned update/delete refusals instead of success', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const mirrored = addItem(undefined, {
      title: 'Issue owned by source',
      source: 'github',
      externalId: '42',
      sourceUrl: 'https://example.test/issues/42',
    }, Date.now());

    const completed = await captureLogs(() =>
      dispatch(workspace, '/planner', ['done', mirrored.id.slice(0, 10)]));
    assert.match(completed, /not completed/);
    assert.match(completed, /belongs to github/);
    assert.doesNotMatch(completed, /done\s+Issue owned by source/);
    assert.equal(listItems(undefined, { includeCompleted: true })[0]?.completed?.value, undefined);

    const reopened = await captureLogs(() =>
      dispatch(workspace, '/planner', ['reopen', mirrored.id.slice(0, 10)]));
    assert.match(reopened, /not reopened/);
    assert.doesNotMatch(reopened, /^\s*reopened\s*$/m);

    const dated = await captureLogs(() =>
      dispatch(workspace, '/planner', ['due', mirrored.id.slice(0, 10), '2026-08-12']));
    assert.match(dated, /due date unchanged/);
    assert.doesNotMatch(dated, /^\s*due 2026-08-12\s*$/m);
    assert.equal(listItems(undefined, { includeCompleted: true })[0]?.dueDate?.value, undefined);

    const removed = await captureLogs(() =>
      dispatch(workspace, '/planner', ['delete', mirrored.id.slice(0, 10)]));
    assert.match(removed, /not removed/);
    assert.match(removed, /Delete or close it in its source/);
    assert.doesNotMatch(removed, /^\s*removed\s*$/m);
    assert.equal(listItems(undefined, { includeCompleted: true }).length, 1);
  });
});
