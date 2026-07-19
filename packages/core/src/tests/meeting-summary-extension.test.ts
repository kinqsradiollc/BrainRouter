import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-meeting-summary-home-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const {
  formatMeetingSummary,
  MEETING_SUMMARY_FORMAT_TOOL,
} = await import('../extension/meetingSummary.js');
const { loadExtensions } = await import('../extension/loader.js');
const { registryEntry } = await import('../tool/registry/registry.js');
const { localToolExecutor } = await import('../tool/registry/executors.js');

test('general summary matches the reference hierarchy and returns structured actions', () => {
  const result = formatMeetingSummary({
    template: 'general',
    overview: 'The meeting confirmed the first-release scope and timeline.',
    decisions: [
      'Support uploaded documents first.',
      'Build the prototype in one sprint.',
    ],
    action_items: [
      { task: 'Prepare technical design', assignee: '@Anh' },
      { task: 'Confirm user requirements', assignee: 'Daniel', due: 'Friday' },
    ],
  });

  assert.equal(result.markdown, [
    '## Overview',
    '',
    'The meeting confirmed the first-release scope and timeline.',
    '',
    '## Decisions',
    '',
    '- Support uploaded documents first.',
    '- Build the prototype in one sprint.',
    '',
    '## Action Items',
    '',
    '- Prepare technical design — @Anh',
    '- Confirm user requirements — @Daniel _(Due: Friday)_',
  ].join('\n'));
  assert.deepEqual(result.actionItems, [
    { title: 'Prepare technical design', assignee: 'Anh' },
    { title: 'Confirm user requirements', assignee: 'Daniel', due: 'Friday' },
  ]);
});

test('specialized templates have stable, appropriate section ordering', () => {
  const cases = [
    {
      template: 'standup',
      fields: { progress: ['API complete'], blockers: ['Waiting on design'], next_steps: ['Ship preview'] },
      headings: ['Overview', 'Progress', 'Blockers', 'Next Steps', 'Decisions', 'Action Items'],
    },
    {
      template: 'one-on-one',
      fields: { discussion: ['Role scope'], feedback: ['More design context'], commitments: ['Share notes'] },
      headings: ['Overview', 'Discussion', 'Feedback', 'Commitments', 'Decisions', 'Action Items'],
    },
    {
      template: 'retrospective',
      fields: { what_went_well: ['Fast review'], what_did_not_go_well: ['Late handoff'], experiments: ['Pair earlier'] },
      headings: ['Overview', 'What Went Well', "What Didn't Go Well", 'Experiments', 'Decisions', 'Action Items'],
    },
  ] as const;

  for (const item of cases) {
    const result = formatMeetingSummary({
      template: item.template,
      overview: 'A concise overview.',
      decisions: [],
      action_items: [],
      ...item.fields,
    });
    assert.deepEqual(
      [...result.markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      item.headings,
    );
  }
});

test('normalizes model text, deduplicates entries, drops placeholders, and bounds output', () => {
  const oversized = 'x'.repeat(5_000);
  const result = formatMeetingSummary({
    template: 'general',
    overview: '### Overview from model\nwith a second line',
    decisions: ['- Ship Friday', ' ship friday ', '', oversized],
    action_items: [
      { task: 'None.' },
      { task: '### Prepare launch\nchecklist', assignee: '@@alex' },
      { task: 'prepare launch checklist', assignee: 'someone-else' },
    ],
  });

  assert.match(result.markdown, /^## Overview\n\nOverview from model with a second line/);
  assert.equal((result.markdown.match(/Ship Friday/gi) ?? []).length, 1);
  assert.equal(result.actionItems.length, 1);
  assert.deepEqual(result.actionItems[0], { title: 'Prepare launch checklist', assignee: 'alex' });
  assert.ok(result.markdown.length < 10_000, 'formatter caps model-provided text');
  assert.doesNotMatch(result.markdown, /^### Overview from model$/m);
});

test('renders explicit empty-section copy instead of invented bullets', () => {
  const result = formatMeetingSummary({
    template: 'general',
    overview: 'The meeting was informational.',
    decisions: [],
    action_items: [],
  });
  assert.match(result.markdown, /## Decisions\n\n_None recorded\._/);
  assert.match(result.markdown, /## Action Items\n\n_None recorded\._/);
  assert.deepEqual(result.actionItems, []);
});

test('bounds a maximally populated specialized summary below the backend ceiling', () => {
  const points = Array.from({ length: 100 }, (_, index) => `${index} ${'x'.repeat(1_000)}`);
  const actions = Array.from({ length: 100 }, (_, index) => ({
    task: `${index} ${'y'.repeat(1_000)}`,
    assignee: `owner-${index}-${'a'.repeat(500)}`,
    due: `due-${index}-${'d'.repeat(500)}`,
  }));
  const result = formatMeetingSummary({
    template: 'retrospective',
    overview: 'o'.repeat(10_000),
    what_went_well: points,
    what_did_not_go_well: points,
    experiments: points,
    decisions: points,
    action_items: actions,
  });
  assert.equal(result.actionItems.length, 25);
  assert.equal((result.markdown.match(/^- \d+ x/gm) ?? []).length, 48);
  assert.ok(result.markdown.length <= 40_000, `summary was ${result.markdown.length} chars`);
});

test('rejects malformed tool input at the extension boundary', () => {
  assert.throws(() => formatMeetingSummary({ template: 'general', overview: '', decisions: [], action_items: [] }), /overview/i);
  assert.throws(() => formatMeetingSummary({ template: 'weekly', overview: 'ok', decisions: [], action_items: [] }), /template/i);
  assert.throws(() => formatMeetingSummary({ template: 'general', overview: 'ok', decisions: 'yes', action_items: [] }), /decisions/i);
  assert.throws(() => formatMeetingSummary({ template: 'general', overview: 'ok', decisions: [], action_items: [{ assignee: 'alex' }] }), /task/i);
});

test('built-in extension is discoverable and registers the same formatter as a read tool', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-meeting-summary-ws-'));
  const loaded = await loadExtensions(workspace, { version: 'test' });
  assert.ok(loaded.activated.includes('meeting-summary'));

  const entry = registryEntry(MEETING_SUMMARY_FORMAT_TOOL.name);
  assert.deepEqual(entry, {
    name: 'format_meeting_summary',
    accessTier: 'read',
    actionKind: 'read_only',
    parallelSafe: true,
  });

  const executor = localToolExecutor('format_meeting_summary');
  assert.ok(executor);
  const raw = await executor.handle({
    args: {
      template: 'general',
      overview: 'Approved the release.',
      decisions: ['Ship Friday.'],
      action_items: [{ task: 'Publish notes', assignee: 'Anh' }],
    },
  });
  assert.deepEqual(JSON.parse(raw), formatMeetingSummary({
    template: 'general',
    overview: 'Approved the release.',
    decisions: ['Ship Friday.'],
    action_items: [{ task: 'Publish notes', assignee: 'Anh' }],
  }));
});
