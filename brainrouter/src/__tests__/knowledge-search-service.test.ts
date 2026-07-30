import { describe, expect, it, vi } from "vitest";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import type {
  KnowledgeLexicalSearchHit,
  KnowledgeVectorSearchHit,
} from "../knowledge/contracts/search.js";
import { KnowledgeSearchService, fuseCandidates } from "../knowledge/services/search.js";
import type { KnowledgeDocumentStore } from "../knowledge/store.js";

const actor = knowledgeActorFromAuth({
  userId: "user-1",
  orgId: "org-1",
  role: "viewer",
})!;

const base: KnowledgeBaseRecord = {
  baseId: "base-1",
  orgId: "org-1",
  projectId: "project-1",
  name: "Engineering",
  description: "",
  createdBy: "user-1",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

function hit(
  chunkId: string,
  documentId: string,
  ordinal: number,
): Omit<KnowledgeLexicalSearchHit, "textRank"> {
  return {
    chunkId,
    documentId,
    baseId: "base-1",
    orgId: "org-1",
    projectId: "project-1",
    documentTitle: `${documentId} title`,
    sourceName: `${documentId}.md`,
    ordinal,
    content: `${chunkId} content`,
    tokenCount: 4,
    charStart: ordinal * 10,
    charEnd: ordinal * 10 + 9,
    locator: { section: chunkId, absolutePath: `/private/${chunkId}` },
  };
}

function lexical(chunkId: string, documentId: string, ordinal: number): KnowledgeLexicalSearchHit {
  return { ...hit(chunkId, documentId, ordinal), textRank: 0.5 };
}

function vector(chunkId: string, documentId: string, ordinal: number): KnowledgeVectorSearchHit {
  return { ...hit(chunkId, documentId, ordinal), vectorScore: 0.9 };
}

function setup(options: {
  projectVisible?: boolean;
  lexical?: KnowledgeLexicalSearchHit[];
  vector?: KnowledgeVectorSearchHit[];
  vectorError?: boolean;
  provider?: "ready" | "missing" | "throw" | "invalid";
} = {}) {
  const writes = {
    createKnowledgeBase: vi.fn(),
    updateKnowledgeBase: vi.fn(),
    deleteKnowledgeBase: vi.fn(),
    enqueueKnowledgeDocument: vi.fn(),
    markKnowledgeDocumentParsing: vi.fn(),
    commitKnowledgeDocumentParse: vi.fn(),
    failKnowledgeDocumentParse: vi.fn(),
    upsertKnowledgeChunkEmbeddings: vi.fn(),
    retryKnowledgeDocumentProcessing: vi.fn(),
    createKnowledgeDocument: vi.fn(),
    updateKnowledgeDocumentStatus: vi.fn(),
  };
  const store = {
    ...writes,
    getAccessibleProject: vi.fn(async () => options.projectVisible === false ? null : {
      projectId: "project-1",
      orgId: "org-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: null,
      restricted: false,
      createdBy: "user-1",
      createdAt: base.createdAt,
    }),
    listKnowledgeBases: vi.fn(async () => [base]),
    searchKnowledgeChunksByText: vi.fn(async () => options.lexical ?? [
      lexical("chunk-a", "document-a", 0),
      lexical("chunk-b", "document-b", 0),
    ]),
    searchKnowledgeChunksByVector: options.vectorError
      ? vi.fn(async () => { throw new Error("private vector failure"); })
      : vi.fn(async () => options.vector ?? [
        vector("chunk-b", "document-b", 0),
        vector("chunk-c", "document-c", 0),
      ]),
  } as unknown as KnowledgeDocumentStore;
  const provider = options.provider ?? "ready";
  const resolveEmbeddingProvider = vi.fn(async () => {
    if (provider === "missing") return null;
    if (provider === "throw") throw new Error("private provider failure");
    return {
      model: "model-a",
      embed: vi.fn(async () => provider === "invalid"
        ? new Float32Array([1, Number.NaN])
        : new Float32Array([1, 0, 0])),
    };
  });
  return {
    store,
    writes,
    resolveEmbeddingProvider,
    service: new KnowledgeSearchService(store, { resolveEmbeddingProvider }),
  };
}

describe("KnowledgeSearchService", () => {
  it("authorizes, validates bases, fuses ranks, and returns citation-safe hits", async () => {
    const { service, store, writes, resolveEmbeddingProvider } = setup();

    const result = await service.search(actor, " project-1 ", {
      query: " signing key ",
      baseIds: [" base-1 ", "base-1"],
      limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("hybrid");
    expect(result.value.hits.map((item) => item.citation.chunkId)).toEqual(["chunk-b", "chunk-a"]);
    expect(result.value.hits[0]).toEqual({
      content: "chunk-b content",
      score: (1 / 62) + (1 / 61),
      matchedBy: ["lexical", "vector"],
      citation: {
        projectId: "project-1",
        baseId: "base-1",
        documentId: "document-b",
        chunkId: "chunk-b",
        documentTitle: "document-b title",
        sourceName: "document-b.md",
        ordinal: 0,
        charStart: 0,
        charEnd: 9,
        locator: { section: "chunk-b" },
      },
    });
    expect(result.value.hits[0]).not.toHaveProperty("orgId");
    expect(result.value.hits[0]).not.toHaveProperty("embedding");
    expect(store.getAccessibleProject).toHaveBeenCalledWith(
      "project-1", "org-1", "user-1", false,
    );
    expect(store.listKnowledgeBases).toHaveBeenCalledWith("org-1", "project-1");
    expect(store.searchKnowledgeChunksByText).toHaveBeenCalledWith({
      orgId: "org-1",
      projectId: "project-1",
      baseIds: ["base-1"],
      limit: 20,
    }, "signing key");
    expect(store.searchKnowledgeChunksByVector).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", projectId: "project-1", limit: 20 }),
      { embeddingModel: "model-a", dimensions: 3, embedding: expect.any(Float32Array) },
    );
    expect(resolveEmbeddingProvider).toHaveBeenCalledWith("org-1");
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });

  it("searches every Project base without listing bases when the filter is empty", async () => {
    const { service, store } = setup({ provider: "missing" });
    await expect(service.search(actor, "project-1", {
      query: "recovery",
      baseIds: [],
    })).resolves.toMatchObject({ ok: true, value: { mode: "lexical" } });
    expect(store.listKnowledgeBases).not.toHaveBeenCalled();
    expect(store.searchKnowledgeChunksByText).toHaveBeenCalledWith(
      expect.objectContaining({ baseIds: [], limit: 80 }),
      "recovery",
    );
    expect(store.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
  });

  it("hides inaccessible Projects before input validation or search", async () => {
    const { service, store } = setup({ projectVisible: false });
    await expect(service.search(actor, "foreign-project", { query: "" })).resolves.toEqual({
      ok: false,
      code: "not_found",
    });
    expect(store.listKnowledgeBases).not.toHaveBeenCalled();
    expect(store.searchKnowledgeChunksByText).not.toHaveBeenCalled();
    expect(store.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
  });

  it("rejects malformed bounds before candidate searches", async () => {
    for (const input of [
      { query: "" },
      { query: "x".repeat(4_001) },
      { query: "valid", baseIds: [""] },
      { query: "valid", baseIds: Array.from({ length: 101 }, (_, index) => `base-${index}`) },
      { query: "valid", limit: 0 },
      { query: "valid", limit: 101 },
    ]) {
      const { service, store } = setup();
      await expect(service.search(actor, "project-1", input)).resolves.toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(store.searchKnowledgeChunksByText).not.toHaveBeenCalled();
      expect(store.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
    }
  });

  it("returns not_found when any requested base is outside the authorized Project", async () => {
    const { service, store } = setup();
    await expect(service.search(actor, "project-1", {
      query: "recovery",
      baseIds: ["base-1", "foreign-base"],
    })).resolves.toEqual({ ok: false, code: "not_found" });
    expect(store.searchKnowledgeChunksByText).not.toHaveBeenCalled();
    expect(store.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
  });

  it.each(["missing", "throw", "invalid"] as const)(
    "falls back to lexical results when the embedding provider is %s",
    async (provider) => {
      const { service, store } = setup({ provider });
      const result = await service.search(actor, "project-1", { query: "recovery" });
      expect(result).toMatchObject({ ok: true, value: { mode: "lexical" } });
      expect(store.searchKnowledgeChunksByText).toHaveBeenCalledOnce();
      expect(store.searchKnowledgeChunksByVector).not.toHaveBeenCalled();
    },
  );

  it("falls back to lexical results when exact vector search fails", async () => {
    const { service, store } = setup({ vectorError: true });
    const result = await service.search(actor, "project-1", { query: "recovery" });
    expect(result).toMatchObject({ ok: true, value: { mode: "lexical" } });
    expect(store.searchKnowledgeChunksByText).toHaveBeenCalledOnce();
    expect(store.searchKnowledgeChunksByVector).toHaveBeenCalledOnce();
  });

  it("orders equal RRF scores deterministically and does not mutate source locators", () => {
    const left = lexical("chunk-z", "document-z", 0);
    const right = vector("chunk-a", "document-a", 0);
    const results = fuseCandidates([left], [right], 10);
    expect(results.map((item) => item.citation.chunkId)).toEqual(["chunk-a", "chunk-z"]);
    results[1]!.citation.locator.section = "changed";
    expect(left.locator).toEqual({
      section: "chunk-z",
      absolutePath: "/private/chunk-z",
    });
  });
});
