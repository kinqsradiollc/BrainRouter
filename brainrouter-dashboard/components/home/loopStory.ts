/**
 * The six stages of BrainRouter's working loop, and the one work item that
 * travels through all of them.
 *
 * Every stage names a route that exists in this dashboard and a capability
 * that is actually implemented behind it. The homepage is a surface like any
 * other, so the rule the rest of the product follows applies here too: a
 * surface tells the truth or it does not ship. If a claim below stops being
 * true, change the claim — do not soften the wording and leave it standing.
 *
 * Stage order is the product's own loop: Plan · Meet · Write · Build · Verify ·
 * Know, and Know feeds Plan again. `tone` maps onto the shared `[data-tone]`
 * custom properties in globals.css.
 */

import type { ProductTone } from "../../lib/homeProductStory";

export interface LoopStage {
  /** Stable key; also selects the surface chrome drawn for the stage. */
  readonly id: "plan" | "meet" | "write" | "build" | "verify" | "know";
  /** Display ordinal for the numbered stage label. */
  readonly ordinal: string;
  /** The loop word. Six of these are the whole story. */
  readonly label: string;
  /** Scene heading — a sentence, not a feature name. */
  readonly title: string;
  /** What the stage actually does, in terms the product can back. */
  readonly copy: string;
  /** The route that implements it. Must exist in `app/`. */
  readonly route: string;
  /** How that route is named in the product's own navigation. */
  readonly routeLabel: string;
  /** What leaves this stage and arrives at the next one. */
  readonly hands: string;
  readonly tone: ProductTone;
}

export const LOOP_STAGES = [
  {
    id: "plan",
    ordinal: "01",
    label: "Plan",
    title: "The day arrives already assembled.",
    copy:
      "Planner opens on today across every project — your own items beside the issues mirrored from the trackers you connected, and the blocks the day is actually made of. Nothing on it was retyped from somewhere else.",
    route: "/planner",
    routeLabel: "Planner",
    hands: "Hands over a scheduled block, and a call at ten.",
    tone: "plan",
  },
  {
    id: "meet",
    ordinal: "02",
    label: "Meet",
    title: "The call ends. The decision does not.",
    copy:
      "BrainRouter records the meeting, transcribes it segment by segment so one failure cannot swallow the rest, and writes a summary you can edit or regenerate. Action items come out with owners — and one button puts an action item on the board.",
    route: "/meetings",
    routeLabel: "Meetings",
    hands: "Hands over an action item, with an owner and a place on the board.",
    tone: "automation",
  },
  {
    id: "write",
    ordinal: "03",
    label: "Write",
    title: "It gets written down where the work is.",
    copy:
      "Notes is pages and databases with the same editor on the web and on the desktop. A page can reference the files and the symbols it is about, and it counts what links back — so the doc and the code stop drifting apart quietly.",
    route: "/notes",
    routeLabel: "Notes",
    hands: "Hands over a page, pointing at the code it describes.",
    tone: "connect",
  },
  {
    id: "build",
    ordinal: "04",
    label: "Build",
    title: "An agent picks it up with the context already in scope.",
    copy:
      "The workbench runs the task on the model and reasoning effort you choose, inside the organization's permissions, with the repository, the plan and the page already available to it. You watch the steps rather than the spinner.",
    route: "/chat",
    routeLabel: "Chat · Code",
    hands: "Hands over a change, ready to be looked at.",
    tone: "build",
  },
  {
    id: "verify",
    ordinal: "05",
    label: "Verify",
    title: "Nothing ships on trust alone.",
    copy:
      "Reviews lists the pull requests you can reach, the review state each one is in, and the runs your role is allowed to start — code review, security review, or both. Every finding carries the exact lines it came from.",
    route: "/reviews",
    routeLabel: "Reviews",
    hands: "Hands over findings, with the evidence attached.",
    tone: "review",
  },
  {
    id: "know",
    ordinal: "06",
    label: "Know",
    title: "And next week the thread is still there.",
    copy:
      "What was decided — and what it was decided against — stays recallable, scoped to the organization and the project, with the files, commands, tests and links that support it still attached, and disagreements flagged rather than averaged away.",
    route: "/knowledge",
    routeLabel: "Knowledge",
    hands: "Hands back to the plan. That is the loop.",
    tone: "knowledge",
  },
] as const satisfies ReadonlyArray<LoopStage>;

/**
 * The item that survives all six stages. It is one thing, described the way
 * each surface would describe it — which is the entire argument the page is
 * making, so the six states must read as the same object and not as six
 * different tickets.
 */
export const THREAD = {
  title: "Recordings survive a dropped connection",
  states: {
    plan: "on today · 10:00 review call",
    meet: "decided in the call · owner assigned",
    write: "written up · references 3 files",
    build: "in progress · agent run in the workbench",
    verify: "in review · code + security",
    know: "remembered · evidence attached",
  },
} as const satisfies { title: string; states: Record<LoopStage["id"], string> };
