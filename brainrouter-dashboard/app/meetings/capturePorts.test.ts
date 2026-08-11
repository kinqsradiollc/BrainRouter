/**
 * ADR-035 — the WIRING between the browser and the capture surface, driven.
 *
 * `captureSurface.test.ts` presses Record and reads what reached the POST, but
 * it builds its own ports by construction, so nothing it can do says which
 * objects the real page hands over. Measured on the build before this file
 * existed: replacing `browserCaptureLocks()` with a manager-less `CaptureLocks`
 * — the exact object a dashboard served over plain http gets — left every test
 * green while every cross-tab guard in the product started answering "nobody is
 * writing" to every question, including the two that delete audio.
 *
 * So the three wires that can lose a meeting are asked here, of the same module
 * `page.tsx` calls: are the locks over the browser's real lock table, does the
 * POST carry the workspace the SURFACE froze rather than the one the switcher is
 * showing, and does a microphone that opens into a recorder that cannot be
 * constructed get handed back.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { browserCapturePorts, openBrowserMicrophone, type PageBridge } from "./capturePorts";

/** A bridge whose org can be moved, as ADR-019's switcher moves it. */
function bridge(overrides: Partial<PageBridge> = {}): PageBridge {
  return {
    activeOrgId: () => "org-switched-to",
    otherBusy: () => false,
    onCreated: () => undefined,
    ...overrides,
  };
}

/**
 * Swap globals for the length of one step, and put the real ones back.
 *
 * Awaited, deliberately: a version that restored synchronously would put the
 * real `navigator` back while the code under test was still suspended at an
 * await, which is a fixture that only tests what happens before the first one.
 */
async function withGlobals<T>(patch: Record<string, unknown>, run: () => Promise<T> | T): Promise<T> {
  const previous = Object.entries(patch).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(patch)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

test("the locks port is this browser's real lock table, not a stand-in that answers nothing", async () => {
  const held: string[] = [];
  const manager = {
    request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
      held.push(name);
      // Never resolved: a Web Lock's callback promise IS the lock's lifetime.
      void callback({ name });
      return undefined;
    },
    query: async () => ({ held: held.map((name) => ({ name })) }),
  };

  const ports = await withGlobals({ navigator: { locks: manager } }, () => browserCapturePorts(bridge()));
  assert.equal(ports.locks.available, true, "the page's locks can answer 'is another tab writing to this?'");
  assert.equal(await ports.locks.hold("mtg-wired"), "held");
  assert.deepEqual(held, ["brainrouter:meeting-capture:mtg-wired"], "and the request reached the browser's own manager");
  const writers = await ports.locks.writers();
  assert.equal(writers.known, true);
  assert.equal(writers.ids.has("mtg-wired"), true);

  // …and on a browser that has none — older Safari and Firefox, some in-app
  // browsers — the port says so rather than reporting an empty set as an answer.
  // The surface prints `CAPTURE_LOCKS_UNAVAILABLE` for exactly this, and the two
  // paths that can destroy a recording ask the person before they act.
  const bare = await withGlobals({ navigator: {} }, () => browserCapturePorts(bridge()));
  assert.equal(bare.locks.available, false);
  assert.equal((await bare.locks.writers()).known, false);
});

test("open question 5 — the POST carries the workspace the surface froze, not the one the switcher is showing", async () => {
  // The last hop, and the one nothing watched: `captureSurface` computes
  // `orgId` from the session's frozen scope and hands it over, and this is where
  // it becomes a header. Reading `page.activeOrgId()` here instead would land an
  // hour of somebody's audio in whichever workspace was selected at Create —
  // with every test upstream of this line still passing.
  const calls: { url: string; init: RequestInit }[] = [];
  const ports = await withGlobals({ navigator: {} }, () => browserCapturePorts(bridge()));
  const created = await withGlobals(
    {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: "mtg-9" }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    () => ports.createMeeting({ title: "Board review", transcript: "spoken words", template: "general", orgId: "org-recorded-in" }),
  );

  assert.equal(created.id, "mtg-9");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/meetings$/);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-BrainRouter-Org"], "org-recorded-in", "the meeting lands in the workspace it was recorded in");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    title: "Board review",
    transcript: "spoken words",
    template: "general",
  });
});

test("the switcher's workspace reaches the surface as a reading, not a value captured once", async () => {
  // The surface is built ONCE per mount and must never be rebuilt — rebuilding
  // it drops the recording it is holding. So the org has to arrive as a
  // question, or a meeting recorded after a workspace switch is scoped to
  // whichever workspace was open when the page mounted.
  let current = "org-first";
  const ports = await withGlobals({ navigator: {} }, () => browserCapturePorts(bridge({ activeOrgId: () => current })));
  assert.equal(ports.activeOrgId(), "org-first");
  current = "org-second";
  assert.equal(ports.activeOrgId(), "org-second");
});

test("a microphone whose recorder cannot be constructed is handed straight back", async () => {
  // `onstop` is what stops the tracks, and it never fires for a recorder that
  // was never built — so without the release the microphone light stays on with
  // nothing recording it, on a page that reported a failure and moved on.
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }, { stop: () => { stopped += 1; } }] };
  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
      MediaRecorder: class { constructor() { throw new Error("no recorder for this stream"); } },
    },
    () => assert.rejects(openBrowserMicrophone(), /no recorder for this stream/),
  );
  assert.equal(stopped, 2, "every track of the stream is stopped");
});
