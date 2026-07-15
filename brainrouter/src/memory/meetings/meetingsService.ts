/**
 * MeetingsService (ADR-018 M0) — memory-native meeting capture + sharing.
 *
 * Account-gated (D7): storing/summarizing/sharing a meeting requires `userId` + `orgId`.
 * Memory-native (D1): transcript → `SourceDocument(kind:"transcript")`, summary →
 * `CognitiveRecord`s (through the redaction chokepoint), linked for graph provenance.
 * Sharing (D8): four-level ladder via {@link ./sharing}.
 *
 * Dependencies are injected ({@link MeetingsMemoryPort}, {@link MeetingSummarizer}) so this
 * is unit-testable now and the real-engine adapter + server-managed summarizer are finalized
 * after Codex's provider work lands.
 */

import {
  assertScopeParams,
  isScopeDowngrade,
  isPublicScope,
  scopeToBackendVisibility,
} from "./sharing.js";
import type {
  MeetingRecordResult,
  MeetingShareState,
  MeetingSummarizer,
  MeetingsMemoryPort,
  MeetingVisibility,
  RecordMeetingInput,
} from "./types.js";

export class MeetingsAccountRequiredError extends Error {
  constructor() {
    super("Meetings requires a BrainRouter sign-in (userId + orgId).");
    this.name = "MeetingsAccountRequiredError";
  }
}

export class MeetingsService {
  constructor(
    private readonly port: MeetingsMemoryPort,
    private readonly summarizer: MeetingSummarizer,
  ) {}

  /** Ingest a transcript, summarize it, store it as memory, and apply the initial scope. */
  async recordMeetingSummary(input: RecordMeetingInput): Promise<MeetingRecordResult> {
    this.assertAccount(input.userId, input.orgId);
    const scope: MeetingVisibility = input.scope ?? "private";
    assertScopeParams(scope, input.teamId);
    if (!input.transcript.trim()) throw new Error("Cannot record a meeting with an empty transcript.");

    const { sourceId, chunkIds } = await this.port.ingestTranscript({
      userId: input.userId,
      orgId: input.orgId,
      meetingId: input.meetingId,
      sessionKey: input.sessionKey,
      text: input.transcript,
    });

    const summary = await this.summarizer.summarize({
      transcript: input.transcript,
      template: input.template,
      language: input.language,
      orgId: input.orgId,
    });

    const { recordId } = await this.port.upsertSummaryRecord({
      userId: input.userId,
      orgId: input.orgId,
      sessionKey: input.sessionKey,
      content: summary.markdown,
      metadata: {
        kind: "meeting",
        meetingId: input.meetingId,
        title: input.title,
        date: input.date,
        attendees: (input.attendees ?? []).map((a) => a.handle),
        language: summary.language ?? input.language,
        sourceId,
      },
    });

    await this.port.linkRecordSources(input.userId, recordId, chunkIds);

    const share = await this.applyScope({
      recordId,
      userId: input.userId,
      orgId: input.orgId,
      scope,
      teamId: input.teamId,
      shareExpiresAt: input.shareExpiresAt,
    });

    return {
      meetingId: input.meetingId,
      recordId,
      sourceId,
      chunkIds,
      actionItems: summary.actionItems,
      share,
    };
  }

  /**
   * Change a meeting's sharing scope. Only the owner may call this (the port's visibility
   * write is `user_id`-guarded). Downgrading out of `public` revokes the token first (D8).
   */
  async setMeetingScope(params: {
    recordId: string;
    userId: string;
    orgId: string;
    from: MeetingVisibility;
    to: MeetingVisibility;
    teamId?: string;
    shareExpiresAt?: string;
  }): Promise<MeetingShareState> {
    this.assertAccount(params.userId, params.orgId);
    assertScopeParams(params.to, params.teamId);
    // Revoke any public token when leaving public (immediate, before narrowing visibility).
    if (isPublicScope(params.from) && isScopeDowngrade(params.from, params.to)) {
      await this.port.revokeShareTokens(params.recordId);
    }
    return this.applyScope({
      recordId: params.recordId,
      userId: params.userId,
      orgId: params.orgId,
      scope: params.to,
      teamId: params.teamId,
      shareExpiresAt: params.shareExpiresAt,
    });
  }

  private async applyScope(params: {
    recordId: string;
    userId: string;
    orgId: string;
    scope: MeetingVisibility;
    teamId?: string;
    shareExpiresAt?: string;
  }): Promise<MeetingShareState> {
    const backendVisibility = scopeToBackendVisibility(params.scope);
    const ok = await this.port.setVisibility({
      recordId: params.recordId,
      userId: params.userId,
      orgId: params.orgId,
      teamId: params.scope === "team" ? params.teamId : undefined,
      visibility: backendVisibility,
    });
    if (!ok) {
      throw new Error("Failed to set meeting visibility (not the owner, or record missing).");
    }
    const state: MeetingShareState = { scope: params.scope };
    if (params.scope === "team") state.teamId = params.teamId;
    if (isPublicScope(params.scope)) {
      const { token } = await this.port.createShareToken({
        recordId: params.recordId,
        orgId: params.orgId,
        createdBy: params.userId,
        expiresAt: params.shareExpiresAt,
      });
      state.publicToken = token;
    }
    return state;
  }

  private assertAccount(userId: string, orgId: string): void {
    if (!userId || !orgId) throw new MeetingsAccountRequiredError();
  }
}
