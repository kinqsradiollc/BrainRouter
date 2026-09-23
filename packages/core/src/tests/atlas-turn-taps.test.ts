/**
 * ADR-048 S2/S3/S4/S5 — the codebase-map taps, driven through real turns.
 *
 * §6's bar, verbatim: orientation appears on the FIRST turn of a session (with a
 * drift note when HEAD moved), a subsystem prompt injects its matching nodes, an
 * edit's blast radius follows in the NEXT turn's context, and — the other half —
 * a workspace with no graph (or knobbed-off taps) is byte-neutral: no blocks.
 *
 * Serialized like the other agent-loop tests (process-global fetch + knobs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import { Agent } from '../agent/agent.js';
import { saveAtlasGraph, readAtlasGraph } from '../atlas/store/atlasStore.js';
import { atlasRefreshNeeded, maybeRefreshAtlasInBackground } from '../atlas/autoRefresh.js';
import { setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

let _gate: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = _gate.then(fn, fn);
  _gate = run.then(() => undefined, () => undefined);
  return run;
}

const stubMcp: any = {
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [{ text: '{}' }] }),
  close: async () => {},
};
const cb = { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any;

function fixtureGraph(gitCommitHash?: string): AtlasGraph {
  return {
    schemaVersion: 1,
    project: {
      name: 'demo-repo', languages: ['typescript'],
      analyzedAt: '2026-08-25T00:00:00.000Z', totalFiles: 2,
      ...(gitCommitHash ? { gitCommitHash } : {}),
    },
    nodes: [
      { id: 'file:src/memory/recall.ts', type: 'file', name: 'recall.ts', filePath: 'src/memory/recall.ts', summary: 'Ranks memory records for a prompt.', tags: ['memory', 'recall'] },
      { id: 'file:src/server/routes.ts', type: 'file', name: 'routes.ts', filePath: 'src/server/routes.ts', summary: 'HTTP API surface.', tags: ['api'] },
    ] as AtlasGraph['nodes'],
    edges: [
      { source: 'file:src/server/routes.ts', target: 'file:src/memory/recall.ts', type: 'imports' },
    ] as AtlasGraph['edges'],
    layers: [
      { id: 'layer:memory', name: 'Memory', nodeIds: ['file:src/memory/recall.ts'] },
      { id: 'layer:api', name: 'API', nodeIds: ['file:src/server/routes.ts'] },
    ],
    tour: [],
  };
}

function lastUser(body: any): string {
  const users = (body.messages ?? []).filter((m: any) => m.role === 'user');
  const last = users[users.length - 1];
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
}

function answerOnly(bodies: any[]): typeof fetch {
  return (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}

test('S2+S4 — first turn carries orientation; a subsystem prompt injects its nodes; second turn has no orientation', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    saveAtlasGraph(workspace, fixtureGraph());
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const bodies: any[] = [];
    const of = globalThis.fetch;
    try {
      globalThis.fetch = answerOnly(bodies);
      await agent.runTurn('where does the memory recall ranking live?', cb);
      await agent.runTurn('and where do the api routes live today?', cb);
    } finally { globalThis.fetch = of; }

    const turn1 = bodies.find((b) => lastUser(b).startsWith('where does the memory'));
    const turn2 = bodies.find((b) => lastUser(b).startsWith('and where do the api'));
    assert.ok(turn1 && turn2, 'both chat requests captured');
    // S2 — orientation once, on the first turn only.
    assert.match(lastUser(turn1), /\[codebase map\] demo-repo — typescript, 2 files mapped\./);
    assert.doesNotMatch(lastUser(turn2), /files mapped\./);
    // S4 — retrieval on BOTH turns, matching each prompt's own terms.
    assert.match(lastUser(turn1), /src\/memory\/recall\.ts \(Memory\)/);
    assert.match(lastUser(turn2), /src\/server\/routes\.ts \(API\)/);
  }));
});

test('byte-neutral — no graph injects nothing; knobbed-off taps inject nothing', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    const bodies: any[] = [];
    const of = globalThis.fetch;
    try {
      globalThis.fetch = answerOnly(bodies);
      // No graph at all.
      const bare = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: false,
      });
      await bare.runTurn('where does the memory recall ranking live?', cb);
      // Graph present but every tap knobbed off.
      saveAtlasGraph(workspace, fixtureGraph());
      setCliKnobOverride({ atlas: { orient: false, retrieval: false, autoRefresh: false } });
      const knobbed = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace, launchCwd: workspace, silent: false,
      });
      await knobbed.runTurn('where does the memory recall ranking live?', cb);
    } finally {
      globalThis.fetch = of;
      _resetCliKnobsCache();
    }
    for (const b of bodies) {
      assert.doesNotMatch(lastUser(b), /\[codebase map\]/);
    }
  }));
});

test('S5 — an edit to a mapped file puts its blast radius into the NEXT turn context', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    saveAtlasGraph(workspace, fixtureGraph());
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const bodies: any[] = [];
    let editServed = false;
    const of = globalThis.fetch;
    try {
      // Serve the write_file tool call ONLY to the real chat request for turn 1
      // (matched by its own prompt text) — auxiliary calls (the next-action
      // planner, titles) get plain answers, or they would eat the tool call.
      globalThis.fetch = (async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const isEditTurn = lastUser(body).startsWith('please edit the recall file');
        if (isEditTurn && !editServed) {
          editServed = true;
          return new Response(JSON.stringify({
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/memory/recall.ts', content: '// x' }) } }] } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'edited' } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as any;
      await agent.runTurn('please edit the recall file', cb);
      await agent.runTurn('what next?', cb);
    } finally { globalThis.fetch = of; }

    const turn2 = bodies.find((b) => lastUser(b).includes('what next?'));
    assert.ok(turn2, 'turn 2 captured');
    // The stop-context channel carried the change-impact block for the edit.
    assert.match(lastUser(turn2), /\[stop-hook context\]/);
    assert.match(lastUser(turn2), /recall\.ts/);
  }));
});

test('S3 — refresh predicate + a real background rebuild lands a fresh gitCommitHash', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    // Pure predicate.
    assert.equal(atlasRefreshNeeded(null, 'abc'), false);
    assert.equal(atlasRefreshNeeded(fixtureGraph(), 'abc'), false); // no built sha
    assert.equal(atlasRefreshNeeded(fixtureGraph('aaaa'), 'aaaa1111'), false); // prefix = same
    assert.equal(atlasRefreshNeeded(fixtureGraph('aaaa'), 'bbbb'), true);

    // Real rebuild: a git repo whose HEAD moved past the graph's build sha.
    const git = (...a: string[]) => execFileSync('git', ['-C', workspace, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    execFileSync('bash', ['-c', `mkdir -p ${workspace}/src && echo 'export function a(){}' > ${workspace}/src/a.ts`]);
    git('add', '.'); git('commit', '-qm', 'one');
    saveAtlasGraph(workspace, fixtureGraph('0000000000000000000000000000000000000000'));

    const scheduled = maybeRefreshAtlasInBackground(workspace);
    assert.equal(scheduled, true);
    // A second call while (or after) the first is debounced for this HEAD.
    assert.equal(maybeRefreshAtlasInBackground(workspace), false);
    await new Promise((r) => setTimeout(r, 400)); // let the setImmediate build land
    const refreshed = readAtlasGraph(workspace);
    assert.ok(refreshed, 'refreshed graph saved');
    assert.notEqual(refreshed!.project.gitCommitHash, '0000000000000000000000000000000000000000');
  }));
});
