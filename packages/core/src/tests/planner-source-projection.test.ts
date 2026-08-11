import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConnectorDocumentRecord } from '@kinqs/brainrouter-types';
import {
  createConnectorIssueSourceAdapter,
  refreshLocalPlannerFromConnectorIssues,
} from '../planner/connectorIssueAdapter.js';
import { collectFromSources } from '../planner/sourceAdapter.js';
import { readPlanner } from '../planner/plannerStore.js';

const FETCHED = '2026-08-11T00:00:00.000Z';

function issue(overrides: Partial<ConnectorDocumentRecord> = {}): ConnectorDocumentRecord {
  return {
    id: 'github:example/repo:issue:42',
    connectorId: 'runtime-connector',
    source: 'github',
    kind: 'issue',
    repository: 'example/repo',
    title: '#42 Ship connected planning',
    url: 'https://github.com/example/repo/issues/42',
    updatedAt: '2026-08-10T23:00:00.000Z',
    text: 'Issue body',
    metadata: { state: 'closed', labels: ['blocked: awaiting API'], estimateSeconds: 3_600 },
    firstSeenAt: FETCHED,
    lastSeenAt: FETCHED,
    ...overrides,
  };
}

const projection = (documents: ConnectorDocumentRecord[]) => ({
  connectorId: 'db-connector-1',
  source: 'github' as const,
  sourceLabel: 'GitHub work',
  documents,
});

test('connector issue adapter preserves actionable facts and never infers completion', async () => {
  const adapter = createConnectorIssueSourceAdapter(projection([
    issue(),
    issue({ id: 'github:example/repo:pull:7', kind: 'pull-request' }),
    issue({ id: 'github:example/repo:issue:8', url: undefined }),
  ]));
  const items = await adapter.list();

  assert.equal(items.length, 1, 'only supported actionable issue records project');
  const item = items[0]!;
  assert.equal(item.origin, 'mirrored');
  assert.equal(item.provenance?.sourceId, 'connector:db-connector-1');
  assert.equal(item.provenance?.sourceLabel, 'GitHub work');
  assert.equal(item.provenance?.sourceUrl, 'https://github.com/example/repo/issues/42');
  assert.equal(item.provenance?.fetchedAt, FETCHED);
  assert.equal(item.estimateMinutes, 60);
  assert.equal(item.blockedReason?.value, 'blocked: awaiting API');
  assert.equal(Object.hasOwn(item, 'completed'), false, 'even an explicitly closed source issue does not complete the planner item');

  const collected = await collectFromSources([adapter], [], '2099-01-01T00:00:00.000Z');
  assert.equal(collected.freshness[0]?.lastFetchedAt, FETCHED, 'freshness reflects ingest time, not projection time');
});

test('connector issue adapter refuses a non-HTTPS source URL', async () => {
  const adapter = createConnectorIssueSourceAdapter(projection([
    issue({ url: 'http://github.example/example/repo/issues/42' }),
  ]));
  assert.deepEqual(await adapter.list(), []);
});

test('connector projection is idempotent and never creates source-refresh outbox churn', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'br-planner-source-'));
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const input = projection([issue()]);
    const first = await refreshLocalPlannerFromConnectorIssues('user-1', input);
    const second = await refreshLocalPlannerFromConnectorIssues('user-1', input);
    const state = readPlanner('user-1');

    assert.deepEqual(first, { created: 1, updated: 0, unchanged: 0, skipped: 0 });
    assert.deepEqual(second, { created: 0, updated: 0, unchanged: 1, skipped: 0 });
    assert.equal(Object.keys(state.items).length, 1);
    assert.equal(state.outbox.operations.length, 0, 'source reads never round-trip back through the mutation outbox');
  } finally {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});
