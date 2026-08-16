import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTES_EDITING_CONTRACT_VERSION,
  type NoteBlock,
  type NotesMutationResponse,
  type NotesMutationSyncReport,
} from "@kinqs/brainrouter-ui/notes";

import {
  mutationDisposition,
  notesLeaseGrant,
  notesMutationRequest,
  notesMutationResponse,
  projectNotes,
} from "./notesAdapter";

const at = (physical: number) => ({ physical, logical: 0, deviceId: "dashboard-test" });
const stamped = <T,>(value: T, physical = 1) => ({ value, at: at(physical) });

function block(
  id: string,
  parentId: string | null,
  rank: string,
  kind: NoteBlock["kind"]["value"],
  text: string,
  extra: Partial<NoteBlock> = {},
): NoteBlock {
  return {
    id,
    parentId: stamped(parentId),
    rank: stamped(rank),
    kind: stamped(kind),
    text: stamped(text),
    ...extra,
  };
}

const history = {
  scope: "remote",
  canUndo: false,
  canRedo: false,
  reason: "remote_history_unavailable",
  detail: "Remote history is unavailable.",
} as const;

const emptySync = (): NotesMutationSyncReport => ({ accepted: [], rejected: [], fenced: [] });

function success(
  result: unknown,
  sync: NotesMutationSyncReport = emptySync(),
): NotesMutationResponse {
  return {
    version: NOTES_EDITING_CONTRACT_VERSION,
    requestId: "request-1",
    operation: "block.update",
    ok: true,
    result,
    sync,
    history,
  };
}

test("ADR-038 mutation envelopes contain only the shared request contract", () => {
  const request = notesMutationRequest("request-1", "device-1", {
    type: "block.update",
    blockId: "block-1",
    patch: { text: "Saved remotely" },
    leaseEpoch: 7,
  });

  assert.deepEqual(Object.keys(request).sort(), ["deviceId", "operation", "requestId", "version"]);
  assert.equal(request.version, NOTES_EDITING_CONTRACT_VERSION);
  assert.equal(request.requestId, "request-1");
  assert.equal(request.deviceId, "device-1");
  assert.equal("orgId" in request, false);
  assert.equal("userId" in request, false);
});

test("ADR-038 rejects malformed mutation responses before reconciliation", () => {
  assert.equal(notesMutationResponse({}), null);
  assert.equal(notesMutationResponse({
    ...success({ block: { id: "block-1" } }),
    sync: {},
  }), null);
  assert.equal(notesMutationResponse({
    ...success({ block: { id: "block-1" } }),
    operation: "dashboard-only-operation",
  }), null);
  assert.equal(notesMutationResponse({
    ...success({ block: { id: "block-1" } }),
    operation: "unknown",
  }), null);
  assert.deepEqual(notesMutationResponse(success({ block: { id: "block-1" } })), success({ block: { id: "block-1" } }));
});

test("ADR-038 never treats replay, rejection, or fencing as visible success", () => {
  assert.equal(mutationDisposition(success({ block: { id: "block-1" } })).applied, true);

  const replay = mutationDisposition(success({
    replayed: true,
    refreshRequired: true,
    detail: "Already applied; reload.",
  }));
  assert.equal(replay.applied, false);
  assert.equal(replay.refreshRequired, true);

  const rejected = mutationDisposition(success({}, {
    accepted: [],
    rejected: [{ idempotencyKey: "request-1:0", reason: "policy refused" }],
    fenced: [],
  }));
  assert.equal(rejected.applied, false);
  assert.equal(rejected.detail, "policy refused");

  const fenced = mutationDisposition(success({}, {
    accepted: [],
    rejected: [],
    fenced: [{ idempotencyKey: "request-1:0", itemId: "block-1", reason: "stale_epoch" }],
  }));
  assert.equal(fenced.applied, false);
  assert.deepEqual(fenced.fencedIds, ["block-1"]);
  assert.match(fenced.detail ?? "", /Another editor won the lock/);
});

test("ADR-038 accepts a lease only for the requested block and stable Dashboard device", () => {
  const result = {
    lease: {
      blockId: "block-1",
      deviceId: "device-1",
      holder: "Dashboard",
      epoch: 4,
      expiresAt: 2_000,
    },
  };
  assert.deepEqual(notesLeaseGrant(result, "block-1", "device-1"), {
    epoch: 4,
    holder: "Dashboard",
  });
  assert.equal(notesLeaseGrant(result, "block-2", "device-1"), null);
  assert.equal(notesLeaseGrant(result, "block-1", "device-2"), null);
  assert.equal(notesLeaseGrant({ lease: { ...result.lease, epoch: 0 } }, "block-1", "device-1"), null);
});

test("ADR-038 projects tree order, repairs, references, locks, and templates through the shared facade", () => {
  const blocks = [
    block("second", "page", "b", "numbered", "Second"),
    block("page", null, "a", "page", "Plan", { template: stamped(true) }),
    block("missing", "gone", "a", "paragraph", "Recovered root"),
    block("first", "page", "a", "numbered", "See brainrouter://planner/item/task-1", {
      conflicts: {
        text: {
          ours: "Mine",
          theirs: "Theirs",
          oursAt: at(4),
          theirsAt: at(5),
          reason: "concurrent_text",
        },
      },
    }),
  ];

  const projected = projectNotes(blocks, { first: "Sam is editing this block." });
  assert.deepEqual(projected.blocks.map((row) => row.id), ["missing", "page", "first", "second"]);
  assert.deepEqual(projected.blocks.filter((row) => row.kind === "numbered").map((row) => row.ordinal), [1, 2]);
  assert.deepEqual(projected.blocks.find((row) => row.id === "first")?.refs, ["brainrouter://planner/item/task-1"]);
  assert.equal(projected.blocks.find((row) => row.id === "first")?.lockedBy, "Sam is editing this block.");
  assert.deepEqual(projected.blocks.find((row) => row.id === "first")?.conflicts, [{
    field: "text",
    reason: "concurrent_text",
    oursAt: at(4),
    theirsAt: at(5),
  }]);
  assert.deepEqual(projected.repairs, [{
    blockId: "missing",
    reason: "missing_parent",
    claimedParentId: "gone",
  }]);
  assert.deepEqual(projected.templates, [{ id: "page", title: "Plan", icon: null, blocks: 3 }]);
});
