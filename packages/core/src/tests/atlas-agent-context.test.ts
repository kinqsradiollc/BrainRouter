/**
 * ADR-048 — Atlas as agent-visible context: the pure builders + the
 * `atlas_context` tool handler.
 *
 * The builders are pure over the graph and bounded in code (D2): absent/empty
 * graph → "", weak matches gated to "" — the byte-neutrality the taps rely on.
 * The handler test proves the tool's three answers (no map / orientation /
 * lookup) against a real graph file on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtlasGraph } from '@kinqs/brainrouter-types';
import {
  atlasOrientation,
  atlasPromptRetrieval,
  atlasPromptTerms,
} from '../atlas/agentContext.js';
import { saveAtlasGraph } from '../atlas/store/atlasStore.js';
import { readOnlyHandlers } from '../extension/builtin/handlers/readOnly.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function fixtureGraph(over: Partial<AtlasGraph['project']> = {}): AtlasGraph {
  return {
    schemaVersion: 1,
    project: {
      name: 'demo-repo',
      languages: ['typescript'],
      analyzedAt: '2026-08-25T00:00:00.000Z',
      gitCommitHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      totalFiles: 3,
      ...over,
    },
    nodes: [
      { id: 'file:src/memory/recall.ts', type: 'file', name: 'recall.ts', filePath: 'src/memory/recall.ts', summary: 'Ranks and returns memory records for a prompt.', tags: ['memory', 'recall'] },
      { id: 'file:src/server/routes.ts', type: 'file', name: 'routes.ts', filePath: 'src/server/routes.ts', summary: 'HTTP API surface.', tags: ['api'] },
      { id: 'fn:rankRecords', type: 'function', name: 'rankRecords', filePath: 'src/memory/recall.ts', summary: 'Scores candidate records.' },
    ] as AtlasGraph['nodes'],
    edges: [],
    layers: [
      { id: 'layer:memory', name: 'Memory', nodeIds: ['file:src/memory/recall.ts', 'fn:rankRecords'] },
      { id: 'layer:api', name: 'API', nodeIds: ['file:src/server/routes.ts'] },
    ],
    tour: [
      { order: 1, title: 'Start at recall', description: 'The recall pipeline is the heart of the repo.', nodeIds: ['file:src/memory/recall.ts'] },
    ],
  };
}

test('orientation: project + layers + tour, staleness note only when HEAD moved', () => {
  const graph = fixtureGraph();
  const fresh = atlasOrientation(graph, { currentHeadSha: 'aaaaaaaaa' });
  assert.match(fresh, /\[codebase map\] demo-repo — typescript, 3 files mapped\./);
  assert.match(fresh, /Layers: Memory \(2\), API \(1\)\./);
  assert.match(fresh, /Start at recall/);
  assert.doesNotMatch(fresh, /details may be stale/);

  const drifted = atlasOrientation(graph, { currentHeadSha: 'bbbbbbbbbbbbbbbb' });
  assert.match(drifted, /map built at aaaaaaaaa; HEAD is now bbbbbbbbb — details may be stale/);

  // Absent/empty graph → "" (the byte-neutral contract).
  assert.equal(atlasOrientation(null), '');
  assert.equal(atlasOrientation({ ...graph, nodes: [] }), '');
});

test('retrieval: a subsystem prompt matches its nodes; conversational prompts gate to ""', () => {
  const graph = fixtureGraph();
  const hit = atlasPromptRetrieval(graph, 'where does memory recall ranking live?');
  assert.match(hit, /\[codebase map\] Matches for this prompt:/);
  assert.match(hit, /src\/memory\/recall\.ts \(Memory\) — Ranks and returns memory records/);

  // Short/conversational prompts inject nothing.
  assert.equal(atlasPromptRetrieval(graph, 'thanks'), '');
  assert.equal(atlasPromptRetrieval(graph, 'yes go ahead'), '');
  // No strong (name/path/tag) match → gated even with summary-word overlap.
  assert.equal(atlasPromptRetrieval(graph, 'returns something for whatever'), '');
  // Absent graph → "".
  assert.equal(atlasPromptRetrieval(null, 'where does memory recall live?'), '');
});

test('prompt terms: lowercased, stopworded, path-tokens split', () => {
  const terms = atlasPromptTerms('Fix the recall bug in src/memory/recall.ts');
  assert.ok(terms.includes('recall'));
  assert.ok(terms.includes('memory'));
  assert.ok(terms.includes('bug'));
  assert.ok(!terms.includes('the'));
  assert.ok(!terms.includes('fix'));
});

test('atlas_context handler: no map / orientation / lookup', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const handler = readOnlyHandlers.atlas_context!;
    const ctx = (args: Record<string, unknown>) =>
      ({ args, invokedName: 'atlas_context', host: { workspaceRoot: workspace, sessionKey: 's1' } }) as any;

    assert.match(await handler(ctx({})), /No codebase map yet for this workspace — build one with \/atlas\./);

    saveAtlasGraph(workspace, fixtureGraph());
    assert.match(await handler(ctx({})), /\[codebase map\] demo-repo/);
    // An explicit short query is deliberate — no min-length gate for the tool.
    assert.match(await handler(ctx({ query: 'recall' })), /src\/memory\/recall\.ts/);
    assert.match(await handler(ctx({ query: 'zzz-nothing-matches' })), /No map entries match/);
  });
});
