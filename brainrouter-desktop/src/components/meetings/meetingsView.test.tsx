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
  formatCaptureGap,
  type MeetingCaptureSession,
  type MeetingRecoverySummary,
  type MeetingSegment,
} from "@kinqs/brainrouter-core/meetings";
import { MeetingsView } from "./MeetingsView.js";
import type { MeetingCaptureWriter } from "./captureOps.js";
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

/**
 * A row of main's writer registry: that window is recording that capture.
 *
 * There is no time in it, because main answers this exactly rather than
 * inferring it from a stamp — which is why the surface below never waits for
 * anything to lapse and is TOLD instead.
 */
function writer(sessionId: string, holderId: string): MeetingCaptureWriter {
  return { sessionId, holderId, note: "Another window is recording this meeting right now." };
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
  /** The offer, and its complement — what window is recording what. */
  resumable: MeetingRecoverySummary[];
  writing: MeetingCaptureWriter[];
  /** Push "the live set changed", as main does on Record, Stop, close and a window going away. */
  announceWriters(): void;
  /** Fail the next create, so the compose form stays up and can be read. */
  createFails: boolean;
  /** Refuse the next pick-up, the way another window's writer registration does. */
  adoptRefusal: string | null;
  /** Hold `captureStop` open, which is the window `closing` covers. */
  holdStop(): () => void;
  /** Hold `captureAdopt` open — the window a Record used to be able to land in. */
  holdAdopt(): () => void;
  /**
   * Hold `captureRead` open — a whole recording coming back over IPC, which is
   * the window the compose form can disappear in.
   */
  holdRead(): () => void;
  /** Publish a persisted change, as main's broadcast does. */
  push(progress: { sessionId?: string; session: MeetingCaptureSession; phase?: string; errors?: string[] }): void;
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
  const writerListeners = new Set<() => void>();
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
    announceWriters: () => undefined,
    createFails: false,
    adoptRefusal: null,
    holdStop: () => () => undefined,
    holdAdopt: () => () => undefined,
    holdRead: () => () => undefined,
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
  let pendingAdopt: Promise<void> | null = null;
  host.holdStop = () => {
    let release = (): void => undefined;
    pendingStop = new Promise<void>((resolve) => { release = () => resolve(); });
    return () => release();
  };
  host.holdAdopt = () => {
    let release = (): void => undefined;
    pendingAdopt = new Promise<void>((resolve) => { release = () => resolve(); });
    return () => release();
  };
  let pendingRead: Promise<void> | null = null;
  host.holdRead = () => {
    let release = (): void => undefined;
    pendingRead = new Promise<void>((resolve) => { release = () => resolve(); });
    return () => release();
  };
  host.push = (progress) => {
    const payload = { sessionId: progress.sessionId ?? progress.session.id, ...progress };
    for (const listener of [...listeners]) listener(payload);
  };
  host.announceWriters = () => { for (const listener of [...writerListeners]) listener(); };

  const meetings = {
    captureBegin: async (input: { holderId?: string }) => { host.begun.push({ ...(input.holderId ? { holderId: input.holderId } : {}) }); return host.record; },
    captureAppend: async () => host.record,
    captureStop: async (id: string) => {
      host.stopped.push(id);
      if (pendingStop) { const gate = pendingStop; pendingStop = null; await gate; }
      return host.record;
    },
    captureRead: async () => {
      if (pendingRead) { const gate = pendingRead; pendingRead = null; await gate; }
      return { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/webm", missing: [] };
    },
    captureFinalize: async (id: string, holderId?: string) => { host.finalized.push({ id, ...(holderId ? { holderId } : {}) }); return { ok: true }; },
    captureDiscard: async (id: string, holderId?: string) => { host.discarded.push({ id, ...(holderId ? { holderId } : {}) }); return { ok: true }; },
    captureResumable: async () => host.resumable,
    captureWriting: async () => host.writing,
    captureAdopt: async (id: string, holderId?: string) => {
      host.adopted.push({ id, ...(holderId ? { holderId } : {}) });
      if (pendingAdopt) { const gate = pendingAdopt; pendingAdopt = null; await gate; }
      if (host.adoptRefusal) throw new Error(host.adoptRefusal);
      return host.record;
    },
    captureRetrySegment: async () => host.record,
    onCaptureProgress: (listener: (progress: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCaptureWriters: (listener: () => void) => {
      writerListeners.add(listener);
      return () => writerListeners.delete(listener);
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

test("Record cannot land inside a pick-up, which used to delete the recovered meeting unread", async () => {
  const { host, restore } = installHost();
  try {
    const recovered = "mtg-20260809-recovered";
    host.resumable = [recovery({ sessionId: recovered, title: "Yesterday" })];
    const mounted = await compose(host);

    // The pick-up's IPC is held open — the stretch that used to read as an idle
    // tab, because `sessionId` alone said nothing to the rule Record consults.
    const release = host.holdAdopt();
    host.record = session({ id: recovered, status: "stopped", segments: [segment(0, { text: "Yesterday's words." })] });
    const pickUp = press(mounted, "Transcribe it");

    // The whole finding: a Record here started a SECOND capture, and Create then
    // finalized — deleted — the recovered meeting without one of its words ever
    // reaching the box. The refusal is in the function; the disabled attribute
    // is only how it reaches the pixel.
    await assert.rejects(press(mounted, "● Record audio"), /disabled/);
    assert.deepEqual(host.begun, [], "no second capture was begun inside the pick-up");

    release();
    await pickUp;

    // And the ordinary path is intact once the pick-up lands.
    assert.equal(transcriptBox(mounted), "Yesterday's words.");
    assert.deepEqual(host.begun, []);
  } finally { restore(); }
});

test("record, Stop, record, Create — both halves are one meeting, and BOTH recordings are released", async () => {
  const { host, restore } = installHost();
  try {
    const first = "mtg-20260809-firsthalf";
    const second = "mtg-20260809-scndhalff";
    // The offer already knows about the first half, which is what makes the
    // exclusion visible: without it the form advertises the capture it is
    // holding back to the person recording its second half.
    host.resumable = [recovery({ sessionId: first, title: "First half" })];
    const mounted = await compose(host);

    host.record = session({ id: first });
    await press(mounted, "● Record audio");
    await mounted.act(() => host.push({ session: session({ id: first, segments: [segment(0, { text: "Before the break." })] }) }));
    host.record = session({ id: first, status: "stopped", segments: [segment(0, { text: "Before the break." })] });
    await press(mounted, "Stop recording");

    // …and the meeting carries on in a second capture, which is an ordinary
    // thing to do: the microphone was released for the break and picked up again.
    host.record = session({ id: second });
    await press(mounted, "● Record audio");
    await mounted.act(() => host.push({ sessionId: second, session: session({ id: second, segments: [segment(0, { text: "After the break." })] }) }));
    host.record = session({ id: second, status: "stopped", segments: [segment(0, { text: "After the break." })] });
    await press(mounted, "Stop recording");

    // Invariant 5 — the first capture is still IN HAND, so the offer must not be
    // inviting the user to transcribe it a second time. Excluding only the bound
    // capture put "First half" back on screen the instant Record was pressed
    // again.
    assert.doesNotMatch(screenText(mounted.root), /First half/);

    assert.equal(transcriptBox(mounted), "Before the break.\nAfter the break.");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await press(mounted, "Create meeting");

    // One meeting, holding both halves…
    assert.equal(host.created.length, 1);
    assert.equal(host.created[0]!.transcript, "Before the break.\nAfter the break.");
    // …and D6 kept for both of them. Releasing only the last one left the first
    // half's audio on the device with no terminal state, so the next glance at
    // the library offered to transcribe words this meeting already contains.
    assert.deepEqual(host.finalized.map((row) => row.id), [first, second]);
    mounted.unmount();
  } finally { restore(); }
});

test("two Record clicks in one commit open one microphone, not two", async () => {
  const { host, restore } = installHost();
  try {
    const opened = { count: 0 };
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: async () => { opened.count += 1; return fakeStream(); } } },
      configurable: true,
      writable: true,
    });
    const mounted = await compose(host);
    const record = button(mounted.root, "● Record audio");
    const onClick = (record.props as { onClick(): void }).onClick;
    // G2 — both handlers run before React can commit the `disabled` the first one
    // earned. `arming` normally keeps a human's double-click out of one commit,
    // which is why this reaches past the pixel: the hole is that the rule lived
    // only on the attribute.
    await mounted.act(() => { onClick(); onClick(); });
    await mounted.flush();

    // A second recorder would have overwritten `recorderRef.current`, so Stop
    // would reach only the second: the first would go on recording, go on
    // appending after Stop, and hold its stream — with no row anywhere in the
    // app, because main subtracts live writers from the offer.
    assert.equal(host.begun.length, 1, "one capture was created");
    assert.equal(opened.count, 1, "one microphone was opened");

    host.record = session({ status: "stopped" });
    await press(mounted, "Stop recording");
    assert.deepEqual(host.stopped, [host.record.id], "and Stop reached the one recording there is");
    mounted.unmount();
  } finally { restore(); }
});

test("a pick-up is refused while this form is still recording, past the disabled attribute", async () => {
  const { host, restore } = installHost();
  try {
    host.resumable = [recovery({ sessionId: "mtg-20260809-otherrec", title: "Board review" })];
    const mounted = await compose(host);
    await press(mounted, "● Record audio");

    // The pixel says no…
    assert.equal(isDisabled(button(mounted.root, "Transcribe it")), true);
    // …and so does the rule, which is the half that survives a click landing in
    // the commit that disabled it. Taking a recovery here rebinds the live
    // surface away from the running recorder, and Create would then finalize
    // BOTH — deleting the directory the microphone is still appending to.
    const take = button(mounted.root, "Transcribe it");
    await mounted.act(() => (take.props as { onClick(): void }).onClick());

    assert.deepEqual(host.adopted, [], "nothing was picked up");
    assert.ok(hasButton(mounted.root, "Stop recording"), "and the form is still watching its own recording");
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

test("leaving Meetings while the microphone prompt is up starts nothing and claims nothing", async () => {
  const { host, restore } = installHost();
  try {
    let answerPrompt = (): void => undefined;
    const stops = { count: 0 };
    const microphone = { getTracks: () => [{ stop: () => { stops.count += 1; } }] } as unknown as MediaStream;
    const prompt = new Promise<MediaStream>((resolve) => { answerPrompt = () => resolve(microphone); });
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: () => prompt } },
      configurable: true,
      writable: true,
    });

    const mounted = await compose(host);
    const record = button(mounted.root, "● Record audio");
    // Record pressed, and `getUserMedia` sitting on the permission prompt.
    await mounted.act(() => (record.props as { onClick(): void }).onClick());
    assert.deepEqual(host.begun, [], "nothing exists yet — the prompt is still up");

    // The whole view goes away while the prompt is still up. Its cleanup stops
    // `recorderRef.current`, which used to be assigned only once `start` had
    // RETURNED: the teardown stopped nothing, and the person's answer to the
    // prompt then started a recording on a view that no longer existed.
    mounted.unmount();
    answerPrompt();
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // Nothing running: the microphone the prompt opened is handed straight back…
    assert.equal(stops.count, 1, "the microphone was released");
    // …and nothing claimed. `captureBegin` is where main registers this window
    // as the capture's writer, and the window it would have named is gone — so a
    // capture created here is one no window can ever be offered, transcribe or
    // delete for the rest of the process's life.
    assert.deepEqual(host.begun, []);
    assert.deepEqual(host.discarded, []);
  } finally { restore(); }
});

test("a capture another window is recording is named, not offered back with a Delete", async () => {
  const { host, restore } = installHost();
  try {
    // Main says a DIFFERENT window is recording it. This window has never heard
    // of that capture: its own hold is empty, which is exactly the case every
    // guard held in one mount's memory answered wrongly.
    const live = "mtg-20260809-livelive";
    host.writing = [writer(live, "wr-second-window")];
    // …and the offer is stale: it still lists the capture that has since gone
    // live. This is the only way to reach the destructive control at all.
    host.resumable = [recovery({ sessionId: live, title: "Board review" })];
    const mounted = await compose(host);

    assert.match(screenText(mounted.root), /Another window is recording this meeting right now\./);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), true, "its audio cannot be deleted from here");
    assert.equal(isDisabled(button(mounted.root, "Transcribe it")), true, "nor taken over from here");
    // …and the guard is the rule, not the pixel: reaching past the attribute
    // still refuses, and says why — in main's words, which are the same words
    // main throws if the call is made anyway.
    const del = button(mounted.root, "Delete audio");
    await mounted.act(() => (del.props as { onClick(): void }).onClick());
    assert.deepEqual(host.discarded, []);
    assert.match(screenText(mounted.root), /cannot be deleted while it is being recorded/);
    // G2 — and the pick-up beside it, which had the guard on the pixel alone.
    // Taking a capture another window is recording fills this compose form in
    // from a meeting somebody else is making, and puts it in the hand this
    // form's Create releases.
    const take = button(mounted.root, "Transcribe it");
    await mounted.act(() => (take.props as { onClick(): void }).onClick());
    assert.deepEqual(host.adopted, []);
    assert.match(screenText(mounted.root), /cannot be transcribed from here while that recording is running/);
    mounted.unmount();
  } finally { restore(); }
});

test("when the other window stops, the surface comes back on its own — because it is told", async () => {
  const { host, restore } = installHost();
  try {
    const live = "mtg-20260809-livelive";
    host.writing = [writer(live, "wr-second-window")];
    host.resumable = [recovery({ sessionId: live, title: "Board review" })];
    const mounted = await compose(host);
    assert.match(screenText(mounted.root), /Another window is recording this meeting right now\./);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), true);

    // The other window stopped — or reloaded, or died. Main knows which and does
    // not care which: the set changed, so it says so. Nothing is clicked here.
    host.writing = [];
    await mounted.act(() => host.announceWriters());
    await mounted.flush();

    // ADR-028 — the surface corrected itself at the instant the answer changed,
    // rather than sitting on a stale one for the rest of this page view. The
    // previous shape had this window waiting out a staleness window instead, and
    // a reload of the recording window meant it waited for ever.
    assert.doesNotMatch(screenText(mounted.root), /is recording this meeting right now/);
    assert.equal(isDisabled(button(mounted.root, "Delete audio")), false);
    mounted.unmount();
  } finally { restore(); }
});

test("Create cannot finalize a capture a second window is recording", async () => {
  const { host, restore } = installHost();
  try {
    // The capture this form is about to hold is one main says another window is
    // recording. Reachable in the app the same way: this window pressed Record,
    // reloaded, and its replacement adopted the meeting the new page found.
    host.writing = [writer(host.record.id, "wr-second-window")];
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    const held = session({ segments: [segment(0, { text: "Ship on Friday." })] });
    host.record = held;
    await mounted.act(() => host.push({ session: held }));
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

test("every call that takes or releases a recording names this window", async () => {
  const { host, restore } = installHost();
  try {
    // Main says THIS window is recording it, which is what it really says while
    // a recording is running — and this window still has to be able to finish
    // the meeting. A guard that only asked "is anybody recording this?" would
    // wedge Create on the one window entitled to press it.
    host.writing = [writer(host.record.id, captureHolderId())];
    const mounted = await compose(host);
    await press(mounted, "● Record audio");
    host.record = session({
      status: "stopped",
      segments: [segment(0, { text: "Ship on Friday." })],
    });
    await mounted.act(() => host.push({ session: host.record }));
    await press(mounted, "Stop recording");
    await typeInto(mounted, TITLE_FIELD, "Weekly sync");
    await press(mounted, "Create meeting");

    const holder = captureHolderId();
    assert.deepEqual(host.begun, [{ holderId: holder }]);
    // Stop reads the record back through `adopt`, and Create releases the audio
    // through `finalize`; both are refused for a window that is not the writer,
    // so both have to name this one.
    assert.deepEqual(host.adopted.map((row) => row.holderId), [holder]);
    assert.deepEqual(host.finalized, [{ id: host.record.id, holderId: holder }]);
    mounted.unmount();
  } finally { restore(); }
});

test("Delete audio names this window too, or the window that recorded it is refused its own discard", async () => {
  const { host, restore } = installHost();
  try {
    host.resumable = [recovery({ title: "Board review" })];
    const mounted = await compose(host);
    await press(mounted, "Delete audio");

    // The enumeration above stopped at begin/adopt/finalize, so this one holder
    // id was deletable with everything green — and `discard` is the call that
    // matters most for it. Main refuses `close(id, 'discard', undefined)` for
    // ANY live writer including this window's own, and the caller that reaches
    // it for a cancelled Record is `MeetingCaptureRecorder.abandon`, which
    // SWALLOWS the failure: the capture then stays claimed for the life of the
    // process, hidden from every window's offer and refused to every other one.
    assert.deepEqual(host.discarded, [{ id: recovery().sessionId, holderId: captureHolderId() }]);
    mounted.unmount();
  } finally { restore(); }
});

test("a recording read back after the compose form has gone mints no object URL to leak", async () => {
  const { host, restore } = installHost();
  const minted: string[] = [];
  const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => { minted.push(`blob:meeting-${minted.length}`); return minted[minted.length - 1]!; };
  URL.revokeObjectURL = () => undefined;
  try {
    host.resumable = [recovery({ title: "Board review" })];
    const mounted = await compose(host);
    // §6's "on disk and PLAYABLE" is a whole meeting's bytes coming back over
    // IPC, and the person can leave Meetings while they are still coming.
    const release = host.holdRead();
    const play = button(mounted.root, "▶ Play");
    await mounted.act(() => (play.props as { onClick(): void }).onClick());
    mounted.unmount();
    release();
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The `setPreview` would be dropped by React and the effect that revokes the
    // URL went with the form, so a URL minted here is a whole recording pinned
    // in this window's heap with nothing left that could ever release it.
    assert.deepEqual(minted, [], "no object URL was minted for a form that had already gone");
  } finally {
    URL.createObjectURL = previous.create;
    URL.revokeObjectURL = previous.revoke;
    restore();
  }
});
