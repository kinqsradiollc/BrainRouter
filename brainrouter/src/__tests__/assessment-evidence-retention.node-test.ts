import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";

const old = "2026-06-01T00:00:00.000Z";
const fresh = "2026-07-29T00:00:00.000Z";
const now = "2026-07-30T00:00:00.000Z";

function assessmentInput() {
  return {
    orgId: "org-1",
    assessmentPolicy: {
      evidence: { retentionDays: 30 },
    },
  };
}

test("authorized-assessment evidence expiry protects active and fresh jobs and is idempotent", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    const expired = await store.enqueueMemoryJob({
      kind: "domain-pentest",
      input: assessmentInput(),
    }, { now: old });
    await store.claimNextMemoryJob({ now: old });
    await store.appendJobProgress(expired.id, {
      ts: old,
      kind: "runtime-observation",
      msg: "sensitive response body",
    });
    await store.completeMemoryJob(expired.id, {
      findings: 1,
      blocking: 1,
      findingsDetail: [{ severity: "high", details: "sensitive response body" }],
      summary: "sensitive summary",
      workspaceRoot: "/tmp/raw-workspace",
      sarifPath: "/tmp/raw-workspace/findings.sarif",
    }, { now: old });

    const active = await store.enqueueMemoryJob({
      kind: "pr-pentest",
      input: assessmentInput(),
    }, { now: old });
    await store.claimNextMemoryJob({ now: old });

    const recent = await store.enqueueMemoryJob({
      kind: "pr-pentest",
      input: assessmentInput(),
    }, { now: fresh });
    await store.startMemoryJob(recent.id, { now: fresh });
    await store.completeMemoryJob(recent.id, {
      findings: 1,
      findingsDetail: [{ severity: "low", details: "still retained" }],
    }, { now: fresh });

    const result = await store.expireAuthorizedAssessmentEvidence({ now });
    assert.equal(result.jobsExpired, 1);
    assert.equal(result.evidenceRowsDeleted, 0);

    const expiredAfter = await store.getMemoryJob(expired.id);
    assert.equal(expiredAfter?.status, "done");
    assert.equal((expiredAfter?.output as Record<string, unknown>).findings, 1);
    assert.equal((expiredAfter?.output as Record<string, unknown>).blocking, 1);
    assert.equal(
      (expiredAfter?.output as Record<string, unknown>).evidenceExpiredAt,
      now,
    );
    assert.equal(
      (expiredAfter?.output as Record<string, unknown>).evidenceRetentionDays,
      30,
    );
    assert.equal("findingsDetail" in (expiredAfter?.output as object), false);
    assert.equal("workspaceRoot" in (expiredAfter?.output as object), false);
    assert.deepEqual(expiredAfter?.progress, [{
      ts: now,
      kind: "retention",
      msg: "Detailed assessment evidence expired according to policy.",
    }]);

    const activeAfter = await store.getMemoryJob(active.id);
    assert.equal(activeAfter?.status, "running");
    assert.equal(activeAfter?.output, null);

    const recentAfter = await store.getMemoryJob(recent.id);
    assert.equal(
      Array.isArray((recentAfter?.output as Record<string, unknown>).findingsDetail),
      true,
    );

    assert.deepEqual(await store.expireAuthorizedAssessmentEvidence({ now }), {
      jobsExpired: 0,
      evidenceRowsDeleted: 0,
      findingsScrubbed: 0,
      stageReceiptsScrubbed: 0,
      sourceReceiptsScrubbed: 0,
    });
  } finally {
    await cleanup();
  }
});
