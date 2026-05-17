import type { L1Record, L2SceneRecord, LLMRunner } from "../types.js";
import { L2_DIRECTION_SHIFT_SYSTEM_PROMPT, formatL2DirectionShiftPrompt } from "../prompts/l2-direction-shift.js";

export async function detectDirectionShift(params: {
  activeScene: L2SceneRecord;
  newL1Records: L1Record[];
  llmRunner: LLMRunner;
}): Promise<{ shift: boolean; confidence: number; reason: string }> {
  const { activeScene, newL1Records, llmRunner } = params;

  try {
    const prompt = formatL2DirectionShiftPrompt(
      activeScene.sceneName,
      activeScene.summaryMd,
      newL1Records.map(r => ({ content: r.content, type: r.type }))
    );

    const response = await llmRunner.run({
      prompt,
      systemPrompt: L2_DIRECTION_SHIFT_SYSTEM_PROMPT,
      taskId: "l2-direction-shift",
      timeoutMs: 30_000,
    });

    const parsed = JSON.parse(response);
    return {
      shift: Boolean(parsed.shift),
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason) || "",
    };
  } catch (err) {
    console.error(`[BrainRouter] L2 direction shift detection failed:`, (err as Error).message);
    return { shift: false, confidence: 0, reason: "Error" };
  }
}
