/**
 * ADR-032 Q4 — pure and HTTP-boundary checks for hosted corrections.
 *
 * These tests run directly with node:test + tsx because the dashboard does not
 * add a workspace test script; no browser, server, or external network is used.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  hostedHumanCorrectionErrors,
  learnedBehaviorsApi,
  normalizeHostedHumanCorrection,
  upsertHostedLearnedBehavior,
  type HostedHumanCorrectionInput,
  type HostedLearnedBehavior,
} from "./learnedBehaviors";

function behavior(id: string, statement = id): HostedLearnedBehavior {
  return {
    id,
    recordId: `record-${id}`,
    statement,
    tier: "instruction",
    origin: "human-correction",
    form: "lesson",
    status: "active",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    falsifier: "A contrary result is observed",
    expectation: "Review accuracy improves",
    allowedTools: [],
    provenance: {
      sessionKey: "hosted-correction:abc",
      capturedAt: "2026-08-09T00:00:00.000Z",
      checkpoint: "session-end",
      evidence: [],
      corroboratingActionIds: [],
      sawUntrustedContent: false,
      gateReasoning: "corrected in session by a person",
    },
    outcome: { retrievals: 0, confirmations: 0, contradictions: 0 },
    centralMemory: { status: "active", archived: false, updatedAt: "2026-08-09T00:00:00.000Z" },
  };
}

const validCorrection: HostedHumanCorrectionInput = {
  sessionKey: "chat_1720000000000_ab12cd",
  statement: "Use the release branch as the readiness comparison base.",
  falsifier: "The task explicitly identifies another comparison branch.",
  expectation: "Readiness reports exclude unrelated branch history.",
};

test("hosted correction validation enforces bounded structured fields", () => {
  assert.deepEqual(hostedHumanCorrectionErrors(validCorrection), {}, "a valid correction has no field errors");
});

test("hosted correction validation rejects unsafe session keys and unfalsifiable drafts", () => {
  const errors = hostedHumanCorrectionErrors({
    sessionKey: "chat/key",
    statement: "too short",
    falsifier: "too vague",
    expectation: "",
  });
  assert.match(errors.sessionKey ?? "", /letters, numbers/);
  assert.match(errors.statement ?? "", /at least 12/);
  assert.match(errors.falsifier ?? "", /at least three words/);
  assert.match(errors.expectation ?? "", /improvement/);
});

test("hosted correction normalization trims every field and returned items upsert at the front", () => {
  assert.deepEqual(normalizeHostedHumanCorrection({
    sessionKey: " chat-1 ",
    statement: " correction statement ",
    falsifier: " contrary observable result ",
    expectation: " expected improvement ",
  }), {
    sessionKey: "chat-1",
    statement: "correction statement",
    falsifier: "contrary observable result",
    expectation: "expected improvement",
  });
  assert.deepEqual(
    upsertHostedLearnedBehavior([behavior("existing"), behavior("other")], behavior("existing", "updated"))
      .map((item) => [item.id, item.statement]),
    [["existing", "updated"], ["other", "other"]],
  );
});

test("hosted correction request pins the active org in auth and sends only four correction fields", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      item: behavior("lrn_1234567890abcdef12"),
      reinforced: false,
      source: "authenticated-human-correction",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    await learnedBehaviorsApi.correct("org-active", validCorrection);
    assert.equal(capturedUrl.endsWith("/api/learned-behaviors/correct"), true);
    assert.equal((capturedInit?.headers as Record<string, string>)["X-BrainRouter-Org"], "org-active");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), validCorrection);
    assert.equal(
      Object.prototype.hasOwnProperty.call(JSON.parse(String(capturedInit?.body)), "orgId"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
