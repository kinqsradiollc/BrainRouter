/**
 * ADR-035 D11 — the escrow record, which is a WIRE: the browser builds one and
 * the route accepts one, through this single normalizer.
 *
 * So what is tested is the boundary between "refuse" and "clamp". Refusing is
 * for identity only — an id that is not a capture, a start instant nobody can
 * read — because everything else the client can send is somebody's meeting, and
 * a server that declined to hold a meeting over a long title would be failing at
 * the one job this path has.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEscrowWorthKeeping,
  MEETING_ESCROW_MAX_TITLE_CHARS,
  MEETING_ESCROW_MAX_TRANSCRIPT_CHARS,
  MEETING_RETENTION_DEFAULT_DAYS,
  meetingRetentionChoiceLabel,
  normalizeCaptureEscrow,
} from '../meetings/index.js';

const GOOD = {
  sessionId: 'mtg-2026-08-12-abcdef',
  title: '  Weekly sync  ',
  template: 'standup',
  language: 'en',
  startedAt: '2026-08-12T09:00:00.000Z',
  transcript: 'we agreed on the plan',
  coverageMs: 61_500,
  retentionDays: 7,
};

test('D11 — a well-formed escrow keeps every field the meeting is made of', () => {
  const escrow = normalizeCaptureEscrow(GOOD);
  assert.ok(escrow);
  assert.deepEqual(escrow, {
    sessionId: 'mtg-2026-08-12-abcdef',
    title: 'Weekly sync',
    template: 'standup',
    language: 'en',
    startedAt: '2026-08-12T09:00:00.000Z',
    transcript: 'we agreed on the plan',
    coverageMs: 61_500,
    retentionDays: 7,
  });
});

test('D11 — only identity is a refusal: an unusable id or an unreadable start', () => {
  assert.equal(normalizeCaptureEscrow({ ...GOOD, sessionId: '../../etc/passwd' }), null);
  assert.equal(normalizeCaptureEscrow({ ...GOOD, sessionId: '' }), null);
  assert.equal(normalizeCaptureEscrow({ ...GOOD, sessionId: 42 }), null);
  assert.equal(normalizeCaptureEscrow({ ...GOOD, startedAt: 'whenever' }), null);
  assert.equal(normalizeCaptureEscrow({ ...GOOD, startedAt: undefined }), null);
});

test('D11 — everything else is clamped, because the alternative is refusing a meeting', () => {
  const escrow = normalizeCaptureEscrow({
    ...GOOD,
    title: 't'.repeat(MEETING_ESCROW_MAX_TITLE_CHARS + 200),
    template: 'invented',
    language: 'l'.repeat(80),
    transcript: 'w'.repeat(MEETING_ESCROW_MAX_TRANSCRIPT_CHARS + 1_000),
    coverageMs: -12,
    retentionDays: 'soon',
  });
  assert.ok(escrow);
  assert.equal(escrow.title.length, MEETING_ESCROW_MAX_TITLE_CHARS);
  assert.equal(escrow.template, 'general');
  assert.equal(escrow.language.length, 32);
  assert.equal(escrow.transcript.length, MEETING_ESCROW_MAX_TRANSCRIPT_CHARS);
  assert.equal(escrow.coverageMs, 0);
  assert.equal(escrow.retentionDays, MEETING_RETENTION_DEFAULT_DAYS);
});

test('D11 — a transcript at the bound keeps its BEGINNING, which nothing else can rebuild', () => {
  const escrow = normalizeCaptureEscrow({
    ...GOOD,
    transcript: `first words${'x'.repeat(MEETING_ESCROW_MAX_TRANSCRIPT_CHARS)}last words`,
  });
  assert.ok(escrow);
  assert.ok(escrow.transcript.startsWith('first words'));
  assert.equal(escrow.transcript.endsWith('last words'), false);
});

test('D11 — a capture with no words in it is not worth holding', () => {
  const empty = normalizeCaptureEscrow({ ...GOOD, transcript: '   \n  ' });
  assert.ok(empty);
  assert.equal(isEscrowWorthKeeping(empty), false);
  assert.equal(isEscrowWorthKeeping(normalizeCaptureEscrow(GOOD)!), true);
});

test('D6 — one ladder, one label, so two hosts cannot describe one window differently', () => {
  assert.equal(meetingRetentionChoiceLabel(1), '1 day');
  assert.equal(meetingRetentionChoiceLabel(7), '1 week');
  assert.equal(meetingRetentionChoiceLabel(14), '2 weeks');
  assert.equal(meetingRetentionChoiceLabel(30), '1 month');
  assert.equal(meetingRetentionChoiceLabel(90), '3 months');
  assert.equal(meetingRetentionChoiceLabel(365), '1 year');
  // Not on the ladder, and out of range: a stored window still prints as one.
  assert.equal(meetingRetentionChoiceLabel(11), '11 days');
  assert.equal(meetingRetentionChoiceLabel(10_000), '1 year');
});
