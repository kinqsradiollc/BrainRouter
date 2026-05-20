import type { CognitiveRecord, ContextualFocusRecord, LLMRunner } from "@brainrouter/types";
import { FOCUS_DIRECTION_SHIFT_SYSTEM_PROMPT, formatFocusDirectionShiftPrompt } from "../prompts/focus-direction-shift.js";

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
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in LLM response");
    }
    const parsed = JSON.parse(jsonMatch[0]);
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
