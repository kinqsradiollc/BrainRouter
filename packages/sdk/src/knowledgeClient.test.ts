import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BrainRouterClient } from "./client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "Content-Type": "application/json" },
  });
}

function installResponseQueue(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    assert.ok(next, "unexpected fetch call");
    return next;
  }) as typeof fetch;
  return calls;
}

test("knowledge base CRUD uses encoded Project scope and trusted client headers", async () => {
  const base = {
    baseId: "base two",
    projectId: "project/one",
    name: "Architecture",
    description: "Project decisions",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const calls = installResponseQueue([
    response({ bases: [base] }),
    response({ base }, 201),
    response({ base }),
    response({ base: { ...base, name: "System design" } }),
    response(undefined, 204),
  ]);
  const client = new BrainRouterClient("https://brain.example", "", "access-token")
    .withActiveOrg("org-a");

  assert.deepEqual(await client.listKnowledgeBases("project/one"), { bases: [base] });
  await client.createKnowledgeBase("project/one", {
    name: "Architecture",
    description: "Project decisions",
  });
  await client.getKnowledgeBase("project/one", "base two");
  await client.updateKnowledgeBase("project/one", "base two", { name: "System design" });
  assert.equal(await client.deleteKnowledgeBase("project/one", "base two"), undefined);

  assert.deepEqual(
    calls.map(({ url, init }) => [init.method, url]),
    [
      ["GET", "https://brain.example/api/knowledge/projects/project%2Fone/bases"],
      ["POST", "https://brain.example/api/knowledge/projects/project%2Fone/bases"],
      ["GET", "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two"],
      ["PATCH", "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two"],
      ["DELETE", "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two"],
    ],
  );
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer access-token");
    assert.equal(headers.get("X-BrainRouter-Org"), "org-a");
  }
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    name: "Architecture",
    description: "Project decisions",
  });
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { name: "System design" });
});

test("knowledge document and search methods preserve wire fields and filter scope", async () => {
  const enqueue = {
    document: {
      documentId: "doc#1",
      title: "Guide",
      sourceName: "guide.md",
      sourceFormat: "markdown",
      status: "queued",
      statusMessage: null,
      parseVersion: 1,
      updatedAt: "2026-07-26T00:00:00.000Z",
      readyAt: null,
    },
    created: true,
  };
  const calls = installResponseQueue([
    response({ documents: [] }),
    response(enqueue, 202),
    response(enqueue, 202),
    response(enqueue, 202),
    response({ document: { ...enqueue.document, processing: {
      jobState: "pending",
      attempts: 0,
      maxAttempts: 3,
      retryable: false,
      chunkCount: 0,
      embeddingCount: 0,
    } } }),
    response({ retry: { documentId: "doc#1", jobState: "pending", enqueued: true } }, 202),
    response({ search: { mode: "lexical", hits: [] } }),
  ]);
  const client = new BrainRouterClient("https://brain.example", "api-key");

  await client.listKnowledgeDocuments("project/one", "base two", {
    status: "ready",
    origin: "source",
    limit: 25,
  });
  await client.ingestKnowledgeText("project/one", "base two", {
    title: "Guide",
    sourceName: "guide.md",
    sourceFormat: "markdown",
    content: "# Guide",
  });
  await client.ingestKnowledgePdf("project/one", "base two", {
    title: "PDF",
    contentBase64: "JVBERg==",
  });
  await client.ingestKnowledgeDocx("project/one", "base two", {
    title: "DOCX",
    contentBase64: "UEsDBA==",
  });
  await client.getKnowledgeDocumentStatus("project/one", "base two", "doc#1");
  await client.retryKnowledgeDocument("project/one", "base two", "doc#1");
  await client.searchKnowledge("project/one", {
    query: "deployment decision",
    baseIds: ["base two"],
    limit: 5,
  });

  assert.equal(
    calls[0].url,
    "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two/documents"
      + "?status=ready&origin=source&limit=25",
  );
  assert.equal(
    calls[4].url,
    "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two"
      + "/documents/doc%231/status",
  );
  assert.equal(
    calls[5].url,
    "https://brain.example/api/knowledge/projects/project%2Fone/bases/base%20two"
      + "/documents/doc%231/retry",
  );
  assert.equal(
    calls[6].url,
    "https://brain.example/api/knowledge/projects/project%2Fone/search",
  );
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    title: "Guide",
    sourceName: "guide.md",
    sourceFormat: "markdown",
    content: "# Guide",
  });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    title: "PDF",
    contentBase64: "JVBERg==",
  });
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), {
    title: "DOCX",
    contentBase64: "UEsDBA==",
  });
  assert.deepEqual(JSON.parse(String(calls[6].init.body)), {
    query: "deployment decision",
    baseIds: ["base two"],
    limit: 5,
  });
});

test("knowledge requests forward cancellation to fetch", async () => {
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const controller = new AbortController();
  const request = new BrainRouterClient("https://brain.example", "api-key")
    .listKnowledgeBases("project-a", { signal: controller.signal });

  controller.abort();

  await assert.rejects(request, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("an authorization refresh replays with the same signal and fresh bearer token", async () => {
  const controller = new AbortController();
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return calls.length === 1
      ? response({ error: "expired" }, 401)
      : response({ bases: [] });
  }) as typeof fetch;
  const client = new BrainRouterClient(
    "https://brain.example",
    "",
    "expired-token",
    async () => "fresh-token",
  );

  assert.deepEqual(
    await client.listKnowledgeBases("project-a", { signal: controller.signal }),
    { bases: [] },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[1].init.signal, controller.signal);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer expired-token");
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "Bearer fresh-token");
});
