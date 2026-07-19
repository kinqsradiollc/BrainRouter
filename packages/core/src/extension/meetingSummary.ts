/**
 * Deterministic meeting-summary formatter shared by the built-in extension and
 * the BrainRouter backend. The model extracts facts into this schema; code owns
 * the final Markdown hierarchy so provider/model variation cannot change it.
 */

export const MEETING_SUMMARY_TEMPLATE_NAMES = [
  'general',
  'standup',
  'one-on-one',
  'retrospective',
] as const;

export type MeetingSummaryTemplateName = typeof MEETING_SUMMARY_TEMPLATE_NAMES[number];

export interface MeetingSummaryActionItem {
  title: string;
  assignee?: string;
  due?: string;
}

export interface FormattedMeetingSummary {
  markdown: string;
  actionItems: MeetingSummaryActionItem[];
}

const listSchema = (description: string): Record<string, unknown> => ({
  type: 'array',
  description,
  items: { type: 'string' },
});

/** Forced-tool contract used by the backend and advertised by the extension. */
export const MEETING_SUMMARY_FORMAT_TOOL = {
  name: 'format_meeting_summary',
  description:
    'Format extracted meeting facts into BrainRouter meeting notes. Extract only facts supported by the transcript. Use empty arrays when a section has no supported content; never invent decisions, owners, or due dates.',
  parameters: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        enum: [...MEETING_SUMMARY_TEMPLATE_NAMES],
        description: 'The requested meeting-summary template.',
      },
      overview: {
        type: 'string',
        description: 'A concise 2-4 sentence overview grounded in the transcript.',
      },
      decisions: listSchema('Explicit decisions or commitments established in the meeting.'),
      action_items: {
        type: 'array',
        description: 'Concrete follow-up work. Do not emit placeholders such as None or N/A.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'A concrete task phrased as an action.' },
            assignee: { type: 'string', description: 'Owner only when explicitly supported by the transcript.' },
            due: { type: 'string', description: 'Due date only when explicitly supported by the transcript.' },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      progress: listSchema('Standup progress since the prior check-in.'),
      blockers: listSchema('Standup blockers or risks.'),
      next_steps: listSchema('Standup next steps.'),
      discussion: listSchema('One-on-one discussion topics and context.'),
      feedback: listSchema('One-on-one feedback exchanged.'),
      commitments: listSchema('One-on-one commitments made by either participant.'),
      what_went_well: listSchema('Retrospective successes and strengths.'),
      what_did_not_go_well: listSchema('Retrospective problems or friction.'),
      experiments: listSchema('Retrospective experiments or process changes to try.'),
    },
    required: ['template', 'overview', 'decisions', 'action_items'],
    additionalProperties: false,
  },
} as const;

// These per-field limits also form a whole-document bound: the largest template
// (four list sections + actions + overview) remains below Meetings' 40k summary
// ceiling even when every accepted field is maximally populated.
const MAX_OVERVIEW_CHARS = 3_000;
const MAX_LIST_ITEM_CHARS = 400;
const MAX_LIST_ITEMS = 12;
const MAX_ACTION_ITEMS = 25;
const MAX_ACTION_META_CHARS = 120;

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('format_meeting_summary requires an object input.');
  }
  return value as Record<string, unknown>;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Collapse model-authored block Markdown into safe inline content. */
function inlineText(value: string, maxChars: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:#{1,6}|[-*+])\s+/, '')
    .trim();
  return bounded(normalized, maxChars);
}

function templateName(value: unknown): MeetingSummaryTemplateName {
  if (typeof value !== 'string' || !MEETING_SUMMARY_TEMPLATE_NAMES.includes(value as MeetingSummaryTemplateName)) {
    throw new Error(`format_meeting_summary received an invalid template: ${String(value ?? '')}`);
  }
  return value as MeetingSummaryTemplateName;
}

function stringList(input: Record<string, unknown>, key: string, required = false): string[] {
  const raw = input[key];
  if (raw === undefined && !required) return [];
  if (!Array.isArray(raw)) throw new Error(`format_meeting_summary field "${key}" must be an array of strings.`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') throw new Error(`format_meeting_summary field "${key}" must contain only strings.`);
    const text = inlineText(value, MAX_LIST_ITEM_CHARS);
    if (!text) continue;
    const identity = text.toLocaleLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(text);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function meaningfulTask(value: string): boolean {
  return !/^(?:none|null|n\/a|undefined|no action items?)[.!?]?$/i.test(value.trim());
}

function actionItems(input: Record<string, unknown>): MeetingSummaryActionItem[] {
  const raw = input.action_items;
  if (!Array.isArray(raw)) throw new Error('format_meeting_summary field "action_items" must be an array.');
  const seen = new Set<string>();
  const out: MeetingSummaryActionItem[] = [];
  for (const value of raw) {
    const item = objectValue(value);
    if (typeof item.task !== 'string') throw new Error('Every format_meeting_summary action item requires a string task.');
    const title = inlineText(item.task, MAX_LIST_ITEM_CHARS);
    if (!title || !meaningfulTask(title)) continue;
    const identity = title.toLocaleLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    const result: MeetingSummaryActionItem = { title };
    if (item.assignee !== undefined) {
      if (typeof item.assignee !== 'string') throw new Error('Action-item assignee must be a string when provided.');
      const assignee = inlineText(item.assignee, MAX_ACTION_META_CHARS).replace(/^@+/, '').trim();
      if (assignee) result.assignee = assignee;
    }
    if (item.due !== undefined) {
      if (typeof item.due !== 'string') throw new Error('Action-item due must be a string when provided.');
      const due = inlineText(item.due, MAX_ACTION_META_CHARS);
      if (due) result.due = due;
    }
    out.push(result);
    if (out.length >= MAX_ACTION_ITEMS) break;
  }
  return out;
}

function listSection(title: string, items: string[]): string[] {
  return [`## ${title}`, '', items.length ? items.map((item) => `- ${item}`).join('\n') : '_None recorded._'];
}

function actionSection(items: MeetingSummaryActionItem[]): string[] {
  const lines = items.map((item) => {
    const assignee = item.assignee ? ` — @${item.assignee}` : '';
    const due = item.due ? ` _(Due: ${item.due})_` : '';
    return `- ${item.title}${assignee}${due}`;
  });
  return ['## Action Items', '', lines.length ? lines.join('\n') : '_None recorded._'];
}

/** Validate extracted facts and render a stable meeting-note hierarchy. */
export function formatMeetingSummary(value: unknown): FormattedMeetingSummary {
  const input = objectValue(value);
  const template = templateName(input.template);
  if (typeof input.overview !== 'string') throw new Error('format_meeting_summary requires a string overview.');
  const overview = inlineText(input.overview, MAX_OVERVIEW_CHARS);
  if (!overview) throw new Error('format_meeting_summary requires a non-empty overview.');

  const decisions = stringList(input, 'decisions', true);
  const actions = actionItems(input);
  const sections: string[][] = [['## Overview', '', overview]];

  if (template === 'standup') {
    sections.push(
      listSection('Progress', stringList(input, 'progress')),
      listSection('Blockers', stringList(input, 'blockers')),
      listSection('Next Steps', stringList(input, 'next_steps')),
    );
  } else if (template === 'one-on-one') {
    sections.push(
      listSection('Discussion', stringList(input, 'discussion')),
      listSection('Feedback', stringList(input, 'feedback')),
      listSection('Commitments', stringList(input, 'commitments')),
    );
  } else if (template === 'retrospective') {
    sections.push(
      listSection('What Went Well', stringList(input, 'what_went_well')),
      listSection("What Didn't Go Well", stringList(input, 'what_did_not_go_well')),
      listSection('Experiments', stringList(input, 'experiments')),
    );
  }

  sections.push(listSection('Decisions', decisions), actionSection(actions));
  return { markdown: sections.map((section) => section.join('\n')).join('\n\n'), actionItems: actions };
}
