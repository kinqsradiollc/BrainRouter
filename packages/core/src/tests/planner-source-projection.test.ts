import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectorDocumentRecord } from '@kinqs/brainrouter-types';
import { createConnectorIssueSourceAdapter } from '../planner/connectorIssueAdapter.js';
import { sourceFreshnessFromItems } from '../planner/agentContext.js';

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

  // Freshness is derived from the ITEMS, by the function the turn's context
  // phase calls. `collectFromSources` computed a second one and was retired
  // 2026-08-12 with no caller; asserting against it proved the projection was
  // fresh in a way nothing rendered.
  const [freshness] = sourceFreshnessFromItems(items);
  assert.equal(freshness?.lastFetchedAt, FETCHED, 'freshness reflects ingest time, not projection time');
});

test('connector issue adapter refuses a non-HTTPS source URL', async () => {
  const adapter = createConnectorIssueSourceAdapter(projection([
    issue({ url: 'http://github.example/example/repo/issues/42' }),
  ]));
  assert.deepEqual(await adapter.list(), []);
});

test('connector projection is idempotent — the same documents project the same item', async () => {
  // This asserted through `refreshLocalPlannerFromConnectorIssues`, a
  // device-local sink retired 2026-08-12 with no caller; the projection that
  // runs is the server's. What has to hold either way is that the ADAPTER is a
  // pure function of the documents, so a re-ingest of unchanged issues produces
  // an identical item and gives its sink nothing to write.
  const input = projection([issue()]);
  const first = await createConnectorIssueSourceAdapter(input).list();
  const second = await createConnectorIssueSourceAdapter(input).list();
  assert.equal(first.length, 1);
  assert.deepEqual(second, first);
});
