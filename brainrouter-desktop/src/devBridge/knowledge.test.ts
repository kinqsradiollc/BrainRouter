import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueries } from './queries.js';
import { createDevState } from './state.js';

test('dev bridge exposes populated credential-free Project knowledge', () => {
  const queries = createQueries(createDevState());
  const result = queries['knowledge-workspace']({}) as Record<string, unknown>;
  assert.equal(result.state, 'ready');
  assert.equal((result.project as { name: string }).name, 'BrainRouter');
  assert.equal((result.bases as unknown[]).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Users\/dev|apiKey|Bearer|git@/);
});

test('dev bridge knowledge mutations remain stateful for browser QA', () => {
  const queries = createQueries(createDevState());
  const created = queries['knowledge-base-create']({ name: 'Research notes', description: 'Evidence' }) as {
    base: { baseId: string };
  };
  const workspace = queries['knowledge-workspace']({}) as { bases: Array<{ baseId: string }> };
  assert.ok(workspace.bases.some((base) => base.baseId === created.base.baseId));
  assert.deepEqual(queries['knowledge-documents']({ baseId: created.base.baseId }), {
    state: 'ready',
    documents: [],
  });

  const ingest = queries['knowledge-ingest']({
    baseId: created.base.baseId,
    title: 'Sources',
    sourceName: 'sources.md',
    sourceFormat: 'markdown',
    content: '# Sources',
  }) as { document: { documentId: string; status: string } };
  assert.equal(ingest.document.status, 'queued');
  const listed = queries['knowledge-documents']({ baseId: created.base.baseId }) as {
    documents: Array<{ documentId: string }>;
  };
  assert.deepEqual(listed.documents.map((document) => document.documentId), [ingest.document.documentId]);

  const retry = queries['knowledge-document-retry']({ documentId: 'kdoc_dev_2' }) as {
    retry: { enqueued: boolean };
  };
  assert.equal(retry.retry.enqueued, true);
  const status = queries['knowledge-document-status']({ documentId: 'kdoc_dev_2' }) as {
    document: { status: string; processing: { jobState: string } };
  };
  assert.equal(status.document.status, 'queued');
  assert.equal(status.document.processing.jobState, 'pending');
});

test('dev bridge knowledge search returns a citation-safe preview', () => {
  const queries = createQueries(createDevState());
  const result = queries['knowledge-search']({ query: 'health probes', baseId: 'kb_dev_1' }) as {
    search: { hits: Array<{ content: string; citation: Record<string, unknown> }> };
  };
  assert.equal(result.search.hits.length, 1);
  assert.equal(result.search.hits[0].citation.documentTitle, 'Deployment guide');
  assert.doesNotMatch(JSON.stringify(result), /Users\/dev|path|apiKey|Bearer/);
});
