import type { CognitiveRecord, ContextualFocusRecord, LLMRunner } from "@kinqs/brainrouter-types";
import { FOCUS_DIRECTION_SHIFT_SYSTEM_PROMPT, formatFocusDirectionShiftPrompt } from "../prompts/focus-direction-shift.js";
import { extractJsonValue } from "../util/llm-json.js";

export async function detectFocusShift(params: {
  activeScene: ContextualFocusRecord;
  newCognitiveRecords: CognitiveRecord[];
  llmRunner: LLMRunner;
}): Promise<{ shift: boolean; confidence: number; reason: string }> {
  const { activeScene, newCognitiveRecords, llmRunner } = params;

  try {
    const prompt = formatFocusDirectionShiftPrompt(
      activeScene.sceneName,
      activeScene.summaryMd,
      newCognitiveRecords.map(r => ({ content: r.content, type: r.type }))
    );

    const response = await llmRunner.run({
      prompt,
      systemPrompt: FOCUS_DIRECTION_SHIFT_SYSTEM_PROMPT,
      taskId: "focus-direction-shift",
      timeoutMs: 30_000,
      // STRUCTURED OUTPUT — force the shift decision through a schema'd tool call
      // (consistent across models; see modelRunner.ts). The prompt still
      // describes the semantics of each field.
      tool: {
        name: "report_direction_shift",
        description: "Report whether the conversation's direction shifted, per the prompt.",
        parameters: {
          type: "object",
          properties: {
            shift: { type: "boolean" },
            confidence: { type: "number", description: "0..1" },
            reason: { type: "string" },
          },
          required: ["shift"],
          additionalProperties: true,
        },
      },
    });

    // Robust parse: tolerant of role-token leaks / prose / fences (see llm-json.ts).
    const parsed: any = extractJsonValue(response, { kind: "object" });
    if (!parsed) {
      throw new Error("No JSON object found in LLM response");
    }
    return {
      shift: Boolean(parsed.shift),
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason) || "",
    };
  } catch (err) {
    console.error(`[BrainRouter] Focus direction shift detection failed:`, (err as Error).message);
    return { shift: false, confidence: 0, reason: "Error" };
  }
}
