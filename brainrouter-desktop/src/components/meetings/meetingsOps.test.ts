import assert from "node:assert/strict";
import test from "node:test";
import { createMeetingsOps, MeetingsUnavailableError } from "./meetingsOps.js";

function setBridge(meetings?: Record<string, (...args: never[]) => Promise<unknown>>): void {
  (globalThis as unknown as { brainrouter?: unknown }).brainrouter = meetings ? { meetings } : undefined;
}

test("Meetings ops reports an explicit unavailable state instead of sample data", async () => {
  setBridge();
  const ops = createMeetingsOps();
  await assert.rejects(() => ops.list(), MeetingsUnavailableError);
  await assert.rejects(() => ops.serverTracks(), MeetingsUnavailableError);
});

test("Meetings ops preserves list and transcript pagination", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  setBridge({
    list: async (...args: never[]) => { calls.push({ method: "list", args }); return { meetings: [{ id: "m1" }], nextCursor: "next" }; },
    transcript: async (...args: never[]) => { calls.push({ method: "transcript", args }); return { segments: [], total: 201, nextCursor: "100" }; },
  });
  const ops = createMeetingsOps();
  assert.equal((await ops.listPage({ limit: 25, cursor: "cur" })).nextCursor, "next");
  assert.equal((await ops.transcriptPage("m1", { limit: 100, cursor: "0" })).total, 201);
  assert.deepEqual(calls, [
    { method: "list", args: [{ limit: 25, cursor: "cur" }] },
    { method: "transcript", args: ["m1", { limit: 100, cursor: "0" }] },
  ]);
});

test("Meetings ops exposes create, summary, audio, full Track transition, and remove", async () => {
  const calls: string[] = [];
  const bridge = new Proxy({}, {
    get: (_target, property) => async () => {
      calls.push(String(property));
      if (property === "create") return { id: "m1", summaryStatus: "processing" };
      if (property === "updateSummary" || property === "regenerate") return { id: "m1" };
      if (property === "transcribe") return { text: "hello" };
      if (property === "serverTrackCreate" || property === "serverTrackTransition") return { item: { id: "wi_1", statusCategory: "in_progress" } };
      return { ok: true };
    },
  }) as Record<string, (...args: never[]) => Promise<unknown>>;
  setBridge(bridge);
  const ops = createMeetingsOps();
  await ops.createFromTranscript({ title: "Sync", transcript: "Hello" });
  await ops.updateSummary("m1", "# Notes");
  assert.equal((await ops.transcribeAudio({ bytes: new Uint8Array([1]) })).text, "hello");
  await ops.serverTrackCreate({ title: "Ship" });
  assert.equal((await ops.serverTrackTransition("wi_1", "in_progress")).statusCategory, "in_progress");
  await ops.serverTrackRemove("wi_1");
  assert.deepEqual(calls, ["create", "updateSummary", "transcribe", "serverTrackCreate", "serverTrackTransition", "serverTrackRemove"]);
});
