import { z } from "zod";
import { memoryEngine } from "../../../memory/engine.js";

/**
 * ADR-020 D1 — `memory_skill_outcome`: record whether a skill helped on this turn
 * so the memory learns which skills actually work. Each call bumps the skill's
 * usage (and success, when `success=true`); a skill that stays below the
 * reliability floor after enough uses is auto-demoted and stops priming turns.
 * With `list=true` (and no `skillName`) it returns skills ranked by reliability.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memorySkillOutcomeToolSchema = {
  name: "memory_skill_outcome",
  description:
    "Grade a skill's usefulness on the current turn so reliable skills rank up and flaky ones auto-demote (ADR-020 D1). Pass `skillName` + `success` to record an outcome; pass `list: true` to list skills ranked by proven reliability. Returns the updated/ranked reliability records.",
  inputSchema: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "The skill that informed this turn." },
      success: { type: "boolean", description: "Did the skill lead to a good outcome?" },
      list: { type: "boolean", description: "List all skills ranked by reliability instead of recording an outcome." },
    },
  },
} as const;

const schema = z.object({
  skillName: z.string().min(1).optional(),
  success: z.boolean().optional(),
  list: z.boolean().optional(),
});

export async function handleMemorySkillOutcome(args: any) {
  try {
    const params = schema.parse(args ?? {});
    if (params.list || !params.skillName) {
      const skills = await memoryEngine.listSkillReliability();
      return toolResult({ skills });
    }
    const updated = await memoryEngine.recordSkillOutcome(params.skillName, params.success ?? true);
    if (!updated) return toolResult({ recorded: false, reason: "unknown skill", skillName: params.skillName });
    return toolResult({ recorded: true, skill: updated });
  } catch (err) {
    return toolError("memory_skill_outcome", err);
  }
}
