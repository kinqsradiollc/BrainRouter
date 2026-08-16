/**
 * ADR-035 D11 — what the server will and will not hold for a browser recording.
 *
 * The interesting cases are all refusals and deletions: this is the path that keeps a
 * copy of somebody's meeting off their own device, so what it declines to store, and what
 * it deletes without being asked, is the whole of the promise.
 */
import { describe, expect, it } from "vitest";

import { deleteEscrow, listEscrow, MeetingEscrowRejected, putEscrow, type MeetingEscrowStore } from "./escrow.js";
import type { MeetingEscrowRow, UpsertMeetingEscrowInput } from "../store/postgres/queries/meetingEscrowQueries.js";

const SESSION = "mtg-2026-08-12-abcdef";

function fakeStore(seed: MeetingEscrowRow[] = []) {
  const rows = new Map<string, MeetingEscrowRow>(seed.map((row) => [row.sessionId, row]));
  const swept: string[] = [];
  const store: MeetingEscrowStore & { rows: Map<string, MeetingEscrowRow>; swept: string[]; expire: (id: string) => void } = {
    rows,
    swept,
    expire: (id: string) => swept.push(id),
    async upsertMeetingEscrow(_orgId: string, _userId: string, input: UpsertMeetingEscrowInput) {
      const existing = rows.get(input.sessionId);
      rows.set(input.sessionId, {
        ...input,
        // The identity of the recording, which an update may not move.
        startedAt: existing?.startedAt ?? input.startedAt,
        updatedAt: "2026-08-12T12:00:00.000Z",
      });
    },
    async listMeetingEscrow() { return [...rows.values()]; },
    async countMeetingEscrow() { return rows.size; },
    async meetingEscrowExists(_orgId: string, _userId: string, sessionId: string) { return rows.has(sessionId); },
    async deleteMeetingEscrow(_orgId: string, _userId: string, sessionId: string) { return rows.delete(sessionId); },
    async deleteExpiredMeetingEscrow() {
      const gone = swept.splice(0, swept.length);
      for (const id of gone) rows.delete(id);
      return gone;
    },
  };
  return store;
}

function escrowInput(over: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    title: "Planning",
    template: "standup",
    language: "en",
    startedAt: "2026-08-12T09:00:00.000Z",
    transcript: "we agreed on the plan",
    coverageMs: 60_000,
    retentionDays: 7,
    ...over,
  };
}

describe("ADR-035 D11 capture escrow", () => {
  it("holds a capture the browser pushed, under the id in the request", async () => {
    const store = fakeStore();
    const held = await putEscrow("user-1", "org-1", escrowInput(), store);
    expect(held.sessionId).toBe(SESSION);
    expect(held.transcript).toBe("we agreed on the plan");
    expect(store.rows.get(SESSION)?.retentionDays).toBe(7);
  });

  it("refuses a body that is not a capture at all", async () => {
    const store = fakeStore();
    await expect(putEscrow("user-1", "org-1", escrowInput({ sessionId: "../etc/passwd" }), store)).rejects.toBeInstanceOf(MeetingEscrowRejected);
    await expect(putEscrow("user-1", "org-1", escrowInput({ startedAt: "whenever" }), store)).rejects.toBeInstanceOf(MeetingEscrowRejected);
    expect(store.rows.size).toBe(0);
  });

  it("refuses a capture with no words in it, which could never become a meeting", async () => {
    const store = fakeStore();
    await expect(putEscrow("user-1", "org-1", escrowInput({ transcript: "   " }), store)).rejects.toBeInstanceOf(MeetingEscrowRejected);
    expect(store.rows.size).toBe(0);
  });

  it("keeps taking pushes for a capture already held once the per-user bound is reached", async () => {
    const store = fakeStore();
    for (let n = 0; n < 50; n += 1) {
      await putEscrow("user-1", "org-1", escrowInput({ sessionId: `mtg-2026-08-12-${String(n).padStart(6, "0")}` }), store);
    }
    // A NEW capture is refused — the bound is on how many one person may have open…
    await expect(putEscrow("user-1", "org-1", escrowInput({ sessionId: "mtg-2026-08-12-zzzzzz" }), store)).rejects.toBeInstanceOf(MeetingEscrowRejected);
    // …and the recording that is happening RIGHT NOW is never stranded by it.
    const updated = await putEscrow("user-1", "org-1", escrowInput({ sessionId: "mtg-2026-08-12-000007", transcript: "more words" }), store);
    expect(updated.transcript).toBe("more words");
  });

  it("clamps rather than refusing what a person typed", async () => {
    const store = fakeStore();
    const held = await putEscrow("user-1", "org-1", escrowInput({
      title: "t".repeat(500),
      template: "not-a-template",
      retentionDays: 5_000,
      coverageMs: -3,
    }), store);
    expect(held.title.length).toBe(300);
    expect(held.template).toBe("general");
    expect(held.retentionDays).toBe(365);
    expect(held.coverageMs).toBe(0);
  });

  it("sweeps what has outlived its own window before answering with what is held", async () => {
    const store = fakeStore();
    await putEscrow("user-1", "org-1", escrowInput(), store);
    await putEscrow("user-1", "org-1", escrowInput({ sessionId: "mtg-2026-07-01-aaaaaa", startedAt: "2026-07-01T09:00:00.000Z" }), store);
    store.expire("mtg-2026-07-01-aaaaaa");
    const answer = await listEscrow("user-1", "org-1", store);
    expect(answer.expired).toEqual(["mtg-2026-07-01-aaaaaa"]);
    expect(answer.captures.map((capture) => capture.sessionId)).toEqual([SESSION]);
  });

  it("leaves a row it cannot read in place rather than deleting it", async () => {
    const store = fakeStore([{
      sessionId: SESSION,
      title: "", template: "general", language: "", transcript: "words",
      coverageMs: 0, retentionDays: 30, startedAt: "", updatedAt: "2026-08-01T00:00:00.000Z",
    }]);
    const answer = await listEscrow("user-1", "org-1", store);
    expect(answer.captures).toEqual([]);
    expect(store.rows.size).toBe(1);
  });

  it("stops holding a capture that was filed or discarded", async () => {
    const store = fakeStore();
    await putEscrow("user-1", "org-1", escrowInput(), store);
    expect(await deleteEscrow("user-1", "org-1", SESSION, store)).toBe(true);
    expect(store.rows.size).toBe(0);
    // And says so plainly when there was nothing to delete: the caller's intent is that
    // the server must not be holding it, which is already true.
    expect(await deleteEscrow("user-1", "org-1", SESSION, store)).toBe(false);
  });
});
