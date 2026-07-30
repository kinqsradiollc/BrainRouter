import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  gmailTokenClient,
  googleDriveTokenClient,
  runGmailConnectorCheckpoint,
  runGoogleDriveConnectorCheckpoint,
  type GmailConnectorClient,
  type GoogleDriveConnectorClient,
} from '../connectors/sources/googleConnectors.js';

function connector(patch: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    id: 'conn_google',
    source: 'google-drive',
    name: 'Google connector',
    status: 'active',
    credential: { mode: 'static', ref: 'GOOGLE_TOKEN' },
    flows: ['checkpoint', 'slim'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
    config: { ...(patch.config ?? {}) },
  };
}

test('runGoogleDriveConnectorCheckpoint maps files', async () => {
  const client: GoogleDriveConnectorClient = {
    async listFiles(opts) {
      assert.deepEqual(opts.folderIds, ['folder1']);
      assert.equal(opts.includeSheets, true);
      return [{ id: 'f1', name: 'Spec', mimeType: 'text/plain', updatedAt: '2026-01-02T00:00:00.000Z', text: 'Drive body', parents: ['folder1'] }];
    },
  };
  const result = await runGoogleDriveConnectorCheckpoint(connector({ config: { folderIds: ['folder1'] } }), client, { now: '2026-01-03T00:00:00.000Z' });
  assert.equal(result.documents[0].id, 'google-drive:f1');
  assert.match(result.documents[0].text, /Drive body/);
  assert.equal(result.checkpoint.fileCount, 1);
});

test('runGmailConnectorCheckpoint maps messages', async () => {
  const client: GmailConnectorClient = {
    async listMessages(opts) {
      assert.equal(opts.query, 'label:work');
      return [{ id: 'm1', threadId: 't1', subject: 'Hello', from: 'a@example.com', updatedAt: '2026-01-02T00:00:00.000Z', text: 'Message body' }];
    },
  };
  const result = await runGmailConnectorCheckpoint(connector({ source: 'gmail', config: { query: 'label:work' } }), client, { now: '2026-01-03T00:00:00.000Z' });
  assert.equal(result.documents[0].id, 'gmail:m1');
  assert.match(result.documents[0].text, /Message body/);
  assert.equal(result.checkpoint.messageCount, 1);
});

test('googleDriveTokenClient lists files and exports docs', async () => {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    calls.push({ url: href, auth: (init?.headers as Record<string, string>).Authorization });
    if (href.includes('/files/f1/export')) return new Response('Exported doc');
    return Response.json({ files: [{
      id: 'f1',
      name: 'Doc',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-01-02T00:00:00.000Z',
      webViewLink: 'https://docs.google.com/document/d/f1',
      parents: ['folder1'],
    }] });
  };
  const client = googleDriveTokenClient('ya29.token', { fetchImpl });
  const files = await client.listFiles({ folderIds: ['folder1'], includeSheets: true, includeSharedDrives: true });
  assert.equal(files[0].text, 'Exported doc');
  assert.equal(calls[0].auth, 'Bearer ya29.token');
  assert.ok(calls.some((call) => call.url.includes('/files/f1/export')));
});

test('gmailTokenClient lists and decodes message bodies', async () => {
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    if (href.includes('/messages?')) return Response.json({ messages: [{ id: 'm1', threadId: 't1' }] });
    return Response.json({
      id: 'm1',
      threadId: 't1',
      internalDate: '1767225600000',
      snippet: 'Snippet',
      payload: {
        headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'a@example.com' }],
        mimeType: 'text/plain',
        body: { data: Buffer.from('Message body', 'utf8').toString('base64url') },
      },
    });
  };
  const client = gmailTokenClient('ya29.token', { fetchImpl });
  const messages = await client.listMessages({ query: 'label:work' });
  assert.equal(messages[0].subject, 'Hello');
  assert.equal(messages[0].text, 'Message body');
  assert.equal(messages[0].updatedAt, '2026-01-01T00:00:00.000Z');
});

test('Google connector checkpoints validate source', async () => {
  await assert.rejects(
    () => runGmailConnectorCheckpoint(connector({ source: 'google-drive' }), {} as GmailConnectorClient),
    /not gmail/,
  );
});
