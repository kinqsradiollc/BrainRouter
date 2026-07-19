/** Account-backed Meetings area view-model contracts. */

export type MeetingScope = "private" | "team" | "org" | "public";
export type MeetingSummaryStatus = "queued" | "processing" | "ready" | "failed";
export type MeetingTemplate = "general" | "standup" | "one-on-one" | "retrospective";

export interface MeetingListItem {
  id: string;
  title: string;
  date: string;
  scope: MeetingScope;
  attendeeCount: number;
  summaryStatus: MeetingSummaryStatus;
  originOrgId: string;
  canEdit: boolean;
}

export interface MeetingListPage {
  meetings: MeetingListItem[];
  nextCursor: string | null;
}

export interface MeetingActionItem {
  id: string;
  title: string;
  assignee?: string;
  done?: boolean;
  trackItemId?: string;
}

export interface MeetingTranscriptLine {
  ordinal?: number;
  at: string;
  speaker: string;
  text: string;
}

export interface MeetingTranscriptPage {
  segments: MeetingTranscriptLine[];
  total: number;
  nextCursor: string | null;
}

export interface MeetingShare {
  scope: MeetingScope;
  teamId?: string;
  publicUrl?: string;
  expiresAt?: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  status: string;
  originOrgId: string;
  canEdit: boolean;
  durationMin?: number;
  wordCount?: number;
  attendees: string[];
  model?: { label: string; effort?: string };
  summaryMarkdown: string;
  actionItems: MeetingActionItem[];
  transcript: MeetingTranscriptLine[];
  share: MeetingShare;
  summaryStatus: MeetingSummaryStatus;
  summaryError?: string;
}

export type MeetingOverview = Omit<MeetingDetail, "transcript">;

export interface CreateMeetingInput {
  title: string;
  transcript: string;
  template?: MeetingTemplate;
  scope?: MeetingScope;
  teamId?: string;
  date?: string;
  attendees?: string[];
}

/** Server Track board (org-scoped, `/api/track`) — distinct from workspace Track. */
export type TrackStatusCategory = "todo" | "in_progress" | "completed";

export interface TrackItem {
  id: string;
  title: string;
  description?: string;
  type?: string;
  status?: string;
  statusCategory: TrackStatusCategory;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  source: "manual" | "meeting-action";
  sourceRef?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTrackInput {
  title: string;
  description?: string;
  priority?: string;
  assignee?: string;
  statusCategory?: TrackStatusCategory;
}

export interface MeetingsOps {
  listPage(input?: { cursor?: string; limit?: number }, orgId?: string): Promise<MeetingListPage>;
  /** Compatibility convenience for consumers that only need the first page. */
  list(orgId?: string): Promise<MeetingListItem[]>;
  get(id: string, orgId?: string): Promise<MeetingDetail>;
  overview(id: string, orgId?: string): Promise<MeetingOverview>;
  transcriptPage(id: string, input?: { cursor?: string; limit?: number }, orgId?: string): Promise<MeetingTranscriptPage>;
  createFromTranscript(input: CreateMeetingInput, orgId?: string): Promise<{ id: string; summaryStatus?: MeetingSummaryStatus }>;
  updateSummary(id: string, summaryMarkdown: string, orgId?: string): Promise<MeetingDetail>;
  transcribeAudio(input: { bytes: Uint8Array; contentType?: string; language?: string }): Promise<{ text: string }>;
  regenerateSummary(id: string, orgId?: string): Promise<MeetingDetail>;
  /** Owner-only hard delete — also removes the recallable summary server-side. */
  deleteMeeting(id: string, orgId?: string): Promise<void>;
  setScope(id: string, scope: MeetingScope, opts?: { teamId?: string }, orgId?: string): Promise<MeetingShare>;
  sendActionToTrack(meetingId: string, actionId: string, orgId?: string): Promise<{ trackItemId: string }>;
  unsendActionFromTrack(meetingId: string, actionId: string, orgId?: string): Promise<void>;
  toggleAction(meetingId: string, actionId: string, done: boolean, orgId?: string): Promise<void>;
  serverTracks(orgId?: string): Promise<TrackItem[]>;
  serverTrackCreate(input: CreateTrackInput, orgId?: string): Promise<TrackItem>;
  serverTrackTransition(id: string, statusCategory: TrackStatusCategory, orgId?: string): Promise<TrackItem>;
  serverTrackSetDone(id: string, done: boolean, orgId?: string): Promise<void>;
  serverTrackRemove(id: string, orgId?: string): Promise<void>;
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
