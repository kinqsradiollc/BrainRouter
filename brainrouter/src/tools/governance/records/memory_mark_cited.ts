import { z } from "zod";
import { memoryEngine } from "../../../memory/engine.js";
import { isLearnedMemoryResult } from "./memory-governance.js";

export const memoryMarkCitedToolSchema = {
  name: "memory_mark_cited",
  description:
    "Signal that specific recalled memories were used in the agent response. " +
    "Pass all recalled record IDs (from the previous recall result) alongside the cited subset. " +
    "Non-cited recalled memories accumulate a 'never_cited_count' signal that drives auto-archive. " +
    "Call this once per turn, after your response is generated.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User identifier for isolation.",
      },
      citedRecordIds: {
        type: "array",
        items: { type: "string" },
        description:
          "IDs of memories you actually referenced in your response. " +
          "Pass an empty array if no memories were used (all recalled IDs will have never_cited_count incremented).",
      },
      allRecalledRecordIds: {
        type: "array",
        items: { type: "string" },
        description:
          "All record IDs that were returned in the previous memory_recall result " +
          "(recalledCognitiveMemories[].recordId). This is the full set that was surfaced to you.",
      },
    },
    required: ["citedRecordIds", "allRecalledRecordIds"],
  },
} as const;

const memoryMarkCitedSchema = z.object({
  userId: z.string().optional(),
  citedRecordIds: z.array(z.string()),
  allRecalledRecordIds: z.array(z.string()),
});

export async function handleMemoryMarkCited(args: unknown, options?: { defaultUserId?: string }) {
  const params = memoryMarkCitedSchema.parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    // Citation accounting can eventually auto-archive a record. Classify every
    // supplied id through the owner-scoped record read and fail closed when the
    // record cannot be classified; learned lifecycle has its own org-scoped
    // counters and must never be mutated through this model-visible tool.
    const requestedIds = [...new Set([
      ...params.citedRecordIds,
      ...params.allRecalledRecordIds,
    ])];
    const allowed = new Set<string>();
    await Promise.all(requestedIds.map(async (recordId) => {
      try {
        const record = await memoryEngine.getMemoryById(effectiveUserId, recordId);
        if (!isLearnedMemoryResult(record)) allowed.add(recordId);
      } catch {
        // Unknown authority is not permission to mutate citation state.
      }
    }));
    const citedRecordIds = params.citedRecordIds.filter((recordId) => allowed.has(recordId));
    const allRecalledRecordIds = params.allRecalledRecordIds.filter((recordId) => allowed.has(recordId));
    const result = await memoryEngine.markCited(
      effectiveUserId,
      citedRecordIds,
      allRecalledRecordIds,
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            ...result,
            message: `Marked ${result.cited} memories as cited. Incremented never_cited_count for ${result.nonCited} non-cited memories.${
              result.archiveThreshold > 0
                ? ` Auto-archive threshold: ${result.archiveThreshold}.`
                : " Auto-archive disabled (BRAINROUTER_ACE_ARCHIVE_THRESHOLD=0)."
            }`,
          }, null, 2),
        },
      ],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `memory_mark_cited failed: ${err.message}` }],
    };
  }
}
