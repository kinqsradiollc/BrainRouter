/**
 * SurfaceChrome — a small, honest drawing of each product surface, used by the
 * homepage scroll narrative so the handoff between stages is legible.
 *
 * These are diagrams, not screenshots, and they are deliberately spare: each
 * one shows only the parts of its route that the narrative claims exist (the
 * meeting's action items and its "Track ↗" button, the review's per-finding
 * code references, the evidence rows behind a recalled decision). If a claim
 * is removed from `loopStory.ts`, remove the thing that draws it here too.
 *
 * Presentational and static — every one of these is inert markup. The motion
 * lives in ThreadNarrative; nothing in this file animates.
 */

import type { LoopStage } from "./loopStory";

/** Repeated text bar — stands in for prose without faking a screenshot. */
function Bars({ widths }: { widths: readonly number[] }) {
  return (
    <div className="chrome-bars" aria-hidden>
      {widths.map((width, index) => <i key={index} style={{ width: `${width}%` }} />)}
    </div>
  );
}

function PlannerChrome() {
  return (
    <div className="chrome-body chrome-planner">
      <div className="chrome-col">
        <span className="chrome-lab">Today</span>
        <div className="chrome-slot"><b>09:00</b><span>Focus · streaming transcript work</span></div>
        <div className="chrome-slot chrome-slot--live"><b>10:00</b><span>Recording reliability review</span></div>
        <div className="chrome-slot"><b>14:30</b><span>Pairing · retry policy</span></div>
      </div>
      <div className="chrome-col">
        <span className="chrome-lab">Mirrored from your trackers</span>
        <div className="chrome-line"><i className="chrome-dot" />Issue · upload retries exhausted</div>
        <div className="chrome-line"><i className="chrome-dot" />Issue · segment stuck at attempt 0</div>
        <small className="chrome-note">Source state stays in the tracker. Planner mirrors it.</small>
      </div>
    </div>
  );
}

function MeetingChrome() {
  return (
    <div className="chrome-body chrome-meeting">
      <div className="chrome-col">
        <span className="chrome-lab">Summary</span>
        <Bars widths={[100, 92, 78, 96, 61]} />
        <small className="chrome-note">Editable. Regenerate if the model gets it wrong.</small>
      </div>
      <div className="chrome-col">
        <span className="chrome-lab">Action items</span>
        <div className="chrome-action"><i className="chrome-check" />Recordings survive a dropped connection<b>Track ↗</b></div>
        <div className="chrome-action"><i className="chrome-check" />Publish the retry bound<b>In Track ✓</b></div>
        <span className="chrome-lab chrome-lab--sub">Transcript · 148 segments</span>
      </div>
    </div>
  );
}

function NotesChrome() {
  return (
    <div className="chrome-body chrome-notes">
      <span className="chrome-doc-title">Recording durability</span>
      <Bars widths={[100, 86, 94]} />
      <div className="chrome-callout">A capture must be recoverable from what already reached the server.</div>
      <Bars widths={[91, 72]} />
      <div className="chrome-refs">
        <span className="chrome-ref">meetings/streamCommit.ts</span>
        <span className="chrome-ref">commitStreamedChunk()</span>
        <small className="chrome-note">3 backlinks</small>
      </div>
    </div>
  );
}

function WorkbenchChrome() {
  return (
    <div className="chrome-body chrome-workbench">
      <div className="chrome-runbar">
        <span className="chrome-pill">model · your choice</span>
        <span className="chrome-pill">effort · high</span>
        <span className="chrome-pill chrome-pill--scope">scope · org</span>
      </div>
      <div className="chrome-steps">
        <span className="is-done"><i />Read the page and the linked files</span>
        <span className="is-done"><i />Bound the retry, mark the gap</span>
        <span className="is-live"><i />Add the recovery test</span>
        <span><i />Open the change for review</span>
      </div>
      <div className="chrome-diff"><b className="is-add">+38</b><b className="is-del">−7</b><span>3 files changed</span></div>
    </div>
  );
}

function ReviewChrome() {
  return (
    <div className="chrome-body chrome-review">
      <div className="chrome-pr">
        <span className="chrome-doc-title">Guard the streaming commit path</span>
        <span className="chrome-state">code + security queued</span>
      </div>
      <div className="chrome-finding">
        <i className="chrome-sev chrome-sev--high" />
        <div><b>Unbounded retry on a failed segment</b><small>meetings/retryPolicy.ts:41</small></div>
      </div>
      <div className="chrome-finding">
        <i className="chrome-sev chrome-sev--low" />
        <div><b>Gap marker written without a reason</b><small>meetings/transcript.ts:212</small></div>
      </div>
      <small className="chrome-note">Every finding names the lines it came from.</small>
    </div>
  );
}

function KnowledgeChrome() {
  return (
    <div className="chrome-body chrome-knowledge">
      <div className="chrome-recall">
        <span className="chrome-lab">Recalled</span>
        <b>A capture is recoverable from what already reached the server.</b>
        <div className="chrome-scopes"><span>org</span><span>project</span><span>decision</span></div>
      </div>
      <div className="chrome-col">
        <span className="chrome-lab">Supporting evidence</span>
        <div className="chrome-line"><i className="chrome-dot" />file · meetings/streamCommit.ts</div>
        <div className="chrome-line"><i className="chrome-dot" />test · recovery from a dropped socket</div>
        <div className="chrome-line chrome-line--flag"><i className="chrome-dot" />flagged · an earlier note disagrees</div>
      </div>
    </div>
  );
}

const CHROME: Record<LoopStage["id"], () => React.ReactElement> = {
  plan: PlannerChrome,
  meet: MeetingChrome,
  write: NotesChrome,
  build: WorkbenchChrome,
  verify: ReviewChrome,
  know: KnowledgeChrome,
};

/**
 * A framed window for one stage: a title bar naming the real route, then that
 * route's chrome. `aria-hidden` because the copy beside it already says
 * everything the drawing does — a screen reader gets the sentence, not a
 * transcription of a diagram.
 */
export function SurfaceChrome({ stage }: { stage: LoopStage }) {
  const Body = CHROME[stage.id];
  return (
    <div className="thread-chrome" data-tone={stage.tone} aria-hidden>
      <div className="chrome-bar">
        <i />
        <strong>{stage.routeLabel}</strong>
        <small>{stage.route}</small>
      </div>
      <Body />
    </div>
  );
}
