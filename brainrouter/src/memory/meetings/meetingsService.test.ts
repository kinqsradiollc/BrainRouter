import { describe, it, expect, beforeEach } from "vitest";
import { MeetingsService, MeetingsAccountRequiredError } from "./meetingsService.js";
import { MeetingScopeError } from "./sharing.js";
import type {
  MeetingSummarizer,
  MeetingsMemoryPort,
  MeetingVisibility,
  RecordMeetingInput,
} from "./types.js";

/** In-memory fake port that records every call for assertions. */
class FakePort implements MeetingsMemoryPort {
  ingested: unknown[] = [];
  upserts: unknown[] = [];
  links: Array<{ recordId: string; chunkIds: string[] }> = [];
  visibilities: Array<{ recordId: string; visibility: string; teamId?: string }> = [];
  tokensCreated: unknown[] = [];
  revokes: string[] = [];
  failVisibility = false;
  private seq = 0;

  async ingestTranscript(input: { text: string }): Promise<{ sourceId: string; chunkIds: string[] }> {
    this.ingested.push(input);
    return { sourceId: "src-1", chunkIds: ["c1", "c2"] };
  }
  async upsertSummaryRecord(input: { metadata: Record<string, unknown> }): Promise<{ recordId: string }> {
    this.upserts.push(input);
    return { recordId: `rec-${++this.seq}` };
  }
  async linkRecordSources(_userId: string, recordId: string, chunkIds: string[]): Promise<void> {
    this.links.push({ recordId, chunkIds });
  }
  async setVisibility(input: {
    recordId: string;
    visibility: string;
    teamId?: string;
  }): Promise<boolean> {
    if (this.failVisibility) return false;
    this.visibilities.push({ recordId: input.recordId, visibility: input.visibility, teamId: input.teamId });
    return true;
  }
  async createShareToken(input: unknown): Promise<{ token: string }> {
    this.tokensCreated.push(input);
    return { token: "public-tok-abc" };
  }
  async revokeShareTokens(recordId: string): Promise<number> {
    this.revokes.push(recordId);
    return 1;
  }
}

const summarizer: MeetingSummarizer = {
  async summarize() {
    return {
      markdown: "# Standup\n- shipped X",
      actionItems: [{ title: "Follow up on X", assignee: "alice" }],
      language: "en",
    };
  },
};

function baseInput(over: Partial<RecordMeetingInput> = {}): RecordMeetingInput {
  return {
    userId: "u1",
    orgId: "o1",
    meetingId: "meeting-1",
    sessionKey: "sess-1",
    title: "Team Standup",
    transcript: "[00:00] alice: hello\n[00:05] bob: hi",
    attendees: [{ handle: "alice" }, { handle: "bob" }],
    date: "2026-07-14",
    ...over,
  };
}

describe("MeetingsService — account gating (D7)", () => {
  let port: FakePort;
  let svc: MeetingsService;
  beforeEach(() => {
    port = new FakePort();
    svc = new MeetingsService(port, summarizer);
  });

  it("rejects a missing userId", async () => {
    await expect(svc.recordMeetingSummary(baseInput({ userId: "" }))).rejects.toBeInstanceOf(
      MeetingsAccountRequiredError,
    );
  });
  it("rejects a missing orgId", async () => {
    await expect(svc.recordMeetingSummary(baseInput({ orgId: "" }))).rejects.toBeInstanceOf(
      MeetingsAccountRequiredError,
    );
  });
  it("rejects an empty transcript", async () => {
    await expect(svc.recordMeetingSummary(baseInput({ transcript: "   " }))).rejects.toThrow(
      /empty transcript/i,
    );
  });
});

describe("MeetingsService — memory-native ingest (D1)", () => {
  let port: FakePort;
  let svc: MeetingsService;
  beforeEach(() => {
    port = new FakePort();
    svc = new MeetingsService(port, summarizer);
  });

  it("ingests transcript, summarizes, upserts a meeting-kinded record, and links provenance", async () => {
    const res = await svc.recordMeetingSummary(baseInput());
    expect(port.ingested).toHaveLength(1);
    expect(port.upserts).toHaveLength(1);
    const meta = (port.upserts[0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.kind).toBe("meeting");
    expect(meta.meetingId).toBe("meeting-1");
    expect(meta.attendees).toEqual(["alice", "bob"]);
    expect(meta.sourceId).toBe("src-1");
    expect(port.links[0]).toEqual({ recordId: res.recordId, chunkIds: ["c1", "c2"] });
    expect(res.actionItems).toHaveLength(1);
  });

  it("defaults to private scope with no public token", async () => {
    const res = await svc.recordMeetingSummary(baseInput());
    expect(res.share.scope).toBe("private");
    expect(res.share.publicToken).toBeUndefined();
    expect(port.visibilities[0]?.visibility).toBe("private");
    expect(port.tokensCreated).toHaveLength(0);
  });

  it("throws when setVisibility reports the caller is not the owner", async () => {
    port.failVisibility = true;
    await expect(svc.recordMeetingSummary(baseInput())).rejects.toThrow(/not the owner|record missing/i);
  });
});

describe("MeetingsService — sharing ladder (D8)", () => {
  let port: FakePort;
  let svc: MeetingsService;
  beforeEach(() => {
    port = new FakePort();
    svc = new MeetingsService(port, summarizer);
  });

  it("team scope requires a teamId", async () => {
    await expect(svc.recordMeetingSummary(baseInput({ scope: "team" }))).rejects.toBeInstanceOf(
      MeetingScopeError,
    );
  });
  it("team scope stores visibility=team + teamId", async () => {
    const res = await svc.recordMeetingSummary(baseInput({ scope: "team", teamId: "team-9" }));
    expect(res.share).toEqual({ scope: "team", teamId: "team-9" });
    expect(port.visibilities[0]).toMatchObject({ visibility: "team", teamId: "team-9" });
  });
  it("org scope stores visibility=org", async () => {
    const res = await svc.recordMeetingSummary(baseInput({ scope: "org" }));
    expect(res.share.scope).toBe("org");
    expect(port.visibilities[0]?.visibility).toBe("org");
  });
  it("public scope stores backend visibility=org AND mints a share token", async () => {
    const res = await svc.recordMeetingSummary(baseInput({ scope: "public" }));
    expect(res.share.scope).toBe("public");
    expect(res.share.publicToken).toBe("public-tok-abc");
    expect(port.visibilities[0]?.visibility).toBe("org"); // public is stored as org + token
    expect(port.tokensCreated).toHaveLength(1);
  });
});

describe("MeetingsService — scope transitions (D8)", () => {
  let port: FakePort;
  let svc: MeetingsService;
  beforeEach(() => {
    port = new FakePort();
    svc = new MeetingsService(port, summarizer);
  });

  it("downgrading public → private revokes the token then narrows visibility", async () => {
    const state = await svc.setMeetingScope({
      recordId: "rec-1",
      userId: "u1",
      orgId: "o1",
      from: "public",
      to: "private",
    });
    expect(port.revokes).toEqual(["rec-1"]);
    expect(state.scope).toBe("private");
    expect(state.publicToken).toBeUndefined();
    expect(port.visibilities.at(-1)?.visibility).toBe("private");
  });

  it("upgrading private → public mints a token without revoking", async () => {
    const state = await svc.setMeetingScope({
      recordId: "rec-1",
      userId: "u1",
      orgId: "o1",
      from: "private",
      to: "public",
    });
    expect(port.revokes).toHaveLength(0);
    expect(state.publicToken).toBe("public-tok-abc");
  });

  it("re-parenting org → team requires a teamId", async () => {
    await expect(
      svc.setMeetingScope({ recordId: "rec-1", userId: "u1", orgId: "o1", from: "org", to: "team" }),
    ).rejects.toBeInstanceOf(MeetingScopeError);
  });

  it("is account-gated", async () => {
    await expect(
      svc.setMeetingScope({ recordId: "rec-1", userId: "", orgId: "o1", from: "private", to: "org" } as {
        recordId: string;
        userId: string;
        orgId: string;
        from: MeetingVisibility;
        to: MeetingVisibility;
      }),
    ).rejects.toBeInstanceOf(MeetingsAccountRequiredError);
  });
});
