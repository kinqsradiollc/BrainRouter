/**
 * ADR-035 — the compose surface, driven the way a person drives it, asserted on
 * what reaches the POST and what the destructive controls do.
 *
 * ## What it owns
 *
 * The behaviour of `MeetingsView` between "the host persisted a segment" and
 * "this is the meeting that was created". Everything is exercised through the
 * rendered controls — press Record, push a progress event, press Stop, press
 * Create — and asserted against the fake host's recorded calls and the text on
 * screen.
 *
 * ## Why it exists, specifically
 *
 * `meetingCaptureContract.test.ts` reads this component as SOURCE TEXT. That is
 * the right tool for wiring that typechecks either way (a `MediaRecorder`
 * started without a timeslice, a channel main never registers), and it is the
 * wrong tool for anything about a value being USED: a regex sees the call, not
 * the assignment. Four one-line changes inside this component each destroy a
 * real meeting and each left that whole file green —
 *
 * - `liveRef.current = session` deleted: `submit` passes null as the session, so
 *   the settle step returns the box untouched. The POST loses its gap marker AND
 *   the segment behind it, and lands under whichever org the app-wide switcher
 *   is on rather than the one it was recorded in — while the surface printed "1
 *   segment is still being transcribed" a moment before the click.
 * - `transcriptRef.current = folded.text` deleted: the box shows only the last
 *   segment, the ref stays empty, and Create is refused `incomplete` with the
 *   button still enabled — a Create that does nothing, for ever.
 * - `holdStore.current.sessionId` respelled `hold.sessionId` in the progress
 *   subscription: the effect's deps are stable, so the closure pins the first
 *   render's empty hold and every host push is dropped.
 * - `transcript: transcriptRef.current` respelled `transcript`: `transcript` is
 *   not in `submit`'s dependency array, so Create posts the box as of the last
 *   title keystroke.
 *
 * Each one has a test below, and each test fails when that line is changed back.
 *
 * ## Invariants
 *
 * 1. **The host is a fake, the component is not.** Nothing here reaches into
 *    component state or re-implements a rule; the assertions are the POST body,
 *    the field values, the button `disabled`, and the words on screen.
 * 2. **Sessions are built explicitly.** The fake host does not simulate main. A
 *    test states the record it wants pushed, so what a rule does with an
 *    unsettled segment is visible in the test rather than emergent.
 * 3. **Globals are installed and removed per test.** `navigator`, `MediaRecorder`
 *    and `confirm` are stubbed for the duration of one test, because a leaked
 *    stub makes the NEXT test's result a property of test order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MEETING_CAPTURE_LEASE_STALE_MS,
  formatCaptureGap,
  type MeetingCaptureLease,
  type MeetingCaptureSession,
  type MeetingRecoverySummary,
  type MeetingSegment,
} from "@kinqs/brainrouter-core/meetings";
import { MeetingsView } from "./MeetingsView.js";
import { captureHolderId } from "./captureHolder.js";
import type { CreateMeetingInput, MeetingsOps } from "./types.js";
import {
  button,
  field,
  hasButton,
  isDisabled,
  mount,
  press,
  screenText,
  typeInto,
  valueOf,
  type Mounted,
} from "../../testing/reactHarness.js";

const TITLE_FIELD = "Weekly product sync";
const TRANSCRIPT_FIELD = "Paste a transcript here, or record/import audio above…";
const SEGMENT_MS = 20_000;

/** A segment as the host would have persisted it. Defaults describe the ordinary case: transcribed. */
function segment(index: number, over: Partial<MeetingSegment> = {}): MeetingSegment {
  return {
    index,
    byteLength: 4096,
    startMs: index * SEGMENT_MS,
    endMs: (index + 1) * SEGMENT_MS,
    state: "done",
    text: `Segment ${index}.`,
    attempts: 1,
    ...over,
  };
}

function session(over: Partial<MeetingCaptureSession> = {}): MeetingCaptureSession {
  return {
    id: "mtg-20260809-abcdefgh",
    startedAt: "2026-08-09T09:00:00.000Z",
    scope: { orgId: null, workspaceId: null },
    title: "",
    template: "general",
    status: "recording",
    segments: [],
    ...over,
  };
}

/** A lease that is fresh right now, belonging to whoever is named. */
function lease(holderId: string, holder = "Another window"): MeetingCaptureLease {
  return { holderId, holder, epoch: 3, heartbeatAt: new Date().toISOString() };
}

function recovery(over: Partial<MeetingRecoverySummary> = {}): MeetingRecoverySummary {
  return {
    sessionId: "mtg-20260809-abcdefgh",
    title: "Weekly sync",
    startedAt: "2026-08-09T09:00:00.000Z",
    durationMs: 40_000,
    byteLength: 8192,
    segments: 2,
    settled: 1,
    gaps: 0,
    unsettled: 1,
    ...over,
  };
}

interface CreatedMeeting {
  readonly transcript: string;
  readonly title: string;
  readonly orgId: string | undefined;
}

interface FakeHost {
  /** What the surface asked the host to do, in order. */
  readonly begun: { holderId?: string }[];
  readonly stopped: string[];
  readonly adopted: { id: string; holderId?: string }[];
  readonly finalized: { id: string; holderId?: string }[];
  readonly discarded: { id: string; holderId?: string }[];
  readonly created: CreatedMeeting[];
  /** The record the host would hand back from `begin`, `stop` and `adopt`. */
  record: MeetingCaptureSession;
  /** The offer, and its complement — what another writer is holding. */
  resumable: MeetingRecoverySummary[];
  writing: MeetingCaptureSession[];
  /** Fail the next create, so the compose form stays up and can be read. */
  createFails: boolean;
  /** Refuse the next pick-up, the way a lease held by another window does. */
  adoptRefusal: string | null;
  /** Hold `captureStop` open, which is the window `closing` covers. */
  holdStop(): () => void;
  /** Publish a persisted change, as main's broadcast does. */
  push(progress: { sessionId?: string; session: MeetingCaptureSession; phase?: string; errors?: string[]; writerLost?: string }): void;
  readonly ops: MeetingsOps;
}

function unused(): never {
  throw new Error("This meetings operation is not part of this test.");
}

/**
 * The host, as this surface can see it: the preload bridge on `globalThis`, the
 * meetings API as a prop, and the browser globals the recorder reaches for.
 *
 * Returns the teardown, which every test runs — a stubbed `navigator` left
 * behind would make the next test's result depend on the order they ran in.
 */
function installHost(): { host: FakeHost; restore: () => void } {
  const listeners = new Set<(progress: unknown) => void>();
  const host: FakeHost = {
    begun: [],
    stopped: [],
    adopted: [],
    finalized: [],
    discarded: [],
    created: [],
    record: session(),
    resumable: [],
    writing: [],
    createFails: false,
    adoptRefusal: null,
    holdStop: () => () => undefined,
    push: () => undefined,
    ops: {
      listPage: async () => ({ meetings: [], nextCursor: null }),
      list: async () => [],
      createFromTranscript: async (input: CreateMeetingInput, orgId?: string) => {
        host.created.push({ transcript: input.transcript, title: input.title, orgId });
        if (host.createFails) throw new Error("The server refused this meeting.");
        return { id: "meeting-1" };
      },
      // A successful create selects the new meeting, so the detail pane really
      // does load: these answer rather than throwing, or the assertion about the
      // POST would be racing a crash in the pane that opens after it.
      overview: async (id: string) => ({
        id, title: "Weekly sync", date: "2026-08-09", status: "Captured", originOrgId: "",
        canEdit: true, attendees: [], summaryMarkdown: "", actionItems: [],
        share: { scope: "private" as const }, summaryStatus: "ready" as const,
      }),
      transcriptPage: async () => ({ segments: [], total: 0, nextCursor: null }),
      get: unused, updateSummary: unused,
      transcribeAudio: unused, regenerateSummary: unused, deleteMeeting: unused, setScope: unused,
      sendActionToTrack: unused, unsendActionFromTrack: unused, toggleAction: unused,
      serverTracks: unused, serverTrackCreate: unused, serverTrackTransition: unused,
      serverTrackSetDone: unused, serverTrackRemove: unused,
    } as unknown as MeetingsOps,
  };

  let pendingStop: Promise<void> | null = null;
  host.holdStop = () => {
    let release = (): void => undefined;
    pendingStop = new Promise<void>((resolve) => { release = () => resolve(); });
    return () => release();
  };
  host.push = (progress) => {
    const payload = { sessionId: progress.sessionId ?? progress.session.id, ...progress };
    for (const listener of [...listeners]) listener(payload);
  };

  const meetings = {
    captureBegin: async (input: { holderId?: string }) => { host.begun.push({ ...(input.holderId ? { holderId: input.holderId } : {}) }); return host.record; },
    captureAppend: async () => host.record,
    captureStop: async (id: string) => {
      host.stopped.push(id);
      if (pendingStop) { const gate = pendingStop; pendingStop = null; await gate; }
      return host.record;
    },
    captureRead: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "audio/webm", missing: [] }),
    captureFinalize: async (id: string, holderId?: string) => { host.finalized.push({ id, ...(holderId ? { holderId } : {}) }); return { ok: true }; },
    captureDiscard: async (id: string, holderId?: string) => { host.discarded.push({ id, ...(holderId ? { holderId } : {}) }); return { ok: true }; },
    captureResumable: async () => host.resumable,
    captureWriting: async () => host.writing,
    captureAdopt: async (id: string, holderId?: string) => {
      host.adopted.push({ id, ...(holderId ? { holderId } : {}) });
      if (host.adoptRefusal) throw new Error(host.adoptRefusal);
      return host.record;
    },
    captureRetrySegment: async () => host.record,
    onCaptureProgress: (listener: (progress: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    draftRead: async () => null,
    draftWrite: async () => ({ ok: true }),
    draftClear: async () => ({ ok: true }),
  };

  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = {
    brainrouter: scope.brainrouter,
    MediaRecorder: scope.MediaRecorder,
    confirm: scope.confirm,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  scope.brainrouter = { meetings };
  scope.MediaRecorder = FakeMediaRecorder;
  scope.confirm = () => true;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => fakeStream() } },
    configurable: true,
    writable: true,
  });

  return {
    host,
    restore: () => {
      scope.brainrouter = previous.brainrouter;
      scope.MediaRecorder = previous.MediaRecorder;
      scope.confirm = previous.confirm;
      if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
      else delete scope.navigator;
    },
  };
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: () => undefined }] } as unknown as MediaStream;
}

/**
 * Just enough `MediaRecorder` for the recorder class to run.
 *
 * No audio is produced: every test here drives the transcript through the host's
 * progress channel, which is where the text actually comes from (D4). What this
 * has to get right is the LIFECYCLE — `start` with a timeslice, `stop` calling
 * `onstop` — because that is what the compose form's windows are measured
 * against.
 */
class FakeMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start(): void { this.state = "recording"; }
  pause(): void { this.state = "paused"; }
  resume(): void { this.state = "recording"; }
  stop(): void { this.state = "inactive"; this.onstop?.(); }
}

/** Open the compose form the way a person does. */
async function compose(host: FakeHost): Promise<Mounted> {
  const mounted = await mount(<MeetingsView ops={host.ops} />);
  await press(mounted, "+ New");
  return mounted;
}

function transcriptBox(mounted: Mounted): string {
  return valueOf(field(mounted.root, TRANSCRIPT_FIELD));
}

test("a segment the host persists reaches the transcript box and the live panel", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    // D4 — the host persisted a segment and broadcast it. Nothing in the
    // renderer produced this text; it arrives because the window subscribed.
    await mounted.act(() => host.push({ session: session({ segments: [segment(0, { text: "Ship on Friday." })] }) }));

    assert.equal(transcriptBox(mounted), "Ship on Friday.");
    // …and the panel that says which segments are settled, which is a different
    // state from the box and rendered from a different value.
    assert.match(screenText(mounted.root), /Live transcript/);
    assert.match(screenText(mounted.root), /1 of 1 transcribed/);
    mounted.unmount();
  } finally { restore(); }
});

test("every settled segment reaches the box, and Create posts all of them", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    for (let count = 1; count <= 3; count += 1) {
      const segments = Array.from({ length: count }, (_, index) => segment(index, { text: `Line ${index}.` }));
      await mounted.act(() => host.push({ session: session({ segments }) }));
    }
    // The box holds the whole meeting, not the last thing that arrived. Losing
    // the fold's own accounting leaves this showing "Line 2." alone.
    assert.equal(transcriptBox(mounted), "Line 0.\nLine 1.\nLine 2.");

    host.record = session({ status: "stopped", segments: [0, 1, 2].map((index) => segment(index, { text: `Line ${index}.` })) });
    await press(mounted, "Stop recording");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await press(mounted, "Create meeting");

    assert.equal(host.created.length, 1, "the meeting was created");
    assert.equal(host.created[0]!.transcript, "Line 0.\nLine 1.\nLine 2.");
    mounted.unmount();
  } finally { restore(); }
});

test("Create posts the box as it is at the click, not as it was at the last keystroke", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    host.record = session({ status: "stopped" });
    await press(mounted, "Stop recording");
    // The title is typed while the box is still empty — the queue is draining
    // what is already on disk (D3/D7), so segments land AFTER this.
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await mounted.act(() => host.push({ session: session({ status: "stopped", segments: [segment(0, { text: "The decision was to ship." })] }) }));
    assert.equal(transcriptBox(mounted), "The decision was to ship.");

    await press(mounted, "Create meeting");
    assert.equal(host.created.length, 1, "the meeting was created");
    assert.equal(host.created[0]!.transcript, "The decision was to ship.");
    mounted.unmount();
  } finally { restore(); }
});

test("what Create posts states the gap it warned about, and is filed under the org it was recorded in", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    // Recorded under one org; the app-wide switcher may be anywhere by now.
    const recorded = (status: MeetingCaptureSession["status"]): MeetingCaptureSession => session({
      status,
      scope: { orgId: "org-recorded", workspaceId: null },
      segments: [segment(0, { text: "Ship on Friday." }), segment(1, { state: "pending", attempts: 0 })],
    });
    await mounted.act(() => host.push({ session: recorded("recording") }));

    host.record = recorded("stopped");
    await press(mounted, "Stop recording");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    // ADR-028 — said BEFORE the click, from the same record the click will act
    // on. This is the sentence that stayed on screen while the POST silently
    // dropped the very segment it is about.
    assert.match(screenText(mounted.root), /1 segment is still being transcribed/);
    await press(mounted, "Create meeting");

    assert.equal(host.created.length, 1, "the meeting was created");
    const posted = host.created[0]!;
    // D5 — the segment that never transcribed goes in as a STATED gap with its
    // time range, and the settled segment before it is still there.
    assert.match(posted.transcript, /Ship on Friday\./);
    assert.ok(posted.transcript.includes(formatCaptureGap(SEGMENT_MS, SEGMENT_MS * 2)), posted.transcript);
    // Open question 5 — the frozen scope wins over the switcher.
    assert.equal(posted.orgId, "org-recorded");
    mounted.unmount();
  } finally { restore(); }
});

test("the box is updated to say what was posted, so the gap is not a surprise in the saved meeting", async () => {
  const { host, restore } = installHost();
  try {
    host.createFails = true;
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    const recorded = session({ status: "stopped", segments: [segment(0, { text: "Ship on Friday." }), segment(1, { state: "pending", attempts: 0 })] });
    await mounted.act(() => host.push({ session: recorded }));
    host.record = recorded;
    await press(mounted, "Stop recording");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await press(mounted, "Create meeting");

    // The create failed on purpose, which is the only way to read the box after
    // the settle step: on success the form closes. What was posted and what the
    // box says have to be the same text, and D5's whole objection is to a hole
    // the user only discovers in the saved transcript.
    assert.equal(host.created.length, 1);
    assert.equal(transcriptBox(mounted), host.created[0]!.transcript);
    assert.ok(transcriptBox(mounted).includes(formatCaptureGap(SEGMENT_MS, SEGMENT_MS * 2)), transcriptBox(mounted));
    mounted.unmount();
  } finally { restore(); }
});

test("a gap the host has since filled in is healed in the box when the capture is picked up", async () => {
  const { host, restore } = installHost();
  try {
    // The offer, and the record behind it: segment 0 failed when the draft was
    // written and has transcribed since.
    host.resumable = [recovery()];
    host.record = session({ status: "stopped", segments: [segment(0, { text: "Ship on Friday." })] });
    const mounted = await compose(host);
    // The box holds what a previous run left: the gap marker, verbatim.
    const stale = formatCaptureGap(0, SEGMENT_MS);
    await typeInto(mounted, TRANSCRIPT_FIELD, stale);
    await press(mounted, "Transcribe it");

    // Healed IN PLACE — not appended, which would leave the false claim standing.
    assert.equal(transcriptBox(mounted), "Ship on Friday.");
    mounted.unmount();
  } finally { restore(); }
});

test("Record and Create are both refused while the last chunk is still being written", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    await mounted.act(() => host.push({ session: session({ segments: [segment(0, { text: "Ship on Friday." })] }) }));
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");

    // F3 — Stop returns before the capture is closed: `onstop`, the final
    // chunk's bytes, the IPC and the disk write all happen after `recording`
    // goes false. This holds the host's `captureStop` open across that window.
    const release = host.holdStop();
    const stop = button(mounted.root, "Stop recording");
    const onClick = (stop.props as { onClick(): void }).onClick;
    await mounted.act(() => onClick());

    // The microphone is closed, so the bar shows Record again — and it must not
    // be pressable, or a second recorder starts over a capture still closing.
    assert.equal(isDisabled(button(mounted.root, "● Record audio")), true, "Record is refused while the capture is closing");
    assert.equal(isDisabled(button(mounted.root, "Saving the recording…")), true, "Create is refused while the capture is closing");

    await mounted.act(() => release());
    await mounted.flush();
    assert.equal(isDisabled(button(mounted.root, "Create meeting")), false, "Create is available once the capture is closed");
    mounted.unmount();
  } finally { restore(); }
});

test("cancelling while the microphone is being opened does not throw the composer away", async () => {
  const { host, restore } = installHost();
  try {
    let openStream = (): void => undefined;
    const gate = new Promise<MediaStream>((resolve) => { openStream = () => resolve(fakeStream()); });
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: () => gate } },
      configurable: true,
      writable: true,
    });

    const mounted = await compose(host);
    const record = button(mounted.root, "● Record audio");
    // Deliberately not awaited: `getUserMedia` is sitting on a permission
    // prompt, which is exactly the window `arming` exists for.
    await mounted.act(() => (record.props as { onClick(): void }).onClick());
    await press(mounted, "Cancel");

    // The composer is still here. Unmounting it during arming ends the meeting
    // that is about to start, with the microphone already opening.
    assert.ok(hasButton(mounted.root, "Cancel"), "the compose form survives Cancel while arming");
    await mounted.act(() => openStream());
    assert.equal(host.begun.length, 1, "the capture really was started");
    assert.ok(hasButton(mounted.root, "Stop recording"), "and the recorder is running in the form that survived");
    mounted.unmount();
  } finally { restore(); }
});

test("a capture another window is recording is named, not offered back with a Delete", async () => {
  const { host, restore } = installHost();
  try {
    // The record says a DIFFERENT window holds a fresh lease. This window has
    // never heard of it: its own hold is empty, which is exactly the case every
    // guard held in one mount's memory answered wrongly.
    const live = session({ id: "mtg-20260809-livelive", writer: lease("wr-second-window") });
    host.writing = [live];
    // …and the offer is stale: it still lists the capture that has since gone
    // live. This is the only way to reach the destructive control at all.
    host.resumable = [recovery({ sessionId: live.id, title: "Board review" })];
    const mounted = await compose(host);

    assert.match(screenText(mounted.root), /Another window is recording this meeting right now\./);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), true, "its audio cannot be deleted from here");
    assert.equal(isDisabled(button(mounted.root, "Transcribe it")), true, "nor taken over from here");
    // …and the guard is the rule, not the pixel: reaching past the attribute
    // still refuses, and says why.
    const del = button(mounted.root, "Delete audio");
    await mounted.act(() => (del.props as { onClick(): void }).onClick());
    assert.deepEqual(host.discarded, []);
    assert.match(screenText(mounted.root), /cannot be deleted while it is being recorded/);
    mounted.unmount();
  } finally { restore(); }
});

test("a lease that lapses brings the recording back on its own, without a click", async () => {
  const { host, restore } = installHost();
  try {
    // A writer whose last heartbeat is nearly a full staleness window old: fresh
    // now, abandoned in a moment. That is what a killed process leaves behind.
    const lapsing = session({
      id: "mtg-20260809-lapselaps",
      writer: { holderId: "wr-second-window", holder: "Another window", epoch: 2, heartbeatAt: new Date(Date.now() - (MEETING_CAPTURE_LEASE_STALE_MS - 150)).toISOString() },
    });
    host.writing = [lapsing];
    host.resumable = [recovery({ sessionId: lapsing.id, title: "Board review" })];
    const mounted = await compose(host);
    assert.match(screenText(mounted.root), /Another window is recording this meeting right now\./);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), true);

    // The writer died: nothing renews it, and nothing clicks anything either.
    host.writing = [];
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    await mounted.flush();

    // ADR-028 — the surface came back by itself at the instant it said it would,
    // rather than sitting on a stale answer until the user tried something.
    assert.doesNotMatch(screenText(mounted.root), /is recording this meeting right now/);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), false);
    mounted.unmount();
  } finally { restore(); }
});

test("Create cannot finalize a capture a second window has taken over", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    // This window recorded it; a second window then took the lease, which the
    // host publishes on the next persisted change.
    const stolen = session({ writer: lease("wr-second-window"), segments: [segment(0, { text: "Ship on Friday." })] });
    host.record = stolen;
    await mounted.act(() => host.push({ session: stolen }));
    await press(mounted, "Stop recording");

    assert.equal(isDisabled(button(mounted.root, "Create meeting")), true);
    const create = button(mounted.root, "Create meeting");
    await mounted.act(() => (create.props as { onClick(): void }).onClick());
    // Nothing was posted and — the point — nothing was finalized, because
    // finalizing deletes the audio the other window is still recording into.
    assert.deepEqual(host.created, []);
    assert.deepEqual(host.finalized, []);
    mounted.unmount();
  } finally { restore(); }
});

test("losing the recording to another window stops this window's microphone and says so", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    assert.ok(hasButton(mounted.root, "Stop recording"));

    host.record = session({ status: "stopped", writer: lease("wr-second-window") });
    await mounted.act(() => host.push({
      session: host.record,
      writerLost: "Another window is recording this meeting right now.",
    }));

    assert.match(screenText(mounted.root), /Another window is recording this meeting right now\./);
    assert.match(screenText(mounted.root), /This window has stopped recording/);
    assert.equal(host.stopped.length, 1, "the capture was closed rather than left running");
    mounted.unmount();
  } finally { restore(); }
});

test("every call that takes or releases a recording names this window", async () => {
  const { host, restore } = installHost();
  try {
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    // The record carries THIS window's lease, which is what the host really
    // leaves behind: Stop reads the capture back through `adopt`, and a pick-up
    // acquires. So the meeting this window recorded is one it is the writer of —
    // and it still has to be able to finish it. A guard that only asked "is
    // anybody writing?" would wedge Create on the one window entitled to press it.
    host.record = session({
      status: "stopped",
      segments: [segment(0, { text: "Ship on Friday." })],
      writer: lease(captureHolderId(), "This window"),
    });
    await mounted.act(() => host.push({ session: host.record }));
    await press(mounted, "Stop recording");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await press(mounted, "Create meeting");

    const holder = captureHolderId();
    assert.deepEqual(host.begun, [{ holderId: holder }]);
    // Stop reads the record back through `adopt`, and Create releases the audio
    // through `finalize`; both are lease-bearing operations on this capture.
    assert.deepEqual(host.adopted.map((row) => row.holderId), [holder]);
    assert.deepEqual(host.finalized, [{ id: host.record.id, holderId: holder }]);
    mounted.unmount();
  } finally { restore(); }
});
