/**
 * ADR-035 D1/D2 — the renderer's half of the capture contract.
 *
 * Two things are worth asserting here and nothing else is: that a build whose
 * preload has no capture channels says so instead of pretending (ADR-028), and
 * that the scope a capture is started under is the one that crosses the bridge —
 * open question 5 is only answered if the org actually travels with the session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMeetingCaptureOps, MeetingCaptureUnavailableError } from "./captureOps.js";

function setBridge(meetings?: Record<string, (...args: never[]) => Promise<unknown>>): void {
  (globalThis as unknown as { brainrouter?: unknown }).brainrouter = meetings ? { meetings } : undefined;
}

const SESSION = { id: "mtg-1", startedAt: "2026-01-01T00:00:00.000Z", scope: { orgId: "org_1", workspaceId: null }, title: "Sync", template: "general", status: "recording", segments: [] };

test("a build without capture channels refuses to record instead of buffering in memory", async () => {
  setBridge({ list: async () => ({ meetings: [] }) });
  const capture = createMeetingCaptureOps();

  assert.equal(capture.available, false);
  await assert.rejects(() => capture.begin({ scope: { orgId: null } }), MeetingCaptureUnavailableError);
  await assert.rejects(() => capture.append("mtg-1", new Uint8Array([1]), 20_000), MeetingCaptureUnavailableError);
  // Nothing was ever captured by such a build, so the recovery offer is empty
  // rather than an error the user cannot act on.
  assert.deepEqual(await capture.resumable({ orgId: null }), []);
});

test("the capture scope and the recorder's content type travel with the session", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  setBridge({
    captureBegin: async (...args: never[]) => { calls.push({ method: "captureBegin", args }); return SESSION; },
    captureAppend: async (...args: never[]) => { calls.push({ method: "captureAppend", args }); return SESSION; },
    captureRead: async (...args: never[]) => { calls.push({ method: "captureRead", args }); return { bytes: new Uint8Array([1, 2]), contentType: "audio/webm;codecs=opus" }; },
    captureResumable: async (...args: never[]) => { calls.push({ method: "captureResumable", args }); return [{ sessionId: "mtg-1" }]; },
  });
  const capture = createMeetingCaptureOps();

  assert.equal(capture.available, true);
  assert.equal((await capture.begin({ scope: { orgId: "org_1" }, title: "Sync", contentType: "audio/webm;codecs=opus" })).id, "mtg-1");
  await capture.append("mtg-1", new Uint8Array([1]), 20_000);
  assert.equal((await capture.read("mtg-1")).contentType, "audio/webm;codecs=opus");
  assert.equal((await capture.resumable({ orgId: "org_1" })).length, 1);

  assert.deepEqual(calls, [
    { method: "captureBegin", args: [{ title: "Sync", contentType: "audio/webm;codecs=opus", orgId: "org_1", workspaceId: null }] },
    { method: "captureAppend", args: ["mtg-1", new Uint8Array([1]), 20_000] },
    { method: "captureRead", args: ["mtg-1"] },
    { method: "captureResumable", args: [{ orgId: "org_1", workspaceId: null }] },
  ]);
});

test("a capture store that answers with the wrong shape is an error, not a silent no-op", async () => {
  setBridge({ captureBegin: async () => ({ id: "mtg-1" }), captureAppend: async () => ({ id: "mtg-1", segments: [] }), captureRead: async () => ({}) });
  const capture = createMeetingCaptureOps();

  await assert.rejects(() => capture.begin({ scope: { orgId: null } }), /invalid meeting session/);
  await assert.rejects(() => capture.read("mtg-1"), /returned no audio/);
});
