import assert from "node:assert/strict";
import test from "node:test";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import pg from "pg";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import { KNOWLEDGE_PARSE_JOB_KIND } from "../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../knowledge/services/documents.js";
import { MemoryJobRunner } from "../memory/scheduler/runner.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const at = "2026-07-22T05:00:00.000Z";
const { Client } = pg;

test("knowledge parse jobs become ready with scoped chunks and rerun idempotently", async () => {
  const { store, url, cleanup } = await createTestStore({ vecDim: 0 });
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
    const jobIds = ["parse-job-first", "parse-job-retry", "parse-job-unused"];
    const service = new KnowledgeDocumentService(store, {
      documentIdGenerator: () => "parse-document",
      jobIdGenerator: () => jobIds.shift() ?? "parse-job-overflow",
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
      {
        store: store as unknown as IMemoryStore,
        llmRunner: { run: async () => "" } as never,
        engine: {
          resolveKnowledgeEmbeddingProvider: async (orgId: string) => ({
            model: `embed-${orgId}`,
            embed: async () => new Float32Array([0.25, -0.5, 0.75]),
          }),
        } as never,
      },
      { maxPerTick: 4, perTenantLimit: 2 },
    );
    await runner.tick();

    const firstJob = await store.getMemoryJob("parse-job-first");
    assert.ok(firstJob);
    assert.equal(firstJob?.status, "done");
    assert.deepEqual(firstJob?.output, {
      documentId: "parse-document",
      chunksWritten: 1,
      embeddingsWritten: 1,
      embeddingModel: "embed-parse-org",
      alreadyReady: false,
      status: "ready",
    });
    const ready = await store.getKnowledgeDocument(
      "parse-document", "parse-base", "parse-org", "parse-project",
    );
    assert.ok(ready);
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.statusMessage, null);
    assert.equal(ready?.readyAt !== null, true);
    const status = await service.status(actor, "parse-project", "parse-base", "parse-document");
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.deepEqual(status.value, {
      documentId: "parse-document",
      title: "Runbook",
      sourceName: "runbook.md",
      sourceFormat: "markdown",
      status: "ready",
      statusMessage: null,
      parseVersion: 1,
      updatedAt: ready.updatedAt,
      readyAt: ready.readyAt,
      processing: {
        jobState: "done",
        attempts: firstJob.attempts,
        maxAttempts: firstJob.maxAttempts,
        retryable: true,
        chunkCount: 1,
        embeddingCount: 1,
      },
    });
    const serializedStatus = JSON.stringify(status);
    assert.equal(serializedStatus.includes("First procedure"), false);
    assert.equal(serializedStatus.includes("contentSha256"), false);
    assert.equal(serializedStatus.includes("createdBy"), false);
    assert.equal(serializedStatus.includes("orgId"), false);
    assert.equal(serializedStatus.includes("projectId"), false);
    assert.deepEqual(
      await service.status(actor, "foreign-project", "parse-base", "parse-document"),
      { ok: false, code: "not_found" },
    );
    assert.deepEqual(
      await service.status(actor, "parse-project", "foreign-base", "parse-document"),
      { ok: false, code: "not_found" },
    );
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
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const embedded = await client.query(
        `SELECT embedding_model, dimensions, embedding::text AS embedding
           FROM knowledge_chunk_embeddings
          WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
        ["parse-document", "parse-base", "parse-org", "parse-project"],
      );
      assert.equal(embedded.rowCount, 1);
      assert.deepEqual(embedded.rows[0], {
        embedding_model: "embed-parse-org",
        dimensions: 3,
        embedding: "[0.25,-0.5,0.75]",
      });
    } finally {
      await client.end();
    }

    assert.deepEqual(
      await service.retry(actor, "parse-project", "parse-base", "parse-document"),
      {
        ok: true,
        value: { documentId: "parse-document", jobState: "pending", enqueued: true },
      },
    );
    assert.deepEqual(
      await service.retry(actor, "parse-project", "parse-base", "parse-document"),
      {
        ok: true,
        value: { documentId: "parse-document", jobState: "pending", enqueued: false },
      },
    );
    await runner.tick();
    const repeated = await store.getMemoryJob("parse-job-retry");
    assert.equal(repeated?.status, "done");
    assert.deepEqual(repeated?.output, {
      documentId: "parse-document",
      chunksWritten: 1,
      embeddingsWritten: 1,
      embeddingModel: "embed-parse-org",
      alreadyReady: true,
      status: "ready",
    });
    const repeatedChunks = await store.listKnowledgeChunks(
      "parse-document", "parse-base", "parse-org", "parse-project",
    );
    assert.deepEqual(repeatedChunks.map((chunk) => chunk.chunkId), chunks.map((chunk) => chunk.chunkId));
    const repeatedStatus = await service.status(
      actor, "parse-project", "parse-base", "parse-document",
    );
    assert.equal(repeatedStatus.ok, true);
    if (repeatedStatus.ok) {
      assert.equal(repeatedStatus.value.processing.jobState, "done");
      assert.equal(repeatedStatus.value.processing.chunkCount, 1);
      assert.equal(repeatedStatus.value.processing.embeddingCount, 1);
    }
    const verify = new Client({ connectionString: url });
    await verify.connect();
    try {
      const count = await verify.query(
        "SELECT COUNT(*)::int AS count FROM knowledge_chunk_embeddings WHERE document_id = $1",
        ["parse-document"],
      );
      assert.equal(count.rows[0]?.count, 1);
      const jobs = await verify.query(
        `SELECT COUNT(*)::int AS count FROM memory_jobs
          WHERE kind = $1 AND tenant = $2 AND input_json::jsonb @> $3::jsonb`,
        [KNOWLEDGE_PARSE_JOB_KIND, "parse-org", JSON.stringify(jobInput)],
      );
      assert.equal(jobs.rows[0]?.count, 2);
    } finally {
      await verify.end();
    }
  } finally {
    await cleanup();
  }
});
