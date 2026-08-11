import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  runConfluenceConnectorCheckpoint,
  runJiraConnectorCheckpoint,
  runLinearConnectorCheckpoint,
  runNotionConnectorCheckpoint,
  runSlackConnectorCheckpoint,
  confluenceTokenClient,
  jiraTokenClient,
  linearTokenClient,
  notionTokenClient,
  slackTokenClient,
  type ConfluenceConnectorClient,
  type JiraConnectorClient,
  type LinearConnectorClient,
  type NotionConnectorClient,
  type SlackConnectorClient,
} from '../connectors/apiSourceConnectors.js';

function connector(patch: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    id: 'conn_api',
    source: 'slack',
    name: 'API connector',
    status: 'active',
    credential: { mode: 'static', ref: 'TOKEN' },
    flows: ['checkpoint', 'slim'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
    config: { ...(patch.config ?? {}) },
  };
}

test('runSlackConnectorCheckpoint maps messages and threaded replies', async () => {
  const client: SlackConnectorClient = {
    async listChannels() {
      return [{ id: 'C1', name: 'engineering' }];
    },
    async listMessages() {
      return [{
        channelId: 'C1',
        channelName: 'engineering',
        ts: '1767225600.000000',
        user: 'U1',
        text: 'ship connectors',
        replies: [{ channelId: 'C1', ts: '1767225660.000000', user: 'U2', text: 'done' }],
      }];
    },
  };
  const result = await runSlackConnectorCheckpoint(connector({ config: { channels: ['engineering'] } }), client, { now: '2026-01-05T00:00:00.000Z' });
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].source, 'slack');
  assert.equal(result.documents[0].repository, 'engineering');
  assert.match(result.documents[1].text, /done/);
  assert.equal(result.failures.length, 0);
  assert.equal(result.checkpoint.documentCount, 2);
});

test('runSlackConnectorCheckpoint records per-channel failures', async () => {
  const client: SlackConnectorClient = {
    async listChannels() {
      return [{ id: 'C1', name: 'engineering' }];
    },
    async listMessages() {
      throw new Error('history denied');
    },
  };
  const result = await runSlackConnectorCheckpoint(connector(), client);
  assert.deepEqual(result.failures, ['engineering: history denied']);
});

test('runJiraConnectorCheckpoint maps issues and comments', async () => {
  const client: JiraConnectorClient = {
    async listIssues(opts) {
      assert.deepEqual(opts.projects, ['BR']);
      assert.equal(opts.includeComments, true);
      return [{
        key: 'BR-17',
        summary: 'Connector runtime',
        status: 'In Progress',
        updatedAt: '2026-01-02T00:00:00.000Z',
        labels: ['connectors'],
        estimateSeconds: 5_400,
        comments: [{ author: 'A', body: 'Looks good', updatedAt: '2026-01-03T00:00:00.000Z' }],
      }];
    },
  };
  const result = await runJiraConnectorCheckpoint(connector({ source: 'jira', config: { projects: ['BR'], includeComments: true } }), client, { now: '2026-01-05T00:00:00.000Z' });
  assert.equal(result.documents[0].kind, 'issue');
  assert.equal(result.documents[0].repository, 'BR');
  assert.match(result.documents[0].text, /Looks good/);
  assert.equal(result.documents[0].metadata.estimateSeconds, 5_400);
  assert.equal(result.checkpoint.highWatermark, '2026-01-05T00:00:00.000Z');
});

test('runConfluenceConnectorCheckpoint maps pages', async () => {
  const client: ConfluenceConnectorClient = {
    async listPages(opts) {
      assert.deepEqual(opts.spaces, ['ENG']);
      return [{ id: 'p1', title: 'Runbook', space: 'ENG', body: '<p>Deploy steps</p>', updatedAt: '2026-01-03T00:00:00.000Z' }];
    },
  };
  const result = await runConfluenceConnectorCheckpoint(connector({ source: 'confluence', config: { spaces: ['ENG'] } }), client, { now: '2026-01-05T00:00:00.000Z' });
  assert.equal(result.documents[0].id, 'confluence:p1');
  assert.match(result.documents[0].text, /Deploy steps/);
});

test('runNotionConnectorCheckpoint maps pages', async () => {
  const client: NotionConnectorClient = {
    async listPages(opts) {
      assert.deepEqual(opts.databaseIds, ['db1']);
      return [{ id: 'n1', title: 'Spec', parent: 'db1', body: 'Connector spec', updatedAt: '2026-01-03T00:00:00.000Z' }];
    },
  };
  const result = await runNotionConnectorCheckpoint(connector({ source: 'notion', config: { databaseIds: ['db1'], includeComments: true } }), client, { now: '2026-01-05T00:00:00.000Z' });
  assert.equal(result.documents[0].source, 'notion');
  assert.match(result.documents[0].text, /Connector spec/);
});

test('runLinearConnectorCheckpoint maps issues and truncates', async () => {
  const client: LinearConnectorClient = {
    async listIssues(opts) {
      assert.deepEqual(opts.teamKeys, ['ENG']);
      return [
        { id: 'i1', identifier: 'ENG-1', title: 'One', teamKey: 'ENG', updatedAt: '2026-01-02T00:00:00.000Z' },
        { id: 'i2', identifier: 'ENG-2', title: 'Two', teamKey: 'ENG', updatedAt: '2026-01-03T00:00:00.000Z' },
      ];
    },
  };
  const result = await runLinearConnectorCheckpoint(connector({ source: 'linear', config: { teamKeys: ['ENG'] } }), client, { now: '2026-01-05T00:00:00.000Z', maxItems: 1 });
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].id, 'linear:i1');
  assert.deepEqual(result.failures, ['Stopped after 1 Linear issues.']);
});

test('linearTokenClient prefixes server OAuth tokens with Bearer', async () => {
  let auth = '';
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    auth = String((init?.headers as Record<string, string>).Authorization ?? '');
    return Response.json({ data: { issues: { nodes: [] } } });
  };
  await linearTokenClient('oauth-token', { fetchImpl, oauth: true }).listIssues({ teamKeys: [], includeArchived: false, includeComments: false });
  assert.equal(auth, 'Bearer oauth-token');
});

test('jiraTokenClient requests and maps the source time estimate', async () => {
  let requested = '';
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    requested = String(url);
    return Response.json({ issues: [{
      key: 'BR-17',
      fields: {
        summary: 'Estimated work', status: { name: 'In Progress' }, labels: [],
        updated: '2026-01-02T00:00:00.000Z', timeoriginalestimate: 5_400,
      },
    }] });
  };
  const issues = await jiraTokenClient('oauth-token', 'https://example.atlassian.net', { fetchImpl })
    .listIssues({ projects: ['BR'], includeComments: false });
  assert.match(decodeURIComponent(requested), /timeoriginalestimate/);
  assert.equal(issues[0].estimateSeconds, 5_400);
});

test('slackTokenClient sends bearer auth and maps paginated channels/messages', async () => {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    calls.push({ url: href, auth: (init?.headers as Record<string, string>).Authorization });
    if (href.includes('conversations.list')) {
      return Response.json({ ok: true, channels: [{ id: 'C1', name: 'eng' }], response_metadata: { next_cursor: '' } });
    }
    if (href.includes('conversations.replies')) {
      return Response.json({ ok: true, messages: [
        { ts: '1767225600.000000', user: 'U1', text: 'hello', thread_ts: '1767225600.000000' },
        { ts: '1767225660.000000', user: 'U2', text: 'reply', thread_ts: '1767225600.000000' },
      ], response_metadata: { next_cursor: '' } });
    }
    return Response.json({ ok: true, messages: [{ ts: '1767225600.000000', user: 'U1', text: 'hello', reply_count: 1 }], response_metadata: { next_cursor: '' } });
  };
  const client = slackTokenClient('xoxb-token', { fetchImpl });
  const channels = await client.listChannels();
  const messages = await client.listMessages(channels[0], { includeThreads: true });
  assert.equal(channels[0].name, 'eng');
  assert.equal(messages[0].text, 'hello');
  assert.equal(messages[0].replies?.[0].text, 'reply');
  assert.equal(calls[0].auth, 'Bearer xoxb-token');
});

test('confluenceTokenClient maps page body and comments', async () => {
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    if (href.includes('/content/p1/child/comment')) {
      return Response.json({ results: [{
        body: { storage: { value: '<p>ship it</p>' } },
        history: { createdBy: { displayName: 'Reviewer' } },
        version: { when: '2026-01-04T00:00:00.000Z' },
      }] });
    }
    return Response.json({ results: [{
      id: 'p1',
      title: 'Runbook',
      space: { key: 'ENG' },
      body: { storage: { value: '<p>Deploy</p>' } },
      version: { when: '2026-01-03T00:00:00.000Z' },
      _links: { webui: '/wiki/spaces/ENG/pages/p1' },
    }] });
  };
  const client = confluenceTokenClient('token', 'https://example.atlassian.net', { fetchImpl });
  const pages = await client.listPages({ spaces: ['ENG'], includeComments: true });
  assert.equal(pages[0].body, '<p>Deploy</p>');
  assert.equal(pages[0].comments?.[0].body, 'ship it');
  assert.equal(pages[0].comments?.[0].author, 'Reviewer');
});

test('notionTokenClient maps page body blocks and comments', async () => {
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    if (href.includes('/databases/db1/query')) {
      return Response.json({ results: [{
        id: 'n1',
        url: 'https://notion.test/n1',
        last_edited_time: '2026-01-03T00:00:00.000Z',
        parent: { database_id: 'db1' },
        properties: { Name: { title: [{ plain_text: 'Spec' }] } },
      }] });
    }
    if (href.includes('/blocks/n1/children')) {
      return Response.json({ results: [{
        id: 'b1',
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Body text' }] },
      }], has_more: false });
    }
    if (href.includes('/comments')) {
      return Response.json({ results: [{
        rich_text: [{ plain_text: 'Comment text' }],
        created_by: { name: 'Editor' },
        last_edited_time: '2026-01-04T00:00:00.000Z',
      }], has_more: false });
    }
    return Response.json({});
  };
  const client = notionTokenClient('secret_token', { fetchImpl });
  const pages = await client.listPages({ databaseIds: ['db1'], includeComments: true });
  assert.equal(pages[0].title, 'Spec');
  assert.equal(pages[0].body, 'Body text');
  assert.equal(pages[0].comments?.[0].body, 'Comment text');
});

test('API source checkpoints validate connector source', async () => {
  await assert.rejects(
    () => runJiraConnectorCheckpoint(connector({ source: 'slack' }), {} as JiraConnectorClient),
    /not jira/,
  );
});
