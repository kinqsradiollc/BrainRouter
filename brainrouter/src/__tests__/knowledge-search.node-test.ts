import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import type { KnowledgeDocumentRecord, KnowledgeParseJobInput } from "../knowledge/contracts/document.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const { Client } = pg;
const createdAt = "2026-07-22T00:00:00.000Z";

test("knowledge search primitives isolate ancestry, readiness, bases, models, and dimensions", async () => {
  const { store, url, cleanup } = await createTestStore({ vecDim: 0 });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await store.createUser("search-user", "search-user", "Search User");
    for (const orgId of ["search-org-a", "search-org-b"]) {
      await store.createOrganization({ orgId, name: orgId, slug: orgId });
      await store.addOrgMember(orgId, "search-user", "developer");
    }
    await store.createProject({
      projectId: "search-project-a",
      orgId: "search-org-a",
      name: "Search A",
      slug: "search-a",
      repoUrl: null,
      restricted: false,
      createdBy: "search-user",
      createdAt,
    });
    await store.createProject({
      projectId: "search-project-b",
      orgId: "search-org-b",
      name: "Search B",
      slug: "search-b",
      repoUrl: null,
      restricted: false,
      createdBy: "search-user",
      createdAt,
    });

    const base = (baseId: string, orgId: string, projectId: string): KnowledgeBaseRecord => ({
      baseId,
      orgId,
      projectId,
      name: baseId,
      description: "",
      createdBy: "search-user",
      createdAt,
      updatedAt: createdAt,
    });
    await store.createKnowledgeBase(base("search-base-a", "search-org-a", "search-project-a"));
    await store.createKnowledgeBase(base("search-base-a2", "search-org-a", "search-project-a"));
    await store.createKnowledgeBase(base("search-base-b", "search-org-b", "search-project-b"));

    const document = (
      documentId: string,
      baseId: string,
      orgId: string,
      projectId: string,
      hashChar: string,
    ): KnowledgeDocumentRecord => ({
      documentId,
      baseId,
      orgId,
      projectId,
      title: `${documentId} title`,
      sourceName: `${documentId}.md`,
      sourceFormat: "markdown",
      contentText: "normalized source",
      contentSha256: hashChar.repeat(64),
      status: "queued",
      statusMessage: null,
      parseVersion: 1,
      createdBy: "search-user",
      createdAt,
      updatedAt: createdAt,
      readyAt: null,
    });
    const definitions = [
      { document: document("search-document-ready", "search-base-a", "search-org-a", "search-project-a", "a"), chunkId: "search-chunk-ready", hashChar: "1" },
      { document: document("search-document-second-base", "search-base-a2", "search-org-a", "search-project-a", "b"), chunkId: "search-chunk-second-base", hashChar: "2" },
      { document: document("search-document-failed", "search-base-a", "search-org-a", "search-project-a", "c"), chunkId: "search-chunk-failed", hashChar: "3" },
      { document: document("search-document-foreign", "search-base-b", "search-org-b", "search-project-b", "d"), chunkId: "search-chunk-foreign", hashChar: "4" },
    ];

    for (const definition of definitions) {
      const input: KnowledgeParseJobInput = {
        orgId: definition.document.orgId,
        projectId: definition.document.projectId,
        baseId: definition.document.baseId,
        documentId: definition.document.documentId,
        parseVersion: 1,
      };
      await store.createKnowledgeDocument(definition.document);
      await store.commitKnowledgeDocumentParse(input, [{
        chunkId: definition.chunkId,
        ordinal: 0,
        content: "Rotate the signing key safely.",
        contentSha256: definition.hashChar.repeat(64),
        tokenCount: 6,
        charStart: 0,
        charEnd: 29,
        locator: { section: "Recovery" },
      }], createdAt);
      await store.upsertKnowledgeChunkEmbeddings(input, [{
        chunkId: definition.chunkId,
        embeddingModel: "search-model",
        dimensions: 3,
        embedding: [1, 0, 0],
      }], createdAt);
    }
    await store.upsertKnowledgeChunkEmbeddings({
      orgId: "search-org-a",
      projectId: "search-project-a",
      baseId: "search-base-a",
      documentId: "search-document-ready",
      parseVersion: 1,
    }, [{
      chunkId: "search-chunk-ready",
      embeddingModel: "search-model-small",
      dimensions: 2,
      embedding: [1, 0],
    }], createdAt);
    await store.updateKnowledgeDocumentStatus(
      "search-document-failed",
      "search-base-a",
      "search-org-a",
      "search-project-a",
      { status: "failed", statusMessage: "safe failure", updatedAt: createdAt, readyAt: null },
    );

    const before = await client.query<{ documents: number; chunks: number; embeddings: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM knowledge_documents) AS documents,
         (SELECT COUNT(*)::int FROM knowledge_chunks) AS chunks,
         (SELECT COUNT(*)::int FROM knowledge_chunk_embeddings) AS embeddings`,
    );

    const baseLexical = await store.searchKnowledgeChunksByText({
      orgId: "search-org-a",
      projectId: "search-project-a",
      baseIds: ["search-base-a"],
    }, "signing key");
    assert.deepEqual(baseLexical.map((hit) => hit.chunkId), ["search-chunk-ready"]);
    assert.equal(baseLexical[0]?.documentTitle, "search-document-ready title");
    assert.deepEqual(baseLexical[0]?.locator, { section: "Recovery" });

    const projectLexical = await store.searchKnowledgeChunksByText({
      orgId: "search-org-a",
      projectId: "search-project-a",
    }, "signing key");
    assert.deepEqual(
      new Set(projectLexical.map((hit) => hit.chunkId)),
      new Set(["search-chunk-ready", "search-chunk-second-base"]),
    );

    const vector = await store.searchKnowledgeChunksByVector({
      orgId: "search-org-a",
      projectId: "search-project-a",
      baseIds: ["search-base-a"],
    }, {
      embeddingModel: "search-model",
      dimensions: 3,
      embedding: new Float32Array([1, 0, 0]),
    });
    assert.deepEqual(vector.map((hit) => hit.chunkId), ["search-chunk-ready"]);
    assert.equal(vector[0]?.vectorScore, 1);

    assert.deepEqual(await store.searchKnowledgeChunksByVector({
      orgId: "search-org-a",
      projectId: "search-project-a",
    }, {
      embeddingModel: "search-model",
      dimensions: 2,
      embedding: [1, 0],
    }), []);
    assert.deepEqual((await store.searchKnowledgeChunksByVector({
      orgId: "search-org-a",
      projectId: "search-project-a",
      baseIds: ["search-base-a"],
    }, {
      embeddingModel: "search-model-small",
      dimensions: 2,
      embedding: [1, 0],
    })).map((hit) => hit.chunkId), ["search-chunk-ready"]);

    const after = await client.query<{ documents: number; chunks: number; embeddings: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM knowledge_documents) AS documents,
         (SELECT COUNT(*)::int FROM knowledge_chunks) AS chunks,
         (SELECT COUNT(*)::int FROM knowledge_chunk_embeddings) AS embeddings`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});
