/**
 * ADR-035 D1b — the BROWSER half of the capture surface's ports: every real
 * device, endpoint and clock the recording touches, in one object a test can
 * hold.
 *
 * **Why this is not in `page.tsx` any more.** `captureSurface.ts` moved the
 * decisions out of the component so a test could press Record; the wiring stayed
 * behind, and a wire nothing checks is a decision nobody has checked either.
 * Measured: swapping `browserCaptureLocks()` for a manager-less `CaptureLocks`
 * — which is precisely what a dashboard served over plain http gets, and the
 * shape D1b names — left the whole suite green while every cross-tab guard in
 * the product silently stopped working. The surface's own tests cannot see it,
 * because they construct their own ports by definition, and `page.tsx` cannot be
 * imported in this runner at all (it pulls in React, Next and a CSS module). So
 * the ports leave the component too, and `capturePorts.test.ts` asks the
 * questions the wiring is: are these locks over the browser's real lock table,
 * does the POST carry the workspace the surface froze at Record, does a recorder
 * that will not construct hand the microphone back.
 *
 * What stays in `page.tsx` is the three things that are genuinely React's: the
 * switcher's current org, the page's own busy flag, and where a created meeting
 * goes. They arrive as `PageBridge` — functions, not values, so the surface
 * always reads the CURRENT one without ever being rebuilt. Rebuilding it would
 * drop the recording it is holding, which is the defect it exists to prevent.
 */
import { authFetch } from "../../lib/adminApi";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import { browserCaptureLocks } from "../../lib/meetings/captureLock";
import { createSttTranscriber, DEFAULT_CAPTURE_MIME_TYPE } from "../../lib/meetings/captureQueue";
import { openMeetingCaptureStore } from "../../lib/meetings/openCaptureStore";
import type { CaptureMicrophone, CaptureSurfacePorts } from "./captureSurface";

/**
 * The three facts only the React tree has.
 *
 * Read through functions rather than passed as values: the org can move under a
 * recording (ADR-019's switcher) and the page's busy flag changes on every
 * request, and neither may be a reason to construct a second surface.
 */
export interface PageBridge {
  /** The switcher's CURRENT workspace. The surface freezes it at Record, not here. */
  activeOrgId(): string;
  /** Whether the page is running something of its own — the submit guard reads it. */
  otherBusy(): boolean;
  onCreated(meetingId: string): void;
}

/**
 * ADR-035 D1b — the real microphone, and the recorder over it, as one thing.
 *
 * The pair has one invariant: a recorder that was never constructed (or never
 * started) leaves the stream live and `onstop` never fires, so the tracks have
 * to be stopped by hand or the microphone light stays on with nothing recording
 * it. Handing back a `release` beside the recorder is what makes that impossible
 * to forget — and the `catch` below is the case where there is no recorder to
 * attach it to.
 */
export async function openBrowserMicrophone(): Promise<CaptureMicrophone> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (caught) {
    stream.getTracks().forEach((track) => track.stop());
    throw caught;
  }
  // A thin adapter rather than the `MediaRecorder` itself: the DOM's event
  // handlers carry a whole `BlobEvent`, and the surface is written against the
  // two facts it actually uses so a test can be a plain object.
  return {
    recorder: {
      get mimeType() { return recorder.mimeType; },
      get state() { return recorder.state; },
      start: (timesliceMs: number) => recorder.start(timesliceMs),
      stop: () => recorder.stop(),
      pause: () => recorder.pause(),
      resume: () => recorder.resume(),
      set ondataavailable(handler: ((event: { readonly data: Blob }) => void) | null) {
        recorder.ondataavailable = handler ? (event) => handler({ data: event.data }) : null;
      },
      get ondataavailable() { return null; },
      set onstop(handler: (() => void) | null) { recorder.onstop = handler; },
      get onstop() { return null; },
    },
    release: () => stream.getTracks().forEach((track) => track.stop()),
  };
}

/** Every port the capture surface needs, over this browser. */
export function browserCapturePorts(page: PageBridge): CaptureSurfacePorts {
  return {
    // One per TAB, over `navigator.locks`: a lock this tab holds is released by
    // the browser the moment the tab dies, so a killed recording is offerable
    // back on the very next check rather than after a threshold. A manager-less
    // stand-in here is not a smaller feature — it is every cross-tab guard in
    // this product answering "nobody is writing" to every question.
    locks: browserCaptureLocks(),
    openStore: (requestPersistence) => openMeetingCaptureStore({ requestPersistence }),
    activeOrgId: () => page.activeOrgId(),
    openMicrophone: openBrowserMicrophone,
    createTranscriber: (language) => createSttTranscriber({
      baseUrl: BASE_URL,
      token: getJwt() || getApiKey() || "",
      ...(language ? { language } : {}),
    }),
    // Open question 5's last hop. `input.orgId` is the workspace the SURFACE
    // froze when Record was pressed; sending the switcher's current one here
    // would land an hour of somebody's audio in whichever workspace happened to
    // be selected when they pressed Create, with everything upstream still
    // correct.
    createMeeting: (input) => authFetch<{ id: string }>("/api/meetings", {
      method: "POST",
      body: { title: input.title, transcript: input.transcript, template: input.template },
      orgId: input.orgId || undefined,
    }),
    /** D8 — the import path, which really can be handed an hour of audio in one piece. */
    async transcribeFile(blob, language) {
      const token = getJwt() || getApiKey() || "";
      const res = await fetch(`${BASE_URL}/v1/audio/transcriptions${language === "auto" ? "" : `?language=${encodeURIComponent(language)}`}`, {
        method: "POST",
        headers: { "Content-Type": blob.type || DEFAULT_CAPTURE_MIME_TYPE, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: blob,
      });
      if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
      const out = (await res.json()) as { text?: string };
      return out.text ?? "";
    },
    legacyDraftStorage: () => (typeof localStorage === "undefined" ? null : localStorage),
    confirm: (question) => window.confirm(question),
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail)),
    otherBusy: () => page.otherBusy(),
    onCreated: (meetingId) => page.onCreated(meetingId),
  };
}
