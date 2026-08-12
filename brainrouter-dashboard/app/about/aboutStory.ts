/**
 * The narrative spine behind `/about`.
 *
 * BrainRouter is one workspace a whole team works in; engineering is its
 * deepest surface, not its frame. This module holds the copy and the route
 * wiring for that story so `page.tsx` can stay about layout and motion.
 *
 * CONTRACT — every `href` below MUST be a route that exists and works today,
 * and every `carries` line MUST describe a hand-off a person can actually
 * perform in the product. This page is the front door of a product whose
 * governing rule is that surfaces tell the truth; an aspirational line here is
 * that rule failing in the most visible place there is. If a capability is in
 * doubt, cut the line rather than soften it.
 */

export type StoryTone = "plan" | "build" | "connect" | "knowledge" | "review" | "automation";

export interface StoryRoute {
  readonly label: string;
  readonly href: string;
}

export interface StoryStation {
  /** Anchor id — also the rail link target, so it must stay URL-safe. */
  readonly id: string;
  /** One word from the loop: Plan · Meet · Write · Build · Verify · Know. */
  readonly step: string;
  readonly title: string;
  readonly copy: string;
  readonly tone: StoryTone;
  readonly routes: readonly StoryRoute[];
  /** What leaves this station and arrives at the next one. */
  readonly carries: string;
}

/**
 * The loop, in the order a day actually runs. Each station is a real surface;
 * `carries` names the hand-off into the station below it.
 */
export const STORY_STATIONS: readonly StoryStation[] = [
  {
    id: "plan",
    step: "Plan",
    title: "The day, before anyone asks for a status update.",
    copy: "Planner is the personal view of today across every project. Work you own on the team board arrives here as a mirrored item, so your day and the board never tell two different stories.",
    tone: "plan",
    routes: [{ label: "Planner", href: "/planner" }, { label: "Track", href: "/track" }],
    carries: "the shortlist you take into the room",
  },
  {
    id: "meet",
    step: "Meet",
    title: "A meeting that survives the meeting.",
    copy: "Record and transcribe in the browser, then summarize through your organization's own model provider. Every meeting carries an explicit scope — private, team, organization, or a link that shares the redacted summary only.",
    tone: "automation",
    routes: [{ label: "Meetings", href: "/meetings" }, { label: "Teams", href: "/teams" }],
    carries: "an action item, sent to Track in one click",
  },
  {
    id: "write",
    step: "Write",
    title: "Where the decision gets written down.",
    copy: "Notes holds pages, databases, and backlinks, with the same editor and the same keystrokes on the web and in the desktop app. One implementation, two places to reach it.",
    tone: "connect",
    routes: [{ label: "Notes", href: "/notes" }, { label: "Projects", href: "/projects" }],
    carries: "a written decision the work can point back at",
  },
  {
    id: "build",
    step: "Build",
    title: "The change gets made in the open.",
    copy: "The agent workbench works inside a project's scope: the models you chose, the repositories you connected, the tools you permitted — and every step visible while it runs, not summarized afterwards.",
    tone: "build",
    routes: [
      { label: "Agent workbench", href: "/chat" },
      { label: "Repositories", href: "/repositories" },
      { label: "Automation", href: "/fleet" },
    ],
    carries: "a change, on its way to review",
  },
  {
    id: "verify",
    step: "Verify",
    title: "Nothing ships on confidence alone.",
    copy: "Reviews read the diff and return findings that point back at code, tests, and named vulnerability intelligence. Assessments run only against targets someone authorized first.",
    tone: "review",
    routes: [
      { label: "PR reviews", href: "/reviews" },
      { label: "Issues", href: "/issues" },
      { label: "Pentests", href: "/pentests" },
      { label: "CVE intelligence", href: "/vulnerabilities" },
    ],
    carries: "a finding, with the evidence still attached",
  },
  {
    id: "know",
    step: "Know",
    title: "And tomorrow, the thread is still there.",
    copy: "The meeting summary becomes recallable with its transcript kept as the source underneath it. You can ask what the workspace knows, see why a result came back, and follow it to the material it came from.",
    tone: "knowledge",
    routes: [
      { label: "Knowledge", href: "/knowledge" },
      { label: "Evidence", href: "/evidence" },
      { label: "Recall details", href: "/recall-inspector" },
    ],
    carries: "back into the top of the next day",
  },
] as const;

/**
 * The hinge. Memory is not the product — it is the reason the other five
 * survive contact with each other. Each row is a question a person can answer
 * inside the product, on the route named beside it.
 */
export const THREAD_PROOF: readonly {
  readonly question: string;
  readonly answer: string;
  readonly route: StoryRoute;
}[] = [
  {
    question: "Where did this come from?",
    answer: "Records keep the files, commands, links, and transcripts they were built from.",
    route: { label: "Evidence", href: "/evidence" },
  },
  {
    question: "Who is it for?",
    answer: "Organization, team, project, and owner scope travel with the record instead of being applied at the end.",
    route: { label: "Teams", href: "/teams" },
  },
  {
    question: "Why did it come back?",
    answer: "Ask a question and see which knowledge was chosen, how it ranked, and what put it there.",
    route: { label: "Recall details", href: "/recall-inspector" },
  },
  {
    question: "What if two things disagree?",
    answer: "Conflicting records are surfaced as contradictions rather than quietly averaged.",
    route: { label: "Contradictions", href: "/contradictions" },
  },
  {
    question: "What changed, and when?",
    answer: "Activity history follows when knowledge was saved, recalled, updated, or exported.",
    route: { label: "Activity history", href: "/timeline" },
  },
] as const;

/** The four places the same workspace can be opened from. */
export const STORY_SURFACES: readonly {
  readonly name: string;
  readonly role: string;
  readonly detail: string;
  readonly tone: StoryTone;
}[] = [
  {
    name: "Dashboard",
    role: "The shared workspace",
    detail: "Planner, meetings, notes, the team board, agents, reviews, knowledge, and connections — the surface most of a team lives in.",
    tone: "knowledge",
  },
  {
    name: "Desktop",
    role: "The deep workbench",
    detail: "Chat, Code, and Track in one project shell, with files, terminal, tools, a browser, and reviews alongside the work.",
    tone: "build",
  },
  {
    name: "Terminal",
    role: "The same runtime, in a TTY",
    detail: "The command-line workspace runs the same agent runtime, routing, policy, workflows, and knowledge as the apps.",
    tone: "automation",
  },
  {
    name: "MCP + API",
    role: "For the tools you already use",
    detail: "Governed tools and authenticated HTTP contracts, so editors, agents, and services can join the same workspace.",
    tone: "connect",
  },
] as const;

/** Trust boundaries, stated as what the system refuses to do. */
export const STORY_TRUST: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: "Actions stay explicit",
    detail: "Local execution, file changes, and sensitive tools stay behind the runtime's permission and approval policy.",
  },
  {
    title: "Credentials stay behind the service",
    detail: "Connected accounts use server-sealed OAuth tokens. Provider secrets are write-only and are never returned to a client.",
  },
  {
    title: "Sharing is a decision, not a default",
    detail: "Meetings, notes, and knowledge each carry a scope, and a public link shares a redacted summary rather than the recording.",
  },
  {
    title: "Verification is evidence-led",
    detail: "Findings point back to code, diffs, tests, and attributable vulnerability intelligence rather than to model confidence.",
  },
] as const;
