import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  matchesGlobs,
  nodeFsClient,
  runFilesystemConnectorCheckpoint,
  type FilesystemConnectorClient,
  type FilesystemConnectorFileEntry,
} from '../connectors/filesystemConnector.js';

const NUL = String.fromCharCode(0);

function connector(overrides?: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_fs',
    source: 'filesystem',
    name: 'Filesystem',
    status: 'active',
    config: { roots: ['/workspace/docs'] },
    credential: { mode: 'none' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function clientWith(files: FilesystemConnectorFileEntry[], contents: Record<string, string>): FilesystemConnectorClient {
  return {
    async listFiles() {
      return files;
    },
    async readFile(filePath) {
      const content = contents[filePath];
      if (content === undefined) throw new Error(`no content for ${filePath}`);
      return content;
    },
  };
}

test('runFilesystemConnectorCheckpoint maps files to documents and advances the mtime watermark', async () => {
  const client = clientWith(
    [
      { path: 'guide/a.md', mtimeMs: Date.parse('2026-01-02T00:00:00.000Z'), size: 10 },
      { path: 'b.txt', mtimeMs: Date.parse('2026-01-03T00:00:00.000Z'), size: 5 },
    ],
    {
      '/workspace/docs/guide/a.md': '# Guide A',
      '/workspace/docs/b.txt': 'plain notes',
    },
  );

  const result = await runFilesystemConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.id), [
    'filesystem:conn_fs:guide/a.md',
    'filesystem:conn_fs:b.txt',
  ]);
  const [first, second] = result.documents;
  assert.equal(first.kind, 'file');
  assert.equal(first.title, 'guide/a.md');
  assert.equal(first.url, 'file:///workspace/docs/guide/a.md');
  assert.equal(first.updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(first.text, '# Guide A');
  assert.equal(first.repository, '/workspace/docs');
  assert.equal(second.text, 'plain notes');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checkpoint, {
    highWatermark: '2026-01-03T00:00:00.000Z',
    roots: ['/workspace/docs'],
    completedAt: '2026-01-05T00:00:00.000Z',
    documentCount: 2,
    failureCount: 0,
  });
});

test('runFilesystemConnectorCheckpoint only re-emits files with mtime above the previous watermark', async () => {
  const client = clientWith(
    [
      { path: 'a.md', mtimeMs: Date.parse('2026-01-02T00:00:00.000Z'), size: 3 },
      { path: 'b.md', mtimeMs: Date.parse('2026-01-03T00:00:00.000Z'), size: 3 },
    ],
    { '/workspace/docs/a.md': 'old', '/workspace/docs/b.md': 'new' },
  );

  const result = await runFilesystemConnectorCheckpoint(
    connector({ checkpoint: { highWatermark: '2026-01-02T00:00:00.000Z' } }),
    client,
    { now: '2026-01-05T00:00:00.000Z' },
  );

  assert.deepEqual(result.documents.map((doc) => doc.id), ['filesystem:conn_fs:b.md']);
  assert.equal(result.checkpoint.highWatermark, '2026-01-03T00:00:00.000Z');

  const unchanged = await runFilesystemConnectorCheckpoint(
    connector({ checkpoint: { highWatermark: '2026-01-03T00:00:00.000Z' } }),
    client,
    { now: '2026-01-06T00:00:00.000Z' },
  );
  assert.deepEqual(unchanged.documents, []);
  assert.equal(unchanged.checkpoint.highWatermark, '2026-01-03T00:00:00.000Z');
});

test('runFilesystemConnectorCheckpoint applies include and exclude globs at the runtime layer', async () => {
  const mtimeMs = Date.parse('2026-01-02T00:00:00.000Z');
  const client = clientWith(
    [
      { path: 'a.md', mtimeMs, size: 1 },
      { path: 'docs/b.md', mtimeMs, size: 1 },
      { path: 'drafts/c.md', mtimeMs, size: 1 },
      { path: 'img.png', mtimeMs, size: 1 },
      { path: 'src/d.ts', mtimeMs, size: 1 },
    ],
    {
      '/workspace/docs/a.md': 'a',
      '/workspace/docs/docs/b.md': 'b',
      '/workspace/docs/drafts/c.md': 'c',
      '/workspace/docs/img.png': 'p',
      '/workspace/docs/src/d.ts': 'd',
    },
  );

  const result = await runFilesystemConnectorCheckpoint(connector({
    config: { roots: ['/workspace/docs'], includeGlobs: ['**/*.md'], excludeGlobs: ['drafts/**'] },
  }), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.title), ['a.md', 'docs/b.md']);
  assert.deepEqual(result.failures, []);
});

test('runFilesystemConnectorCheckpoint truncates at maxFiles, notes it, and leaves newer files for the next run', async () => {
  const files = [1, 2, 3].map((day) => ({
    path: `f${day}.md`,
    mtimeMs: Date.parse(`2026-01-0${day}T00:00:00.000Z`),
    size: 1,
  }));
  const client = clientWith(files, {
    '/workspace/docs/f1.md': '1',
    '/workspace/docs/f2.md': '2',
    '/workspace/docs/f3.md': '3',
  });

  const result = await runFilesystemConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z', maxFiles: 2 });

  assert.deepEqual(result.documents.map((doc) => doc.title), ['f1.md', 'f2.md']);
  assert.deepEqual(result.failures, ['Truncated at 2 files; 1 changed files were not ingested this run.']);
  assert.equal(result.checkpoint.highWatermark, '2026-01-02T00:00:00.000Z');

  const followUp = await runFilesystemConnectorCheckpoint(
    connector({ checkpoint: result.checkpoint }),
    client,
    { now: '2026-01-06T00:00:00.000Z', maxFiles: 2 },
  );
  assert.deepEqual(followUp.documents.map((doc) => doc.title), ['f3.md']);
  assert.deepEqual(followUp.failures, []);
});

test('runFilesystemConnectorCheckpoint skips binary and oversized files without failing the run', async () => {
  const mtimeMs = Date.parse('2026-01-02T00:00:00.000Z');
  const client = clientWith(
    [
      { path: 'ok.md', mtimeMs, size: 4 },
      { path: 'bin.dat', mtimeMs, size: 8 },
      { path: 'big.txt', mtimeMs, size: 512 * 1024 + 1 },
    ],
    {
      '/workspace/docs/ok.md': 'text',
      '/workspace/docs/bin.dat': `PK${NUL}binary`,
    },
  );

  const result = await runFilesystemConnectorCheckpoint(connector(), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.title), ['ok.md']);
  assert.deepEqual(result.failures, []);
});

test('runFilesystemConnectorCheckpoint records per-file read failures and per-root listing failures', async () => {
  const mtimeMs = Date.parse('2026-01-02T00:00:00.000Z');
  const client: FilesystemConnectorClient = {
    async listFiles(root) {
      if (root === '/broken') throw new Error('permission denied');
      return [
        { path: 'good.md', mtimeMs, size: 1 },
        { path: 'bad.md', mtimeMs, size: 1 },
      ];
    },
    async readFile(filePath) {
      if (filePath.endsWith('bad.md')) throw new Error('read failed');
      return 'ok';
    },
  };

  const result = await runFilesystemConnectorCheckpoint(connector({
    config: { roots: ['/workspace/docs', '/broken'] },
  }), client, { now: '2026-01-05T00:00:00.000Z' });

  assert.deepEqual(result.documents.map((doc) => doc.title), ['good.md']);
  assert.deepEqual(result.failures, ['/broken: permission denied', 'bad.md: read failed']);
  assert.equal(result.checkpoint.failureCount, 2);
});

test('runFilesystemConnectorCheckpoint validates source and roots', async () => {
  const client = {} as FilesystemConnectorClient;
  await assert.rejects(
    () => runFilesystemConnectorCheckpoint(connector({ source: 'slack' as never }), client),
    /not filesystem/,
  );
  await assert.rejects(
    () => runFilesystemConnectorCheckpoint(connector({ config: { roots: [] } }), client),
    /at least one root/,
  );
});

test('matchesGlobs supports ** segments, single-segment *, and exclude precedence', () => {
  assert.equal(matchesGlobs('a.md', [], []), true);
  assert.equal(matchesGlobs('a.md', ['*.md'], []), true);
  assert.equal(matchesGlobs('docs/a.md', ['*.md'], []), false);
  assert.equal(matchesGlobs('docs/a.md', ['**/*.md'], []), true);
  assert.equal(matchesGlobs('a.md', ['**/*.md'], []), true);
  assert.equal(matchesGlobs('src/deep/x.ts', ['src/**'], []), true);
  assert.equal(matchesGlobs('src/x.ts', ['**/*.ts'], ['**/*.test.ts']), true);
  assert.equal(matchesGlobs('src/x.test.ts', ['**/*.ts'], ['**/*.test.ts']), false);
  assert.equal(matchesGlobs('node_modules/pkg/i.js', [], ['node_modules/**']), false);
});

test('nodeFsClient lists files with validation, glob filtering, size caps, and symlink skipping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fs-connector-'));
  try {
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'a.md'), '# A');
    fs.writeFileSync(path.join(dir, 'skip.log'), 'log');
    fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(600 * 1024));
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.symlinkSync(path.join(dir, 'notes'), path.join(dir, 'link'));

    const client = nodeFsClient();
    const entries = await client.listFiles(dir, { includeGlobs: ['**/*.md'], excludeGlobs: ['node_modules/**'] });
    assert.deepEqual(entries.map((entry) => entry.path), ['notes/a.md']);
    assert.equal(entries[0].size, 3);
    assert.equal(typeof entries[0].mtimeMs, 'number');

    assert.equal(await client.readFile(path.join(dir, 'notes', 'a.md')), '# A');
    await assert.rejects(() => client.listFiles('relative/root'), /absolute path/);
    await assert.rejects(() => client.listFiles(path.join(dir, 'missing')), /not an accessible directory/);
    await assert.rejects(() => client.readFile('notes/a.md'), /absolute path/);

    const result = await runFilesystemConnectorCheckpoint(connector({
      config: { roots: [dir], includeGlobs: ['**/*.md'], excludeGlobs: ['node_modules/**'] },
    }), client, { now: '2026-01-05T00:00:00.000Z' });
    assert.deepEqual(result.documents.map((doc) => doc.id), ['filesystem:conn_fs:notes/a.md']);
    assert.equal(result.documents[0].url, `file://${path.join(dir, 'notes', 'a.md')}`);
    assert.deepEqual(result.failures, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
