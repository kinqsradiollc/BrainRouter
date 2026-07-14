/**
 * Meetings desktop view (ADR-018) — view-model types.
 *
 * The renderer stays presentational: data + mutations arrive through the injected
 * {@link MeetingsOps} bridge (host `meetings-*` queries → backend `MeetingsService`),
 * mirroring how Track mode is fed. Sharing scope is the four-level ladder (D8).
 */

export type MeetingScope = "private" | "team" | "org" | "public";

export interface MeetingListItem {
  id: string;
  title: string;
  /** ISO calendar date. */
  date: string;
  scope: MeetingScope;
  attendeeCount: number;
}

export interface MeetingActionItem {
  id: string;
  title: string;
  assignee?: string;
  done: boolean;
  /** Set once promoted to a Track work item. */
  trackItemId?: string;
}

export interface MeetingTranscriptLine {
  at: string;
  speaker: string;
  text: string;
}

export interface MeetingShare {
  scope: MeetingScope;
  teamId?: string;
  /** Present only when scope is `"public"`. */
  publicUrl?: string;
  expiresAt?: string;
}

export type MeetingStatus = "recorded" | "imported" | "live" | "summarizing";

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  status: MeetingStatus;
  durationMin?: number;
  wordCount?: number;
  attendees: string[];
  model?: { label: string; effort?: string };
  summaryMarkdown: string;
  actionItems: MeetingActionItem[];
  transcript: MeetingTranscriptLine[];
  share: MeetingShare;
}

/** Bridge to the host/backend. Every method is async; the view shows optimistic state. */
export interface MeetingsOps {
  list(): Promise<MeetingListItem[]>;
  get(id: string): Promise<MeetingDetail>;
  /** M0 text path: create a meeting from a pasted transcript. */
  createFromTranscript(input: { title: string; transcript: string }): Promise<{ id: string }>;
  regenerateSummary(id: string): Promise<void>;
  setScope(id: string, scope: MeetingScope, opts?: { teamId?: string }): Promise<MeetingShare>;
  /** Promote an action item to a Track work item; returns its id. */
  sendActionToTrack(meetingId: string, actionId: string): Promise<{ trackItemId: string }>;
  toggleAction(meetingId: string, actionId: string, done: boolean): Promise<void>;
}

export const MEETING_SCOPES: readonly MeetingScope[] = ["private", "team", "org", "public"];

export const SCOPE_LABEL: Record<MeetingScope, string> = {
  private: "Private",
  team: "Team",
  org: "Organization",
  public: "Public",
};

export const SCOPE_BLURB: Record<MeetingScope, string> = {
  private: "Only you can see this meeting.",
  team: "Members of your team can recall it.",
  org: "Everyone in your organization.",
  public: "Anyone with the link — redacted summary only, no account.",
};
