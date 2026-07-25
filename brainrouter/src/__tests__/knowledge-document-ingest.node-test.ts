import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { knowledgeActorFromAuth } from "../knowledge/contracts/actor.js";
import type { KnowledgeBaseRecord } from "../knowledge/contracts/base.js";
import { KNOWLEDGE_PARSE_JOB_KIND } from "../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../knowledge/services/documents.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const at = "2026-07-22T03:00:00.000Z";

test("knowledge text ingest persists redacted content and atomically queues one scoped parse job", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    await store.createUser("ingest-user", "ingest-user", "Ingest User");
    await store.createOrganization({ orgId: "ingest-org", name: "Ingest Org", slug: "ingest-org" });
    await store.addOrgMember("ingest-org", "ingest-user", "developer");
    await store.createProject({
      projectId: "ingest-project",
      orgId: "ingest-org",
      name: "Ingest Project",
      slug: "ingest-project",
      repoUrl: null,
      restricted: false,
      createdBy: "ingest-user",
      createdAt: at,
    });
    const base: KnowledgeBaseRecord = {
      baseId: "ingest-base",
      orgId: "ingest-org",
      projectId: "ingest-project",
      name: "Engineering",
      description: "",
      createdBy: "ingest-user",
      createdAt: at,
      updatedAt: at,
    };
    await store.createKnowledgeBase(base);
    const actor = knowledgeActorFromAuth({
      userId: "ingest-user", orgId: "ingest-org", role: "developer",
    })!;
    let sequence = 0;
    const service = new KnowledgeDocumentService(store, {
      documentIdGenerator: () => `ingest-document-${++sequence}`,
      jobIdGenerator: () => `ingest-job-${sequence}`,
      now: () => at,
    });

    const first = await service.ingestText(actor, "ingest-project", "ingest-base", {
      title: " Runbook ",
      sourceName: " runbook.md ",
      sourceFormat: "markdown",
      content: " First\r\nSECRET_TOKEN=abc123\rLast ",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.created, true);
    assert.equal(first.value.jobId, "ingest-job-1");
    assert.equal(first.value.document.contentText, "First\n[REDACTED]\nLast");

    const job = await store.getMemoryJob("ingest-job-1");
    assert.equal(job?.kind, KNOWLEDGE_PARSE_JOB_KIND);
    assert.equal(job?.status, "pending");
    assert.deepEqual(job?.input, {
      orgId: "ingest-org",
      projectId: "ingest-project",
      baseId: "ingest-base",
      documentId: "ingest-document-1",
      parseVersion: 1,
    });
    assert.equal(JSON.stringify(job?.input).includes("First"), false);

    const duplicate = await service.ingestText(actor, "ingest-project", "ingest-base", {
      title: "Another title",
      sourceFormat: "text",
      content: "First\nSECRET_TOKEN=abc123\nLast",
    });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) return;
    assert.equal(duplicate.value.created, false);
    assert.equal(duplicate.value.document.documentId, "ingest-document-1");
    assert.equal(duplicate.value.jobId, null);
    assert.equal((await store.listMemoryJobs({ kind: KNOWLEDGE_PARSE_JOB_KIND })).length, 1);

    const rawPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (PDF\\nSECRET_TOKEN=pdf123) Tj ET\n%%EOF",
      "latin1",
    ).toString("base64");
    const pdf = await service.ingestPdf(actor, "ingest-project", "ingest-base", {
      title: "PDF runbook",
      sourceName: "runbook.pdf",
      contentBase64: rawPdf,
    });
    assert.equal(pdf.ok, true);
    if (!pdf.ok) return;
    assert.equal(pdf.value.created, true);
    assert.equal(pdf.value.jobId, "ingest-job-3");
    assert.equal(pdf.value.document.sourceFormat, "pdf");
    assert.equal(pdf.value.document.contentText, "PDF\n[REDACTED]");
    const pdfJob = await store.getMemoryJob("ingest-job-3");
    assert.deepEqual(pdfJob?.input, {
      orgId: "ingest-org",
      projectId: "ingest-project",
      baseId: "ingest-base",
      documentId: "ingest-document-3",
      parseVersion: 1,
    });
    assert.equal(JSON.stringify(pdfJob?.input).includes(rawPdf), false);
    assert.equal((await store.listMemoryJobs({ kind: KNOWLEDGE_PARSE_JOB_KIND })).length, 2);

    await store.enqueueMemoryJob(
      { kind: "collision-sentinel", input: { orgId: "ingest-org" } },
      { idGenerator: () => "ingest-job-collision", now: at },
    );
    const collisionService = new KnowledgeDocumentService(store, {
      documentIdGenerator: () => "ingest-document-rollback",
      jobIdGenerator: () => "ingest-job-collision",
      now: () => at,
    });
    const rollbackContent = "Unique rollback content";
    await assert.rejects(
      collisionService.ingestText(actor, "ingest-project", "ingest-base", {
        title: "Rollback",
        sourceFormat: "text",
        content: rollbackContent,
      }),
      (error: any) => error?.code === "23505",
    );
    assert.equal(await store.getKnowledgeDocumentByContentHash(
      createHash("sha256").update(rollbackContent).digest("hex"),
      "ingest-base",
      "ingest-org",
      "ingest-project",
    ), null);
  } finally {
    await cleanup();
  }
});
