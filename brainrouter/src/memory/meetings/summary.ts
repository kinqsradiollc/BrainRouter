/**
 * Meetings backend adapter for the built-in meeting-summary format extension.
 * The routed model extracts transcript facts through a forced tool call; the
 * shared core formatter owns the final Markdown and action-item structure.
 */
import {
  formatMeetingSummary,
  MEETING_SUMMARY_FORMAT_TOOL,
  type FormattedMeetingSummary,
  type MeetingSummaryActionItem,
  type MeetingSummaryTemplateName,
} from "@kinqs/brainrouter-core/extension";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import { extractJsonValueOrThrow } from "../util/llm-json.js";

const TEMPLATE_FIELDS: Record<MeetingSummaryTemplateName, string> = {
  general: "overview, decisions, and action_items",
  standup: "overview, progress, blockers, next_steps, decisions, and action_items",
  "one-on-one": "overview, discussion, feedback, commitments, decisions, and action_items",
  retrospective: "overview, what_went_well, what_did_not_go_well, experiments, decisions, and action_items",
};

function extractionSystemPrompt(template: MeetingSummaryTemplateName): string {
  return [
    "You extract accurate meeting facts for BrainRouter.",
    "You must call format_meeting_summary exactly once with the requested template and only information supported by the transcript.",
    `Populate ${TEMPLATE_FIELDS[template]}. Keep the overview concise (2-4 sentences) and use short, specific list entries.`,
    "Never invent decisions, action items, assignees, due dates, progress, blockers, feedback, or commitments. Use empty arrays when the transcript does not establish them.",
    "Do not add a title, date, preamble, Markdown headings, or commentary; BrainRouter renders those deterministically.",
    "If tool calling is unavailable, return only one JSON object matching the format_meeting_summary parameters, with no prose or code fence.",
  ].join(" ");
}

export async function generateMeetingSummary(
  runner: LLMRunner,
  input: {
    title: string;
    transcript: string;
    template?: MeetingSummaryTemplateName;
  },
): Promise<FormattedMeetingSummary> {
  const title = input.title.trim();
  const transcript = input.transcript.trim();
  if (!title) throw new Error("Meeting summary generation requires a title.");
  if (!transcript) throw new Error("Meeting summary generation requires a transcript.");
  const template = input.template ?? "general";

  const raw = await runner.run({
    systemPrompt: extractionSystemPrompt(template),
    prompt: `Meeting: ${title}\nTemplate: ${template}\n\nTranscript:\n${transcript.slice(0, 40_000)}`,
    taskId: "meeting-summary",
    timeoutMs: 120_000,
    tool: {
      name: MEETING_SUMMARY_FORMAT_TOOL.name,
      description: MEETING_SUMMARY_FORMAT_TOOL.description,
      parameters: MEETING_SUMMARY_FORMAT_TOOL.parameters as Record<string, unknown>,
    },
  });

  const extracted = extractJsonValueOrThrow(raw, {
    kind: "object",
    label: "Meeting summary",
  }) as Record<string, unknown>;

  // The caller's selection is authoritative. A model cannot silently switch the
  // summary layout by returning a different `template` argument.
  return formatMeetingSummary({ ...extracted, template });
}

/** Convert validated tool actions into the exact JSON shape persisted by Meetings. */
export function meetingActionItemsForStorage(items: MeetingSummaryActionItem[]): Array<{
  id: string;
  title: string;
  assignee?: string;
  due?: string;
  done: false;
}> {
  return items.map((item, index) => ({
    id: `ai-${index + 1}`,
    title: item.title,
    ...(item.assignee ? { assignee: item.assignee } : {}),
    ...(item.due ? { due: item.due } : {}),
    done: false,
  }));
}
