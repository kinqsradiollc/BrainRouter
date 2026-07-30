import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import type { KnowledgeDocumentRecord } from "../knowledge/contracts/document.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const createdAt = "2026-07-22T00:00:00.000Z";

test("knowledge documents preserve full ancestry, dedupe per base, and expose scoped status", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    await store.createUser("document-user", "document-user", "Document User");
    await store.createOrganization({ orgId: "document-org", name: "Document Org", slug: "document-org" });
    await store.addOrgMember("document-org", "document-user", "developer");
    for (const projectId of ["document-project-a", "document-project-b"]) {
      await store.createProject({
        projectId,
        orgId: "document-org",
        name: projectId,
        slug: projectId,
        repoUrl: null,
        restricted: false,
        createdBy: "document-user",
        createdAt,
      });
    }

    const base = (baseId: string, projectId: string): KnowledgeBaseRecord => ({
      baseId,
      orgId: "document-org",
      projectId,
      name: baseId,
      description: "",
      createdBy: "document-user",
      createdAt,
      updatedAt: createdAt,
    });
    await store.createKnowledgeBase(base("document-base-a", "document-project-a"));
    await store.createKnowledgeBase(base("document-base-b", "document-project-a"));

    const document = (documentId: string, baseId = "document-base-a"): KnowledgeDocumentRecord => ({
      documentId,
      baseId,
      orgId: "document-org",
      projectId: "document-project-a",
      title: "Runbook",
      sourceName: "runbook.md",
      sourceFormat: "markdown",
      contentText: "# Redacted runbook",
      contentSha256: "a".repeat(64),
      origin: "source",
      distillationVersion: null,
      status: "queued",
      statusMessage: null,
      parseVersion: 1,
      createdBy: "document-user",
      createdAt,
      updatedAt: createdAt,
      readyAt: null,
    });

    const first = document("document-a");
    await store.createKnowledgeDocument(first);
    assert.deepEqual(
      await store.getKnowledgeDocument("document-a", "document-base-a", "document-org", "document-project-a"),
      first,
    );
    assert.equal(
      await store.getKnowledgeDocument("document-a", "document-base-a", "document-org", "document-project-b"),
      null,
    );
    assert.deepEqual(
      await store.getKnowledgeDocumentByContentHash("a".repeat(64), "document-base-a", "document-org", "document-project-a"),
      first,
    );

    await assert.rejects(
      store.createKnowledgeDocument(document("document-duplicate")),
      (error: any) => error?.code === "23505" && error?.constraint === "uq_knowledge_documents_base_content",
    );
    await store.createKnowledgeDocument(document("document-other-base", "document-base-b"));
    assert.equal((await store.listKnowledgeDocuments(
      "document-base-a",
      "document-org",
      "document-project-a",
      { status: "queued" },
    )).length, 1);

    const readyAt = "2026-07-22T01:00:00.000Z";
    const updated = await store.updateKnowledgeDocumentStatus(
      "document-a",
      "document-base-a",
      "document-org",
      "document-project-a",
      { status: "ready", statusMessage: null, updatedAt: readyAt, readyAt },
    );
    assert.equal(updated?.status, "ready");
    assert.equal(updated?.readyAt, readyAt);
    assert.equal((await store.listKnowledgeDocuments(
      "document-base-a",
      "document-org",
      "document-project-a",
      { status: "queued" },
    )).length, 0);
    assert.equal(await store.updateKnowledgeDocumentStatus(
      "document-a",
      "document-base-a",
      "document-org",
      "document-project-b",
      { status: "failed", statusMessage: "hidden", updatedAt: readyAt, readyAt: null },
    ), null);

    const derived: KnowledgeDocumentRecord = {
      ...document("document-derived"),
      title: "Derived note",
      contentText: "# Derived note",
      contentSha256: "b".repeat(64),
      origin: "derived",
      distillationVersion: 1,
    };
    const distilled = await store.enqueueDerivedKnowledgeDocuments([{
      document: derived,
      sourceDocumentIds: ["document-a"],
      jobId: "document-derived-job",
    }]);
    assert.deepEqual(distilled, [{
      document: derived,
      sourceDocumentIds: ["document-a"],
      created: true,
      jobId: "document-derived-job",
    }]);
    assert.deepEqual(await store.listKnowledgeDocumentSourceIds(
      "document-derived",
      "document-base-a",
      "document-org",
      "document-project-a",
    ), ["document-a"]);
    await store.updateKnowledgeDocumentStatus(
      "document-derived",
      "document-base-a",
      "document-org",
      "document-project-a",
      { status: "ready", statusMessage: null, updatedAt: readyAt, readyAt },
    );
    await assert.rejects(
      store.enqueueDerivedKnowledgeDocuments([{
        document: {
          ...derived,
          documentId: "document-recursive",
          contentText: "# Recursive",
          contentSha256: "c".repeat(64),
        },
        sourceDocumentIds: ["document-derived"],
        jobId: "document-recursive-job",
      }]),
      /sources are unavailable/,
    );

    await assert.rejects(
      store.createKnowledgeDocument({
        ...document("document-cross-project"),
        projectId: "document-project-b",
      }),
      (error: any) => error?.code === "23503",
    );
  } finally {
    await cleanup();
  }
});
