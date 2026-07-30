import { describe, expect, it } from "vitest";
import type { LLMRunParams, LLMRunner } from "@kinqs/brainrouter-types";
import { generateMeetingSummary, meetingActionItemsForStorage } from "./summary.js";

class FakeRunner implements LLMRunner {
  readonly calls: LLMRunParams[] = [];

  constructor(private readonly output: string) {}

  async run(params: LLMRunParams): Promise<string> {
    this.calls.push(params);
    return this.output;
  }
}

describe("meeting summary forced-tool adapter", () => {
  it("forces format_meeting_summary and returns deterministic Markdown plus structured actions", async () => {
    const runner = new FakeRunner(JSON.stringify({
      template: "retrospective",
      overview: "The team confirmed the initial product scope.",
      decisions: ["Support uploaded documents in the first release."],
      action_items: [
        { task: "Prepare technical design", assignee: "Anh" },
        { task: "Confirm requirements", assignee: "Daniel", due: "Friday" },
      ],
      what_went_well: ["This must not select the model-provided template."],
    }));

    const result = await generateMeetingSummary(runner, {
      title: "Project Planning Meeting",
      transcript: "We agreed that uploaded documents are first. Anh will prepare the design.",
      template: "general",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].tool?.name).toBe("format_meeting_summary");
    expect(runner.calls[0].tool?.parameters).toMatchObject({
      type: "object",
      required: ["template", "overview", "decisions", "action_items"],
    });
    expect(runner.calls[0].systemPrompt).toContain("call format_meeting_summary exactly once");
    expect(runner.calls[0].systemPrompt).toContain("If tool calling is unavailable");
    expect(runner.calls[0].systemPrompt).toContain("Never invent");
    expect(runner.calls[0].prompt).toContain("Meeting: Project Planning Meeting");

    expect(result.markdown).toBe([
      "## Overview",
      "",
      "The team confirmed the initial product scope.",
      "",
      "## Decisions",
      "",
      "- Support uploaded documents in the first release.",
      "",
      "## Action Items",
      "",
      "- Prepare technical design — @Anh",
      "- Confirm requirements — @Daniel _(Due: Friday)_",
    ].join("\n"));
    expect(result.markdown).not.toContain("What Went Well");
    expect(result.actionItems).toEqual([
      { title: "Prepare technical design", assignee: "Anh" },
      { title: "Confirm requirements", assignee: "Daniel", due: "Friday" },
    ]);
    expect(meetingActionItemsForStorage(result.actionItems)).toEqual([
      { id: "ai-1", title: "Prepare technical design", assignee: "Anh", done: false },
      { id: "ai-2", title: "Confirm requirements", assignee: "Daniel", due: "Friday", done: false },
    ]);
  });

  it("preserves the selected specialized template and parses fenced JSON fallback output", async () => {
    const runner = new FakeRunner(`Here is the result:\n\`\`\`json
{
  "template": "general",
  "overview": "The team reviewed delivery status.",
  "progress": ["API is complete."],
  "blockers": ["Design approval is pending."],
  "next_steps": ["Ship the preview."],
  "decisions": [],
  "action_items": []
}
\`\`\``);

    const result = await generateMeetingSummary(runner, {
      title: "Standup",
      transcript: "API is done. Design approval blocks the preview.",
      template: "standup",
    });

    expect([...result.markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      "Overview",
      "Progress",
      "Blockers",
      "Next Steps",
      "Decisions",
      "Action Items",
    ]);
  });

  it("rejects malformed or incomplete structured model output", async () => {
    const malformed = new FakeRunner("## Overview\nThis is model-authored Markdown.");
    await expect(generateMeetingSummary(malformed, {
      title: "Bad output",
      transcript: "Transcript",
      template: "general",
    })).rejects.toThrow(/parseable JSON object/i);

    const incomplete = new FakeRunner(JSON.stringify({
      template: "general",
      overview: "",
      decisions: [],
      action_items: [],
    }));
    await expect(generateMeetingSummary(incomplete, {
      title: "Empty overview",
      transcript: "Transcript",
      template: "general",
    })).rejects.toThrow(/overview/i);
  });

  it("bounds transcript content sent to the provider", async () => {
    const runner = new FakeRunner(JSON.stringify({
      template: "general",
      overview: "A bounded transcript was summarized.",
      decisions: [],
      action_items: [],
    }));
    await generateMeetingSummary(runner, {
      title: "Long meeting",
      transcript: "x".repeat(50_000),
      template: "general",
    });
    expect(runner.calls[0].prompt.length).toBeLessThan(41_000);
    expect(runner.calls[0].prompt).not.toContain("x".repeat(40_001));
  });
});
