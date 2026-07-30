import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import {
  useKnowledgeBases,
  useKnowledgeDocuments,
  useKnowledgeDocumentStatus,
  useKnowledgeSearch,
} from "./index.js";

const originalFetch = globalThis.fetch;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "Content-Type": "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type BasesState = ReturnType<typeof useKnowledgeBases>;

function BasesProbe(props: {
  client: BrainRouterClient;
  projectId: string;
  onState: (state: BasesState) => void;
}) {
  const state = useKnowledgeBases(props.client, props.projectId);
  useEffect(() => props.onState(state), [props, state]);
  return null;
}

test("a Project switch aborts the stale base request and commits only the new scope", async () => {
  const requests: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (value: Response) => void;
  }> = [];
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      requests.push({ url: String(input), signal, resolve });
    })) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let state: BasesState | undefined;
  const onState = (next: BasesState) => {
    state = next;
  };
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(BasesProbe, { client, projectId: "project-a", onState }));
    await flush();
  });
  assert.equal(requests.length, 1);
  assert.equal(state?.isLoading, true);

  await act(async () => {
    renderer.update(createElement(BasesProbe, { client, projectId: "project-b", onState }));
    await flush();
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);

  const base = {
    baseId: "base-b",
    projectId: "project-b",
    name: "Project B",
    description: "",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  await act(async () => {
    requests[1].resolve(response({ bases: [base] }));
    await flush();
  });
  assert.deepEqual(state?.bases, [base]);
  assert.equal(state?.isLoading, false);
  assert.match(requests[1].url, /projects\/project-b\/bases$/);

  await act(async () => renderer.unmount());
});

test("a successful base mutation reloads the active Project", async () => {
  const methods: string[] = [];
  const base = {
    baseId: "base-a",
    projectId: "project-a",
    name: "Architecture",
    description: "",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  let getCount = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    methods.push(method);
    if (method === "POST") return response({ base }, 201);
    getCount += 1;
    return response({ bases: getCount === 1 ? [] : [base] });
  }) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let state: BasesState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(BasesProbe, {
      client,
      projectId: "project-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });
  assert.deepEqual(state?.bases, []);

  await act(async () => {
    await state?.createBase({ name: "Architecture" });
    await flush();
  });
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
  assert.deepEqual(state?.bases, [base]);
  assert.equal(state?.isMutating, false);

  await act(async () => renderer.unmount());
});

test("a failed scoped query leaves loading state and exposes the API error", async () => {
  globalThis.fetch = (async () =>
    response({ error: "Knowledge service unavailable" }, 503)) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let state: BasesState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(BasesProbe, {
      client,
      projectId: "project-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });

  assert.equal(state?.isLoading, false);
  assert.equal(state?.error, "Knowledge service unavailable");
  assert.deepEqual(state?.bases, []);

  await act(async () => renderer.unmount());
});

type SearchState = ReturnType<typeof useKnowledgeSearch>;

function SearchProbe(props: {
  client: BrainRouterClient;
  projectId: string;
  onState: (state: SearchState) => void;
}) {
  const state = useKnowledgeSearch(props.client, props.projectId);
  useEffect(() => props.onState(state), [props, state]);
  return null;
}

test("a newer search cancels and supersedes the prior preview", async () => {
  const requests: Array<{
    signal: AbortSignal;
    resolve: (value: Response) => void;
  }> = [];
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      requests.push({ signal, resolve });
    })) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let state: SearchState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(SearchProbe, {
      client,
      projectId: "project-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });

  let first: Promise<unknown> | undefined;
  await act(async () => {
    first = state?.search({ query: "old query" });
    await flush();
  });
  let second: Promise<unknown> | undefined;
  await act(async () => {
    second = state?.search({ query: "new query" });
    await flush();
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);

  const searchResult = { mode: "lexical" as const, hits: [] };
  await act(async () => {
    requests[1].resolve(response({ search: searchResult }));
    assert.deepEqual(await second, searchResult);
    assert.equal(await first, null);
    await flush();
  });
  assert.deepEqual(state?.result, searchResult);
  assert.equal(state?.isSearching, false);

  await act(async () => renderer.unmount());
});

function InventoryProbe(props: {
  client: BrainRouterClient;
  onState: (state: {
    bases: ReturnType<typeof useKnowledgeBases>;
    documents: ReturnType<typeof useKnowledgeDocuments>;
    status: ReturnType<typeof useKnowledgeDocumentStatus>;
    search: ReturnType<typeof useKnowledgeSearch>;
  }) => void;
}) {
  const bases = useKnowledgeBases(props.client, "");
  const documents = useKnowledgeDocuments(props.client, "", "");
  const status = useKnowledgeDocumentStatus(props.client, "", "", "");
  const search = useKnowledgeSearch(props.client, "");
  useEffect(() => props.onState({ bases, documents, status, search }), [
    bases,
    documents,
    props,
    search,
    status,
  ]);
  return null;
}

test("the knowledge hook inventory stays idle until a Project scope is selected", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return response({});
  }) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let inventory: Parameters<Parameters<typeof InventoryProbe>[0]["onState"]>[0] | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(InventoryProbe, {
      client,
      onState: (next) => {
        inventory = next;
      },
    }));
    await flush();
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(inventory?.bases.bases, []);
  assert.deepEqual(inventory?.documents.documents, []);
  assert.equal(inventory?.status.document, null);
  assert.equal(inventory?.search.result, null);
  assert.equal(typeof inventory?.bases.createBase, "function");
  assert.equal(typeof inventory?.bases.updateBase, "function");
  assert.equal(typeof inventory?.bases.deleteBase, "function");
  assert.equal(typeof inventory?.documents.ingestText, "function");
  assert.equal(typeof inventory?.documents.ingestPdf, "function");
  assert.equal(typeof inventory?.documents.ingestDocx, "function");
  assert.equal(typeof inventory?.status.retry, "function");
  assert.equal(typeof inventory?.search.search, "function");

  await act(async () => renderer.unmount());
});
