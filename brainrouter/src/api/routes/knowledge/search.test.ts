import express from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeActor } from '../../../knowledge/contracts/actor.js';
import type {
  KnowledgeSearchResult,
  KnowledgeSearchServiceResult,
  SearchKnowledgeInput,
} from '../../../knowledge/contracts/search.js';

const mocks = vi.hoisted(() => ({
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
  ensurePersonalOrg: vi.fn(),
}));

vi.mock('../../../memory/engine.js', () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => {
      if (key === 'br_viewer') {
        return { userId: 'viewer-1', isAdmin: false, email: 'viewer@example.test' };
      }
      return null;
    }),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    knowledge: {},
    resolveKnowledgeEmbeddingProvider: vi.fn(),
  },
}));

import { createKnowledgeSearchRouter, type KnowledgeSearchOperations } from './search.js';

type HttpResult = { status: number; body: unknown };

function requestJson(
  url: URL,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: encoded
          ? {
              ...headers,
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(encoded)),
            }
          : headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(encoded);
  });
}

const searchResult: KnowledgeSearchResult = {
  mode: 'hybrid',
  hits: [{
    content: 'Rotate the signing key before deploying.',
    score: 0.0325,
    matchedBy: ['lexical', 'vector'],
    citation: {
      projectId: 'project-a',
      baseId: 'kb-1',
      documentId: 'document-1',
      chunkId: 'chunk-1',
      documentTitle: 'Operations guide',
      sourceName: 'operations.md',
      ordinal: 2,
      charStart: 120,
      charEnd: 165,
      locator: { section: 'Deployment' },
    },
  }],
};

function ok<T>(value: T): KnowledgeSearchServiceResult<T> {
  return { ok: true, value };
}

describe('knowledge search REST adapter', () => {
  let server: ReturnType<express.Express['listen']> | undefined;
  let baseUrl = '';
  let search: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue('org-a');
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      orgId === 'org-a' && userId === 'viewer-1' ? 'viewer' : null,
    );
    search = vi.fn().mockResolvedValue(ok(searchResult));

    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/api/knowledge', createKnowledgeSearchRouter({ search } as KnowledgeSearchOperations));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    server = undefined;
  });

  const headers = {
    Authorization: 'Bearer br_viewer',
    'X-BrainRouter-Org': 'org-a',
  };
  const endpoint = () => new URL(`${baseUrl}/api/knowledge/projects/project-a/search`);

  it('rejects unauthenticated and cross-organization requests before search', async () => {
    const unauthenticated = await requestJson(endpoint(), {}, { query: 'signing key' });
    const foreignOrg = await requestJson(
      endpoint(),
      { Authorization: 'Bearer br_viewer', 'X-BrainRouter-Org': 'org-b' },
      { query: 'signing key' },
    );

    expect(unauthenticated).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect(foreignOrg).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(search).not.toHaveBeenCalled();
  });

  it('forwards only trusted actor context and bounded search fields', async () => {
    const response = await requestJson(endpoint(), headers, {
      query: 'signing key',
      baseIds: ['kb-1'],
      limit: 5,
      orgId: 'org-foreign',
      projectId: 'project-foreign',
      userId: 'attacker',
      role: 'owner',
      isSystemAdmin: true,
      embedding: [1, 0, 0],
      embeddingModel: 'attacker-model',
    });

    expect(response).toEqual({ status: 200, body: { search: searchResult } });
    expect(search).toHaveBeenCalledWith(
      {
        userId: 'viewer-1',
        orgId: 'org-a',
        role: 'viewer',
        isSystemAdmin: false,
      } satisfies KnowledgeActor,
      'project-a',
      {
        query: 'signing key',
        baseIds: ['kb-1'],
        limit: 5,
      } satisfies SearchKnowledgeInput,
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('org-a');
    expect(serialized).not.toContain('viewer-1');
    expect(serialized).not.toContain('attacker-model');
  });

  it.each([
    [{ ok: false, code: 'not_found' }, 404, 'not_found'],
    [{ ok: false, code: 'forbidden' }, 403, 'forbidden'],
    [{ ok: false, code: 'invalid', field: 'query' }, 400, 'bad_request'],
    [{ ok: false, code: 'invalid', field: 'baseIds' }, 400, 'bad_request'],
    [{ ok: false, code: 'invalid', field: 'limit' }, 400, 'bad_request'],
  ] as const)('maps the %s result to a stable HTTP error', async (failure, status, bodyCode) => {
    search.mockResolvedValueOnce(failure);

    const response = await requestJson(endpoint(), headers, { query: 'signing key' });

    expect(response).toMatchObject({ status, body: { code: bodyCode } });
    if (failure.code === 'invalid') {
      expect(response).toMatchObject({ body: { details: { field: failure.field } } });
    }
  });
});
