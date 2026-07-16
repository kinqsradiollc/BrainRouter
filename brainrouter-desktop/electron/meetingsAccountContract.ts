/**
 * Pure account-API request builders for the desktop Meetings area.
 *
 * Keeping URL construction, methods, validation, and payload shapes here makes
 * the privileged Electron bridge auditable without importing Electron in tests.
 * The renderer never receives the account bearer; it only supplies bounded data
 * which these builders validate before the main process sends a request.
 */

export type MeetingScope = 'private' | 'team' | 'org' | 'public';
export type TrackStatusCategory = 'todo' | 'in_progress' | 'completed';
export type TeamRole = 'member' | 'admin' | 'owner';
export type TeamKind = 'organization' | 'personal';

export interface AccountRequest {
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  json?: Record<string, unknown>;
  bytes?: Uint8Array;
  contentType?: string;
  /** Optional active organization. Main validates it server-side via the org header. */
  orgId?: string;
}

const SCOPES = new Set<MeetingScope>(['private', 'team', 'org', 'public']);
const TRACK_CATEGORIES = new Set<TrackStatusCategory>(['todo', 'in_progress', 'completed']);
const TEAM_ROLES = new Set<TeamRole>(['member', 'admin', 'owner']);
const TEAM_KINDS = new Set<TeamKind>(['organization', 'personal']);
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

function boundedText(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} is too long.`);
  return required ? text : value;
}

/** Opaque IDs are still encoded, but path/control characters are rejected first. */
export function safeOpaqueId(value: unknown, label: string): string {
  const id = boundedText(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9@._:-]*$/.test(id)) throw new Error(`Invalid ${label}.`);
  return encodeURIComponent(id);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${label}.`);
  return Number(value);
}

function cursor(value: unknown, max = 4096): string | undefined {
  if (value == null || value === '') return undefined;
  return boundedText(value, 'cursor', max);
}

function query(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value !== undefined) params.set(key, String(value));
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function scope(value: unknown): MeetingScope {
  if (typeof value !== 'string' || !SCOPES.has(value as MeetingScope)) throw new Error('Invalid meeting scope.');
  return value as MeetingScope;
}

function category(value: unknown): TrackStatusCategory {
  if (typeof value !== 'string' || !TRACK_CATEGORIES.has(value as TrackStatusCategory)) throw new Error('Invalid Track status category.');
  return value as TrackStatusCategory;
}

function role(value: unknown): TeamRole {
  if (typeof value !== 'string' || !TEAM_ROLES.has(value as TeamRole)) throw new Error('Invalid team role.');
  return value as TeamRole;
}

function teamKind(value: unknown): TeamKind {
  if (typeof value !== 'string' || !TEAM_KINDS.has(value as TeamKind)) throw new Error('Invalid team kind.');
  return value as TeamKind;
}

function optionalOrgId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? decodeURIComponent(safeOpaqueId(value, 'organization id')) : undefined;
}

export const meetingRequests = {
  list(input: { cursor?: string; limit?: number } = {}, orgId?: unknown): AccountRequest {
    return { path: query('/api/meetings', [['limit', boundedInt(input.limit, 50, 1, 100, 'meetings limit')], ['cursor', cursor(input.cursor)]]), method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  detail(meetingId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}`, method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  overview(meetingId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/overview`, method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  transcript(meetingId: unknown, input: { cursor?: string; limit?: number } = {}, orgId?: unknown): AccountRequest {
    return {
      path: query(`/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/transcript`, [
        ['limit', boundedInt(input.limit, 100, 1, 200, 'transcript limit')],
        ['cursor', cursor(input.cursor, 32)],
      ]),
      method: 'GET',
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  create(input: unknown, orgId?: unknown): AccountRequest {
    if (!input || typeof input !== 'object') throw new Error('Meeting input is required.');
    const raw = input as Record<string, unknown>;
    const title = boundedText(raw.title, 'Meeting title', 500);
    const transcript = boundedText(raw.transcript, 'Transcript', 2_000_000, false);
    if (!transcript.trim()) throw new Error('Transcript is required.');
    const template = ['general', 'standup', 'one-on-one', 'retrospective'].includes(String(raw.template)) ? String(raw.template) : 'general';
    const requestedScope = raw.scope == null ? 'private' : scope(raw.scope);
    const teamId = typeof raw.teamId === 'string' && raw.teamId.trim() ? decodeURIComponent(safeOpaqueId(raw.teamId, 'team id')) : undefined;
    if (requestedScope === 'team' && !teamId) throw new Error('A team is required for team sharing.');
    const attendees = Array.isArray(raw.attendees)
      ? raw.attendees.slice(0, 200).map((item) => boundedText(item, 'Attendee', 256))
      : undefined;
    return {
      path: '/api/meetings', method: 'POST',
      json: {
        title, transcript, template, scope: requestedScope,
        ...(teamId ? { teamId } : {}),
        ...(typeof raw.date === 'string' && raw.date.trim() ? { date: boundedText(raw.date, 'Meeting date', 64) } : {}),
        ...(attendees ? { attendees } : {}),
      },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  updateSummary(meetingId: unknown, summaryMarkdown: unknown, orgId?: unknown): AccountRequest {
    return {
      path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/summary`, method: 'PATCH',
      json: { summaryMarkdown: boundedText(summaryMarkdown, 'Summary', 500_000, false) },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  regenerate(meetingId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/regenerate`, method: 'POST', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  setScope(meetingId: unknown, requested: unknown, opts?: unknown, orgId?: unknown): AccountRequest {
    const next = scope(requested);
    const teamId = opts && typeof opts === 'object' && typeof (opts as { teamId?: unknown }).teamId === 'string'
      ? decodeURIComponent(safeOpaqueId((opts as { teamId: string }).teamId, 'team id'))
      : undefined;
    if (next === 'team' && !teamId) throw new Error('A team is required for team sharing.');
    return {
      path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/scope`, method: 'POST',
      json: { scope: next, ...(teamId ? { teamId } : {}) },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  toggleAction(meetingId: unknown, actionId: unknown, done: unknown, orgId?: unknown): AccountRequest {
    if (typeof done !== 'boolean') throw new Error('Action state must be a boolean.');
    return {
      path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/actions/${safeOpaqueId(actionId, 'action id')}`,
      method: 'POST', json: { done },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  trackAction(meetingId: unknown, actionId: unknown, remove = false, orgId?: unknown): AccountRequest {
    return {
      path: `/api/meetings/${safeOpaqueId(meetingId, 'meeting id')}/actions/${safeOpaqueId(actionId, 'action id')}/track`,
      method: remove ? 'DELETE' : 'POST',
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  transcribe(input: unknown): AccountRequest {
    if (!input || typeof input !== 'object') throw new Error('Audio input is required.');
    const raw = input as { bytes?: unknown; contentType?: unknown; language?: unknown };
    const bytes = raw.bytes instanceof Uint8Array ? raw.bytes : raw.bytes instanceof ArrayBuffer ? new Uint8Array(raw.bytes) : null;
    if (!bytes?.byteLength) throw new Error('Audio is empty.');
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('Audio exceeds the 40 MB limit.');
    const contentType = typeof raw.contentType === 'string' && /^(audio\/[A-Za-z0-9.+-]+|video\/webm|application\/octet-stream)$/.test(raw.contentType)
      ? raw.contentType : 'application/octet-stream';
    const language = raw.language == null || raw.language === '' || raw.language === 'auto'
      ? undefined : boundedText(raw.language, 'Language', 24);
    if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new Error('Invalid language.');
    return { path: query('/v1/audio/transcriptions', [['language', language]]), method: 'POST', bytes, contentType };
  },
};

export const trackRequests = {
  list(orgId?: unknown): AccountRequest { return { path: '/api/track', method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) }; },
  create(input: unknown, orgId?: unknown): AccountRequest {
    if (!input || typeof input !== 'object') throw new Error('Track input is required.');
    const raw = input as Record<string, unknown>;
    const title = boundedText(raw.title, 'Track title', 500);
    if (/^(none|null|n\/a|undefined)[.!?]?$/i.test(title)) throw new Error('Track title must describe real work.');
    return {
      path: '/api/track', method: 'POST',
      json: {
        title,
        ...(typeof raw.description === 'string' ? { description: boundedText(raw.description, 'Track description', 20_000, false) } : {}),
        ...(typeof raw.priority === 'string' ? { priority: boundedText(raw.priority, 'Track priority', 64) } : {}),
        ...(typeof raw.assignee === 'string' && raw.assignee.trim() ? { assignee: boundedText(raw.assignee, 'Track assignee', 256) } : {}),
        ...(raw.statusCategory == null ? {} : { statusCategory: category(raw.statusCategory) }),
      },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  transition(trackId: unknown, statusCategory: unknown, orgId?: unknown): AccountRequest {
    return {
      path: `/api/track/${safeOpaqueId(trackId, 'track id')}/transition`, method: 'POST',
      json: { statusCategory: category(statusCategory) },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  remove(trackId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/track/${safeOpaqueId(trackId, 'track id')}`, method: 'DELETE', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
};

export const teamRequests = {
  contexts(): AccountRequest { return { path: '/api/orgs', method: 'GET' }; },
  list(orgId?: unknown): AccountRequest { return { path: '/api/teams', method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) }; },
  detail(teamId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/teams/${safeOpaqueId(teamId, 'team id')}`, method: 'GET', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  create(name: unknown, kind: unknown = 'organization', orgId?: unknown): AccountRequest {
    return { path: '/api/teams', method: 'POST', json: { name: boundedText(name, 'Team name', 200), kind: teamKind(kind) }, ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
  addMember(teamId: unknown, account: unknown, memberRole: unknown, orgId?: unknown): AccountRequest {
    const identifier = boundedText(account, 'Account', 320);
    return {
      path: `/api/teams/${safeOpaqueId(teamId, 'team id')}/members`, method: 'POST',
      json: { ...(identifier.includes('@') ? { email: identifier.toLowerCase() } : { userId: identifier }), role: role(memberRole) },
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  removeMember(teamId: unknown, userId: unknown, orgId?: unknown): AccountRequest {
    return {
      path: `/api/teams/${safeOpaqueId(teamId, 'team id')}/members/${safeOpaqueId(userId, 'user id')}`,
      method: 'DELETE',
      ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}),
    };
  },
  remove(teamId: unknown, orgId?: unknown): AccountRequest {
    return { path: `/api/teams/${safeOpaqueId(teamId, 'team id')}`, method: 'DELETE', ...(optionalOrgId(orgId) ? { orgId: optionalOrgId(orgId) } : {}) };
  },
};
