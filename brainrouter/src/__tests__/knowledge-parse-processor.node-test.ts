import assert from "node:assert/strict";
import test from "node:test";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import { KNOWLEDGE_PARSE_JOB_KIND } from "../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../knowledge/services/documents.js";
import { MemoryJobRunner } from "../memory/scheduler/runner.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const at = "2026-07-22T05:00:00.000Z";

test("knowledge parse jobs become ready with scoped chunks and rerun idempotently", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    await store.createUser("parse-user", "parse-user", "Parse User");
    await store.createOrganization({ orgId: "parse-org", name: "Parse Org", slug: "parse-org" });
    await store.addOrgMember("parse-org", "parse-user", "developer");
    await store.createProject({
      projectId: "parse-project",
      orgId: "parse-org",
      name: "Parse Project",
      slug: "parse-project",
      repoUrl: null,
      restricted: false,
      createdBy: "parse-user",
      createdAt: at,
    });
    const base: KnowledgeBaseRecord = {
      baseId: "parse-base",
      orgId: "parse-org",
      projectId: "parse-project",
      name: "Engineering",
      description: "",
      createdBy: "parse-user",
      createdAt: at,
      updatedAt: at,
    };
    await store.createKnowledgeBase(base);
    const actor = knowledgeActorFromAuth({
      userId: "parse-user", orgId: "parse-org", role: "developer",
    })!;
    const service = new KnowledgeDocumentService(store, {
      documentIdGenerator: () => "parse-document",
      jobIdGenerator: () => "parse-job-first",
      now: () => at,
    });
    const ingested = await service.ingestText(actor, "parse-project", "parse-base", {
      title: "Runbook",
      sourceName: "runbook.md",
      sourceFormat: "markdown",
      content: "# Runbook\n\nFirst procedure.\nSecond procedure.",
    });
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    const jobInput = {
      orgId: "parse-org",
      projectId: "parse-project",
      baseId: "parse-base",
      documentId: "parse-document",
      parseVersion: 1,
    };
    const runner = new MemoryJobRunner(
      store as unknown as IMemoryStore,
      { store: store as unknown as IMemoryStore, llmRunner: { run: async () => "" } as never },
      { maxPerTick: 4, perTenantLimit: 2 },
    );
    await runner.tick();

    const firstJob = await store.getMemoryJob("parse-job-first");
    assert.equal(firstJob?.status, "done");
    assert.deepEqual(firstJob?.output, {
      documentId: "parse-document",
      chunksWritten: 1,
      alreadyReady: false,
      status: "ready",
    });
    const ready = await store.getKnowledgeDocument(
      "parse-document", "parse-base", "parse-org", "parse-project",
    );
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.statusMessage, null);
    assert.equal(ready?.readyAt !== null, true);
    const chunks = await store.listKnowledgeChunks(
      "parse-document", "parse-base", "parse-org", "parse-project",
    );
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.content, "# Runbook\n\nFirst procedure.\nSecond procedure.");
    assert.deepEqual(chunks[0]?.locator, {
      sourceFormat: "markdown",
      startLine: 1,
      endLine: 4,
    });
    assert.deepEqual(await store.listKnowledgeChunks(
      "parse-document", "parse-base", "parse-org", "foreign-project",
    ), []);

    await store.enqueueMemoryJob(
      { kind: KNOWLEDGE_PARSE_JOB_KIND, input: jobInput, maxAttempts: 1 },
      { idGenerator: () => "parse-job-repeat", now: at },
    );
    await runner.tick();
    const repeated = await store.getMemoryJob("parse-job-repeat");
    assert.equal(repeated?.status, "done");
    assert.deepEqual(repeated?.output, {
      documentId: "parse-document",
      chunksWritten: 1,
      alreadyReady: true,
      status: "ready",
    });
    const repeatedChunks = await store.listKnowledgeChunks(
      "parse-document", "parse-base", "parse-org", "parse-project",
    );
    assert.deepEqual(repeatedChunks.map((chunk) => chunk.chunkId), chunks.map((chunk) => chunk.chunkId));
  } finally {
    await cleanup();
  }
});
