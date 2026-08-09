import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { learningSessionIdentity } from "@kinqs/brainrouter-core/learning";
import { createTestEngine } from "./helpers/pgTestStore.js";
import {
  buildHostedHumanCorrection,
  hostedLearnedMetadata,
  hostedLearningSessionIdentity,
} from "../memory/learning/hosted-learning.js";

const { Client } = pg;

test("ADR-032 hosted admission is durable, duplicate-safe, and tenant-budgeted", async () => {
  const { store, cleanup } = await createTestEngine();
  try {
    const base = {
      userId: "user-a",
      orgId: "org-a",
      sessionKeyHash: "session-hash-a",
      requestKey: "request-a",
      jobInput: {
        userId: "user-a",
        orgId: "org-a",
        sessionKey: "dashboard:session-a",
        reason: "turn-end",
        trajectory: "bounded trajectory",
        sawUntrustedContent: false,
        corroboratedByTrustedAction: false,
        model: "model-a",
        retrievedItemIds: [],
      },
    };
    const policy = {
      minCheckpointIntervalMs: 0,
      maxCheckpointsPerSession: 4,
      maxCheckpointsPerTenantDay: 1,
    };
    const first = await store.enqueueHostedLearningCheckpointJob(base, {
      now: new Date("2026-08-09T01:00:00.000Z"),
      policy,
      idGenerator: () => "hosted-job-1",
    });
    assert.equal(first.admitted, true);
    const duplicate = await store.enqueueHostedLearningCheckpointJob(base, {
      now: new Date("2026-08-09T01:00:01.000Z"),
      policy,
    });
    assert.deepEqual(
      { admitted: duplicate.admitted, reason: duplicate.reason, jobId: duplicate.jobId },
      { admitted: false, reason: "duplicate", jobId: "hosted-job-1" },
    );
    const interleaved = await store.enqueueHostedLearningCheckpointJob({
      ...base,
      requestKey: "request-between",
    }, {
      now: new Date("2026-08-09T01:00:01.500Z"),
      policy: { ...policy, maxCheckpointsPerTenantDay: 4 },
      idGenerator: () => "hosted-job-between",
    });
    assert.equal(interleaved.admitted, true);
    const delayedFirst = await store.enqueueHostedLearningCheckpointJob(base, {
      now: new Date("2026-08-09T01:00:01.750Z"),
      policy: { ...policy, maxCheckpointsPerTenantDay: 4 },
    });
    assert.deepEqual(
      { admitted: delayedFirst.admitted, reason: delayedFirst.reason, jobId: delayedFirst.jobId },
      { admitted: false, reason: "duplicate", jobId: "hosted-job-1" },
    );
    const tenantLimited = await store.enqueueHostedLearningCheckpointJob({
      ...base,
      sessionKeyHash: "session-hash-b",
      requestKey: "request-b",
    }, {
      now: new Date("2026-08-09T01:00:02.000Z"),
      policy,
    });
    assert.equal(tenantLimited.reason, "tenant-budget");
    const jobs = await store.listMemoryJobs({ kind: "hosted-learning-checkpoint" });
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((job) => job.id).sort(), ["hosted-job-1", "hosted-job-between"]);
    assert.equal((jobs.find((job) => job.id === "hosted-job-1")?.input as any)?.orgId, "org-a");
  } finally {
    await cleanup();
  }
});

test("ADR-032 hosted outcomes count distinct sessions and contradiction wins durably", async () => {
  const { engine, store, url, cleanup } = await createTestEngine();
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const reviewed = buildHostedHumanCorrection({
      tenant: { userId: "user-a", orgId: "org-a" },
      sessionKey: "hosted-correction:session-a",
      statement: "Use merge commits when integrating release branches.",
      falsifier: "a squash merge preserves the required release ancestry",
      expectation: "release ancestry remains visible after integration",
      now: new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.equal(reviewed.admitted, true);
    if (!reviewed.admitted) return;
    await engine.recordLesson("user-a", reviewed.item.statement, {
      orgId: "org-a",
      sessionKey: reviewed.item.provenance.sessionKey,
      learned: hostedLearnedMetadata(reviewed.item),
    });
    const retrieved = await store.retrieveHostedLearnedRecords(
      "user-a", "org-a", 16, new Date("2026-08-09T01:00:00.000Z"),
    );
    assert.equal(retrieved.length, 1);
    assert.equal((retrieved[0]?.metadata.learned as any)?.outcome?.retrievals, 1);

    const sessionA = hostedLearningSessionIdentity("user-a", "org-a", "dashboard:session-a");
    const sessionB = hostedLearningSessionIdentity("user-a", "org-a", "dashboard:session-b");
    const sessionC = hostedLearningSessionIdentity("user-a", "org-a", "dashboard:session-c");
    assert.equal(
      sessionA,
      learningSessionIdentity({ userId: "user-a", orgId: "org-a" }, "dashboard:session-a"),
    );
    const admission = {
      userId: "user-a",
      orgId: "org-a",
      sessionKeyHash: sessionA,
      requestKey: "outcome-before-idle",
      jobInput: { userId: "user-a", orgId: "org-a", sessionKey: "dashboard:session-a" },
    };
    const beforeIdle = await store.enqueueHostedLearningCheckpointJob(admission, {
      now: new Date("2026-08-09T02:00:00.000Z"),
      policy: { minCheckpointIntervalMs: 0, sessionIdleResetMs: 60_000 },
      idGenerator: () => "checkpoint-a-before-idle",
    });
    const afterIdle = await store.enqueueHostedLearningCheckpointJob({
      ...admission,
      requestKey: "outcome-after-idle",
    }, {
      now: new Date("2026-08-09T02:31:00.000Z"),
      policy: { minCheckpointIntervalMs: 0, sessionIdleResetMs: 60_000 },
      idGenerator: () => "checkpoint-a-after-idle",
    });
    assert.deepEqual(
      [beforeIdle.admitted, beforeIdle.sessionSpent, afterIdle.admitted, afterIdle.sessionSpent],
      [true, 1, true, 1],
    );
    assert.equal((await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionA, beforeIdle.jobId!,
      [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible" }],
    )).length, 1);
    assert.deepEqual(await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionA, afterIdle.jobId!,
      [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible after idle resume" }],
    ), []);

    for (let index = 0; index < 20; index += 1) {
      const changed = await store.noteHostedLearningOutcomes(
        "user-a", "org-a", sessionA, `checkpoint-a-later-${index}`,
        [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible" }],
        new Date(Date.parse("2026-08-09T02:32:00.000Z") + index * 1_000),
      );
      assert.equal(changed.length, 0);
    }
    // A delayed retry after more than sixteen later jobs is still the same
    // session observation; there is no recent-N idempotency window to fall out.
    assert.deepEqual(await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionA, beforeIdle.jobId!,
      [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible" }],
    ), []);

    const distinct = await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionB, "checkpoint-b-1",
      [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible again" }],
    );
    assert.equal(distinct.length, 1);

    const concurrent = await Promise.all([
      store.noteHostedLearningOutcomes(
        "user-a", "org-a", sessionC, "checkpoint-c-1",
        [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible concurrently" }],
      ),
      store.noteHostedLearningOutcomes(
        "user-a", "org-a", sessionC, "checkpoint-c-2",
        [{ id: reviewed.item.id, outcome: "confirmed", detail: "the release ancestry remained visible concurrently" }],
      ),
    ]);
    assert.equal(concurrent[0].length + concurrent[1].length, 1);

    const beforeContradiction = await store.getHostedLearnedRecordByItemId(
      "user-a", "org-a", reviewed.item.id,
    );
    assert.equal((beforeContradiction?.metadata.learned as any)?.outcome?.confirmations, 3);

    const contradicted = await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionA, "checkpoint-a-contradiction",
      [{ id: reviewed.item.id, outcome: "contradicted", detail: "the squash merge preserved every required ancestry edge" }],
      new Date("2026-08-09T03:00:00.000Z"),
    );
    assert.equal(contradicted.length, 1);
    assert.equal(contradicted[0]?.status, "archived");
    assert.equal((contradicted[0]?.metadata.learned as any)?.status, "retired");
    assert.equal((contradicted[0]?.metadata.learned as any)?.outcome?.confirmations, 2);
    assert.equal((contradicted[0]?.metadata.learned as any)?.outcome?.contradictions, 1);

    assert.deepEqual(await store.noteHostedLearningOutcomes(
      "user-a", "org-a", sessionA, "checkpoint-a-later-confirmation",
      [{ id: reviewed.item.id, outcome: "confirmed", detail: "a later success cannot erase the falsifier" }],
    ), []);
    const observations = await client.query(
      `SELECT session_identity, outcome FROM hosted_learning_outcome_observations
        WHERE org_id = $1 AND user_id = $2 AND item_id = $3
        ORDER BY session_identity`,
      ["org-a", "user-a", reviewed.item.id],
    );
    assert.deepEqual(observations.rows, [
      { session_identity: sessionA, outcome: "contradicted" },
      { session_identity: sessionB, outcome: "confirmed" },
      { session_identity: sessionC, outcome: "confirmed" },
    ].sort((left, right) => left.session_identity.localeCompare(right.session_identity)));

    // One hosted session and one device session share the same central item.
    // Upgrading only the device observation must preserve the hosted one.
    const mixed = buildHostedHumanCorrection({
      tenant: { userId: "user-a", orgId: "org-a" },
      sessionKey: "hosted-correction:mixed-runtime",
      statement: "Run the focused migration check before seeding mixed-runtime data.",
      falsifier: "seeding succeeds without the focused migration check",
      expectation: "mixed-runtime seeding remains deterministic",
      now: new Date("2026-08-09T04:00:00.000Z"),
    });
    assert.equal(mixed.admitted, true);
    if (!mixed.admitted) return;
    await engine.recordLesson("user-a", mixed.item.statement, {
      orgId: "org-a",
      sessionKey: mixed.item.provenance.sessionKey,
      learned: hostedLearnedMetadata(mixed.item),
    });
    const hostedSession = learningSessionIdentity(
      { userId: "user-a", orgId: "org-a" },
      "hosted:shared-item",
    );
    const deviceSession = learningSessionIdentity(
      { userId: "user-a", orgId: "org-a" },
      "device:shared-item",
    );
    assert.equal((await store.noteHostedLearningOutcomes(
      "user-a", "org-a", hostedSession, "hosted-shared-confirmation",
      [{ id: mixed.item.id, outcome: "confirmed", detail: "hosted seeding remained deterministic" }],
    )).length, 1);
    assert.equal((await store.noteHostedLearningOutcomes(
      "user-a", "org-a", deviceSession, "device-shared-confirmation",
      [{ id: mixed.item.id, outcome: "confirmed", detail: "device seeding remained deterministic" }],
    )).length, 1);
    const mixedContradiction = await store.noteHostedLearningOutcomes(
      "user-a", "org-a", deviceSession, "device-shared-contradiction",
      [{ id: mixed.item.id, outcome: "contradicted", detail: "device seeding succeeded without the check" }],
    );
    assert.equal((mixedContradiction[0]?.metadata.learned as any)?.outcome?.confirmations, 1);
    assert.equal((mixedContradiction[0]?.metadata.learned as any)?.outcome?.contradictions, 1);
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});

test("ADR-032 hosted retirement cursor eventually covers more than one bounded partition", async () => {
  const { store, url, cleanup } = await createTestEngine();
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const count = 205;
    const recordIds: string[] = [];
    const createdTimes: string[] = [];
    const contents: string[] = [];
    const metadata: string[] = [];
    const statuses: string[] = [];
    const archived: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const recordId = `retirement-${index.toString().padStart(3, "0")}`;
      const itemId = `lrn_${index.toString(16).padStart(18, "0")}`;
      const createdAt = new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString();
      const learnedStatus = index % 2 === 0 ? "active" : "demoted";
      recordIds.push(recordId);
      createdTimes.push(createdAt);
      contents.push(`Retirement cursor lesson ${index}`);
      statuses.push(learnedStatus === "active" ? "active" : "archived");
      archived.push(learnedStatus === "active" ? 0 : 1);
      metadata.push(JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId,
          tier: "evidence",
          origin: "model-inferred",
          form: "lesson",
          status: learnedStatus,
          createdAt,
          updatedAt: createdAt,
          falsifier: `cursor lesson ${index} is contradicted`,
          expectation: `cursor lesson ${index} remains useful`,
          provenance: {
            sessionKey: "retirement-seed",
            capturedAt: createdAt,
            checkpoint: "turn-end",
            evidence: [],
            sawUntrustedContent: false,
            gateReasoning: "real Postgres cursor coverage fixture",
          },
          outcome: { retrievals: 0, confirmations: 0, contradictions: 0 },
        },
      }));
    }
    await client.query(
      `INSERT INTO cognitive_records
        (record_id, user_id, org_id, session_key, content, type, created_time,
         updated_time, metadata_json, status, archived)
       SELECT seeded.record_id, 'cursor-user', 'cursor-org', 'retirement-seed',
              seeded.content, 'lesson', seeded.created_time, seeded.created_time,
              seeded.metadata_json, seeded.status, seeded.archived
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[])
           AS seeded(record_id, created_time, content, metadata_json, status, archived)`,
      [recordIds, createdTimes, contents, metadata, statuses, archived],
    );

    const first = await store.takeHostedLearnedRetirementBatch(
      "cursor-user", "cursor-org", 201, new Date("2026-08-09T03:00:00.000Z"),
    );
    const second = await store.takeHostedLearnedRetirementBatch(
      "cursor-user", "cursor-org", 201, new Date("2026-08-09T03:01:00.000Z"),
    );

    assert.equal(first.length, 201);
    assert.deepEqual(first.slice(0, 2).map((record) => record.id), ["retirement-000", "retirement-001"]);
    assert.deepEqual(second.slice(0, 5).map((record) => record.id), [
      "retirement-201", "retirement-202", "retirement-203", "retirement-204", "retirement-000",
    ]);
    assert.equal(new Set([...first, ...second].map((record) => record.id)).size, count);
    const cursor = await client.query(
      `SELECT org_id, user_id, last_created_time, last_record_id
         FROM hosted_learning_retirement_cursors
        WHERE org_id = $1 AND user_id = $2`,
      ["cursor-org", "cursor-user"],
    );
    assert.deepEqual(cursor.rows[0], {
      org_id: "cursor-org",
      user_id: "cursor-user",
      last_created_time: createdTimes[196],
      last_record_id: "retirement-196",
    });
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});
