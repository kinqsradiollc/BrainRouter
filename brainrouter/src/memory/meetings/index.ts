/** Meetings capability (ADR-018). */
export { MeetingsService, MeetingsAccountRequiredError } from "./meetingsService.js";
export {
  MEETING_VISIBILITIES,
  MeetingScopeError,
  assertScopeParams,
  isMeetingVisibility,
  isOutwardFacing,
  isPublicScope,
  isScopeDowngrade,
  scopeToBackendVisibility,
} from "./sharing.js";
export type {
  MeetingActionItem,
  MeetingAttendee,
  MeetingRecordResult,
  MeetingShareState,
  MeetingSummarizer,
  MeetingSummaryResult,
  MeetingSummaryTemplate,
  MeetingsMemoryPort,
  MeetingVisibility,
  RecordMeetingInput,
} from "./types.js";
