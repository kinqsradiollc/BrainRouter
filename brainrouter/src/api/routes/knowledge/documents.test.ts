import express from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeActor } from '../../../knowledge/contracts/actor.js';
import type {
  IngestKnowledgeTextInput,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryView,
  KnowledgeDocumentServiceResult,
  KnowledgeDocumentStatusView,
} from '../../../knowledge/contracts/document.js';

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
      if (key === 'br_developer') {
        return { userId: 'developer-1', isAdmin: false, email: 'developer@example.test' };
      }
      return null;
    }),
    tenancy: {
      getDefaultOrgId: mocks.getDefaultOrgId,
      getMemberRole: mocks.getMemberRole,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    knowledge: {},
  },
}));

import { createKnowledgeDocumentsRouter, type KnowledgeDocumentOperations } from './documents.js';

type HttpResult = { status: number; body: unknown };

function requestJson(
  url: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = httpRequest(
      url,
      {
        method,
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

const timestamp = '2026-07-22T01:02:03.000Z';

function document(overrides: Partial<KnowledgeDocumentRecord> = {}): KnowledgeDocumentRecord {
  return {
    documentId: 'kdoc-1',
    baseId: 'kb-1',
    orgId: 'org-a',
    projectId: 'project-a',
    title: 'Architecture notes',
    sourceName: 'architecture.md',
    sourceFormat: 'markdown',
    contentText: 'Internal content that must not leave the service boundary.',
    contentSha256: 'secret-content-hash',
    status: 'queued',
    statusMessage: null,
    parseVersion: 1,
    createdBy: 'developer-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    readyAt: null,
    ...overrides,
  };
}

function statusView(): KnowledgeDocumentStatusView {
  return {
    documentId: 'kdoc-1',
    title: 'Architecture notes',
    sourceName: 'architecture.md',
    sourceFormat: 'markdown',
    status: 'ready',
    statusMessage: null,
    parseVersion: 1,
    updatedAt: timestamp,
    readyAt: timestamp,
    processing: {
      jobState: 'done',
      attempts: 0,
      maxAttempts: 3,
      retryable: true,
      chunkCount: 2,
      embeddingCount: 2,
    },
  };
}

function ok<T>(value: T): KnowledgeDocumentServiceResult<T> {
  return { ok: true, value };
}

describe('knowledge document REST adapter', () => {
  let server: ReturnType<express.Express['listen']> | undefined;
  let baseUrl = '';
  let service: KnowledgeDocumentOperations;
  let ingestText: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let retry: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue('org-a');
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId !== 'org-a') return null;
      if (userId === 'viewer-1') return 'viewer';
      if (userId === 'developer-1') return 'developer';
      return null;
    });

    ingestText = vi.fn().mockResolvedValue(
      ok<KnowledgeDocumentEnqueueResult>({
        document: document(),
        created: true,
        jobId: 'internal-job-id',
      }),
    );
    status = vi.fn().mockResolvedValue(ok(statusView()));
    retry = vi.fn().mockResolvedValue(
      ok<KnowledgeDocumentRetryView>({
        documentId: 'kdoc-1',
        jobState: 'pending',
        enqueued: true,
      }),
    );
    service = { ingestText, status, retry } as KnowledgeDocumentOperations;

    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use('/api/knowledge', createKnowledgeDocumentsRouter(service));
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

  const developerHeaders = {
    Authorization: 'Bearer br_developer',
    'X-BrainRouter-Org': 'org-a',
  };
  const viewerHeaders = {
    Authorization: 'Bearer br_viewer',
    'X-BrainRouter-Org': 'org-a',
  };

  it('rejects unauthenticated and cross-organization requests before the service', async () => {
    const endpoint = `${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/text`;
    const unauthenticated = await requestJson(new URL(endpoint), 'POST', {}, {});
    const foreignOrg = await requestJson(
      new URL(endpoint),
      'POST',
      { Authorization: 'Bearer br_developer', 'X-BrainRouter-Org': 'org-b' },
      {},
    );

    expect(unauthenticated).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    expect(foreignOrg).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(ingestText).not.toHaveBeenCalled();
  });

  it('accepts text ingest using only trusted actor and document input fields', async () => {
    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/text`),
      'POST',
      developerHeaders,
      {
        title: 'Architecture notes',
        sourceName: 'architecture.md',
        sourceFormat: 'markdown',
        content: 'Safe content',
        orgId: 'org-foreign',
        projectId: 'project-foreign',
        baseId: 'kb-foreign',
        userId: 'attacker',
        role: 'owner',
        isSystemAdmin: true,
        createdBy: 'attacker',
        status: 'ready',
        jobId: 'attacker-job',
      },
    );

    expect(response.status).toBe(202);
    expect(ingestText).toHaveBeenCalledWith(
      {
        userId: 'developer-1',
        orgId: 'org-a',
        role: 'developer',
        isSystemAdmin: false,
      } satisfies KnowledgeActor,
      'project-a',
      'kb-1',
      {
        title: 'Architecture notes',
        sourceName: 'architecture.md',
        sourceFormat: 'markdown',
        content: 'Safe content',
      } satisfies IngestKnowledgeTextInput,
    );
    expect(response.body).toEqual({
      document: {
        documentId: 'kdoc-1',
        title: 'Architecture notes',
        sourceName: 'architecture.md',
        sourceFormat: 'markdown',
        status: 'queued',
        statusMessage: null,
        parseVersion: 1,
        updatedAt: timestamp,
        readyAt: null,
      },
      created: true,
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('internal-job-id');
    expect(serialized).not.toContain('secret-content-hash');
    expect(serialized).not.toContain('Internal content');
    expect(serialized).not.toContain('org-a');
    expect(serialized).not.toContain('developer-1');
  });

  it('returns an accepted, content-free view when ingest deduplicates', async () => {
    ingestText.mockResolvedValueOnce(
      ok<KnowledgeDocumentEnqueueResult>({
        document: document({ status: 'ready', readyAt: timestamp }),
        created: false,
        jobId: null,
      }),
    );

    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/text`),
      'POST',
      developerHeaders,
      {
        title: 'Architecture notes',
        sourceName: 'architecture.md',
        sourceFormat: 'markdown',
        content: 'Safe content',
      },
    );

    expect(response).toMatchObject({
      status: 202,
      body: { created: false, document: { documentId: 'kdoc-1', status: 'ready' } },
    });
    expect(JSON.stringify(response.body)).not.toContain('jobId');
  });

  it('lets a viewer read exact-scope status without leaking internal fields', async () => {
    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/kdoc-1/status`),
      'GET',
      viewerHeaders,
    );

    expect(response).toEqual({ status: 200, body: { document: statusView() } });
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer-1', orgId: 'org-a', role: 'viewer' }),
      'project-a',
      'kb-1',
      'kdoc-1',
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('contentText');
    expect(serialized).not.toContain('contentSha256');
    expect(serialized).not.toContain('jobId');
  });

  it('retries the exact route scope and ignores body-based role or scope elevation', async () => {
    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/kdoc-1/retry`),
      'POST',
      developerHeaders,
      {
        orgId: 'org-foreign',
        projectId: 'project-foreign',
        baseId: 'kb-foreign',
        documentId: 'kdoc-foreign',
        role: 'owner',
        jobId: 'generic-job-id',
      },
    );

    expect(response).toEqual({
      status: 202,
      body: { retry: { documentId: 'kdoc-1', jobState: 'pending', enqueued: true } },
    });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'developer-1', orgId: 'org-a', role: 'developer' }),
      'project-a',
      'kb-1',
      'kdoc-1',
    );
    expect(JSON.stringify(response.body)).not.toContain('generic-job-id');
  });

  it('does not let a viewer elevate retry permissions through the request body', async () => {
    retry.mockImplementationOnce(async (actor: KnowledgeActor) =>
      actor.role === 'viewer'
        ? { ok: false, code: 'forbidden' }
        : ok<KnowledgeDocumentRetryView>({
            documentId: 'kdoc-1',
            jobState: 'pending',
            enqueued: true,
          }),
    );

    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/kdoc-1/retry`),
      'POST',
      viewerHeaders,
      { role: 'owner', isSystemAdmin: true },
    );

    expect(response).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'viewer-1', role: 'viewer', isSystemAdmin: false }),
      'project-a',
      'kb-1',
      'kdoc-1',
    );
  });

  it.each([
    [{ ok: false, code: 'not_found' }, 404, 'not_found'],
    [{ ok: false, code: 'forbidden' }, 403, 'forbidden'],
    [{ ok: false, code: 'invalid', field: 'content' }, 400, 'bad_request'],
  ] as const)('maps the %s ingest result to a stable HTTP error', async (failure, code, bodyCode) => {
    ingestText.mockResolvedValueOnce(failure);

    const response = await requestJson(
      new URL(`${baseUrl}/api/knowledge/projects/project-a/bases/kb-1/documents/text`),
      'POST',
      developerHeaders,
      {},
    );

    expect(response).toMatchObject({ status: code, body: { code: bodyCode } });
  });
});
