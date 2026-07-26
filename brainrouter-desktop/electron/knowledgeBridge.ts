/**
 * C3 — account-backed workspace knowledge broker for Desktop.
 *
 * The renderer identifies neither a server nor a Project. The host resolves the
 * active account and maps the checkout's git remote to exactly one accessible
 * Project before every operation. Returned values are explicitly whitelisted:
 * account credentials, backend URLs, git remotes, and local workspace paths
 * never cross the renderer boundary.
 */
import type { QueryHandler } from './hostCore.js';
import { normalizeRepoUrl } from '@kinqs/brainrouter-core/track';
import {
  brainRouterAccountHeaders,
  resolveBrainRouterAccountApi,
  resolveBrainRouterAccountContext,
  timeoutFetch,
  type AccountFetch,
  type BrainRouterAccountContext,
} from './accountIntegration.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1 * 1024 * 1024;
const MAX_PDF_BASE64_CHARS = 4 * Math.ceil((2 * 1024 * 1024) / 3);
const MAX_DOCX_BASE64_CHARS = 4 * Math.ceil((4 * 1024 * 1024) / 3);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

type JsonRecord = Record<string, unknown>;

class KnowledgeInputError extends Error {}

export interface WorkspaceKnowledgeBridgeOptions {
  getConfig(): unknown;
  getRemoteUrl(): string | null | undefined;
  fetchImpl?: AccountFetch;
  resolveAccount?: (
    config: unknown,
    fetchImpl: AccountFetch,
  ) => Promise<BrainRouterAccountContext | null>;
}

interface ResolvedWorkspaceProject {
  account: BrainRouterAccountContext;
  project: { projectId: string; name: string };
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function requireId(value: unknown, field: string): string {
  const id = string(value).trim();
  if (!SAFE_ID.test(id)) throw new KnowledgeInputError(`${field} is invalid.`);
  return id;
}

function requireText(value: unknown, field: string, maxChars: number): string {
  const text = string(value).trim();
  if (!text || text.length > maxChars) throw new KnowledgeInputError(`${field} is invalid.`);
  return text;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function apiError(response: { status: number }): Error {
  if (response.status === 401) return new Error('Sign in again to use Project knowledge.');
  if (response.status === 403) return new Error('Your account cannot access this Project knowledge.');
  if (response.status === 404) return new Error('The Project knowledge resource was not found.');
  if (response.status === 409) return new Error('That Project knowledge resource already exists.');
  if (response.status === 413) return new Error('The selected document is too large.');
  return new Error(`Project knowledge request failed (HTTP ${response.status}).`);
}

async function requestJson(
  fetchImpl: AccountFetch,
  account: BrainRouterAccountContext,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<JsonRecord> {
  const response = await fetchImpl(`${account.baseUrl}${path}`, {
    ...(init?.method ? { method: init.method } : {}),
    headers: brainRouterAccountHeaders(account, init?.body !== undefined),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = record(await response.json().catch(() => ({})));
  if (!response.ok) throw apiError(response);
  return body;
}

function projectView(value: unknown): { projectId: string; name: string } | null {
  const item = record(value);
  const projectId = string(item.projectId).trim();
  if (!SAFE_ID.test(projectId)) return null;
  return { projectId, name: string(item.name, 'Untitled Project').slice(0, 200) };
}

function baseView(value: unknown): JsonRecord | null {
  const item = record(value);
  const baseId = string(item.baseId).trim();
  if (!SAFE_ID.test(baseId)) return null;
  return {
    baseId,
    name: string(item.name).slice(0, 200),
    description: string(item.description).slice(0, 2_000),
    createdAt: string(item.createdAt),
    updatedAt: string(item.updatedAt),
  };
}

function documentView(value: unknown): JsonRecord | null {
  const item = record(value);
  const documentId = string(item.documentId).trim();
  if (!SAFE_ID.test(documentId)) return null;
  return {
    documentId,
    title: string(item.title).slice(0, 500),
    sourceName: string(item.sourceName).slice(0, 500),
    sourceFormat: string(item.sourceFormat),
    origin: string(item.origin, 'source'),
    status: string(item.status),
    statusMessage: nullableString(item.statusMessage),
    parseVersion: number(item.parseVersion),
    createdAt: string(item.createdAt),
    updatedAt: string(item.updatedAt),
    readyAt: nullableString(item.readyAt),
  };
}

function statusView(value: unknown): JsonRecord | null {
  const item = documentView(value);
  if (!item) return null;
  const processing = record(record(value).processing);
  return {
    ...item,
    processing: {
      jobState: string(processing.jobState, 'missing'),
      attempts: number(processing.attempts),
      maxAttempts: number(processing.maxAttempts),
      retryable: boolean(processing.retryable),
      chunkCount: number(processing.chunkCount),
      embeddingCount: number(processing.embeddingCount),
    },
  };
}

function searchView(value: unknown): JsonRecord {
  const source = record(value);
  const hits = Array.isArray(source.hits) ? source.hits : [];
  return {
    mode: string(source.mode, 'lexical'),
    hits: hits.slice(0, 100).map((raw) => {
      const hit = record(raw);
      const citation = record(hit.citation);
      return {
        content: string(hit.content),
        score: number(hit.score),
        matchedBy: Array.isArray(hit.matchedBy)
          ? hit.matchedBy.filter((entry) => entry === 'lexical' || entry === 'vector')
          : [],
        citation: {
          baseId: string(citation.baseId),
          documentId: string(citation.documentId),
          chunkId: string(citation.chunkId),
          documentTitle: string(citation.documentTitle).slice(0, 500),
          sourceName: string(citation.sourceName).slice(0, 500),
          ordinal: number(citation.ordinal),
          charStart: typeof citation.charStart === 'number' ? citation.charStart : null,
          charEnd: typeof citation.charEnd === 'number' ? citation.charEnd : null,
        },
      };
    }),
  };
}

/**
 * Build the complete named-query surface. Keeping project resolution inside
 * this module makes every mutation re-authorize against the active account and
 * current checkout instead of trusting renderer-supplied tenancy identifiers.
 */
export function buildWorkspaceKnowledgeQueries(
  options: WorkspaceKnowledgeBridgeOptions,
): Record<string, QueryHandler> {
  const fetchImpl = options.fetchImpl ?? timeoutFetch;
  const resolveAccount = options.resolveAccount ?? resolveBrainRouterAccountContext;

  const resolveProject = async (): Promise<
    | { ok: true; value: ResolvedWorkspaceProject }
    | { ok: false; result: JsonRecord }
  > => {
    const config = options.getConfig();
    if (!resolveBrainRouterAccountApi(config)) {
      return { ok: false, result: { state: 'signed-out', message: 'Sign in under Settings → Account to use Project knowledge.' } };
    }
    const repoIdentity = normalizeRepoUrl(string(options.getRemoteUrl()));
    if (!repoIdentity) {
      return { ok: false, result: { state: 'no-remote', message: 'Add a git remote before linking this workspace to Project knowledge.' } };
    }
    const account = await resolveAccount(config, fetchImpl);
    if (!account) {
      return { ok: false, result: { state: 'no-org', message: 'No active BrainRouter organization is available.' } };
    }
    const body = await requestJson(
      fetchImpl,
      account,
      `/api/orgs/${encodeURIComponent(account.orgId)}/projects?repo=${encodeURIComponent(repoIdentity)}`,
    );
    const projects = (Array.isArray(body.projects) ? body.projects : [])
      .map(projectView)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (projects.length === 0) {
      return {
        ok: false,
        result: {
          state: 'unlinked',
          message: 'No accessible Project is linked to this workspace repository.',
        },
      };
    }
    if (projects.length > 1) {
      return {
        ok: false,
        result: {
          state: 'ambiguous',
          message: 'More than one accessible Project is linked to this repository. Keep one link before continuing.',
          projects,
        },
      };
    }
    return { ok: true, value: { account, project: projects[0] } };
  };

  const withProject = async (
    operation: (resolved: ResolvedWorkspaceProject) => Promise<JsonRecord>,
  ): Promise<JsonRecord> => {
    try {
      const resolved = await resolveProject();
      if (!resolved.ok) return resolved.result;
      return await operation(resolved.value);
    } catch (error) {
      return {
        state: 'error',
        message: error instanceof KnowledgeInputError
          ? error.message
          : error instanceof Error && /^Project knowledge |^Sign in again|^Your account |^The Project |^That Project |^The selected /.test(error.message)
            ? error.message
            : 'Project knowledge is unavailable. Try again.',
      };
    }
  };

  return {
    'knowledge-workspace': () => withProject(async ({ account, project }) => {
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases`,
      );
      const bases = (Array.isArray(body.bases) ? body.bases : [])
        .map(baseView)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return { state: 'ready', project, bases };
    }),

    'knowledge-base-create': (args) => withProject(async ({ account, project }) => {
      const name = requireText(args.name, 'Knowledge base name', 200);
      const description = string(args.description).trim().slice(0, 2_000);
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases`,
        { method: 'POST', body: { name, ...(description ? { description } : {}) } },
      );
      const base = baseView(body.base);
      if (!base) throw new Error('Knowledge base response was invalid.');
      return { state: 'ready', base };
    }),

    'knowledge-documents': (args) => withProject(async ({ account, project }) => {
      const baseId = requireId(args.baseId, 'baseId');
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases/${encodeURIComponent(baseId)}/documents?limit=200`,
      );
      const documents = (Array.isArray(body.documents) ? body.documents : [])
        .map(documentView)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return { state: 'ready', documents };
    }),

    'knowledge-ingest': (args) => withProject(async ({ account, project }) => {
      const baseId = requireId(args.baseId, 'baseId');
      const title = requireText(args.title, 'title', 500);
      const sourceName = requireText(args.sourceName, 'sourceName', 500);
      const format = string(args.sourceFormat);
      let bodyInput: JsonRecord;
      if (format === 'text' || format === 'markdown' || format === 'html') {
        const content = string(args.content);
        const maxBytes = format === 'html' ? MAX_HTML_BYTES : MAX_TEXT_BYTES;
        if (!content || utf8Bytes(content) > maxBytes) throw new KnowledgeInputError(`${format.toUpperCase()} file is too large.`);
        bodyInput = { title, sourceName, sourceFormat: format, content };
      } else if (format === 'pdf' || format === 'docx') {
        const contentBase64 = string(args.contentBase64);
        const maxChars = format === 'pdf' ? MAX_PDF_BASE64_CHARS : MAX_DOCX_BASE64_CHARS;
        if (!contentBase64 || contentBase64.length > maxChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
          throw new KnowledgeInputError(`${format.toUpperCase()} file encoding is invalid or too large.`);
        }
        bodyInput = { title, sourceName, contentBase64 };
      } else {
        throw new KnowledgeInputError('sourceFormat is invalid.');
      }
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases/${encodeURIComponent(baseId)}/documents/${format === 'pdf' || format === 'docx' ? format : 'text'}`,
        { method: 'POST', body: bodyInput },
      );
      const document = documentView(body.document);
      if (!document) throw new Error('Knowledge document response was invalid.');
      return { state: 'ready', document, created: boolean(body.created) };
    }),

    'knowledge-document-status': (args) => withProject(async ({ account, project }) => {
      const baseId = requireId(args.baseId, 'baseId');
      const documentId = requireId(args.documentId, 'documentId');
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases/${encodeURIComponent(baseId)}/documents/${encodeURIComponent(documentId)}/status`,
      );
      const document = statusView(body.document);
      if (!document) throw new Error('Knowledge status response was invalid.');
      return { state: 'ready', document };
    }),

    'knowledge-document-retry': (args) => withProject(async ({ account, project }) => {
      const baseId = requireId(args.baseId, 'baseId');
      const documentId = requireId(args.documentId, 'documentId');
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/bases/${encodeURIComponent(baseId)}/documents/${encodeURIComponent(documentId)}/retry`,
        { method: 'POST', body: {} },
      );
      const retry = record(body.retry);
      return {
        state: 'ready',
        retry: {
          documentId: string(retry.documentId),
          jobState: string(retry.jobState),
          enqueued: boolean(retry.enqueued),
        },
      };
    }),

    'knowledge-search': (args) => withProject(async ({ account, project }) => {
      const query = requireText(args.query, 'query', 4_000);
      const baseId = args.baseId === undefined || args.baseId === ''
        ? ''
        : requireId(args.baseId, 'baseId');
      const body = await requestJson(
        fetchImpl,
        account,
        `/api/knowledge/projects/${encodeURIComponent(project.projectId)}/search`,
        {
          method: 'POST',
          body: { query, ...(baseId ? { baseIds: [baseId] } : {}), limit: 8 },
        },
      );
      return { state: 'ready', search: searchView(body.search) };
    }),
  };
}
