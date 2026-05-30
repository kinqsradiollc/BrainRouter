import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-4 (0.4.3) — `memory_blackboard_review`: the staging area between
 * extraction and long-term memory. Extracted candidates are staged, reconciled
 * (dedup / score / threshold), then committed to cognitive records with an
 * audit trail — or rejected. One tool drives the whole review workflow:
 *
 *   • (no action) → list staged items, optionally filtered by status
 *   • action "stage"     → stage new candidate(s)
 *   • action "reconcile" → dedup/score all pending items
 *   • action "commit"    → promote a reconciled item to a cognitive record
 *   • action "reject"    → drop an item
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

const STATUSES = ["pending", "reconciled", "duplicate", "committed", "rejected"] as const;

export const memoryBlackboardReviewToolSchema = {
  name: "memory_blackboard_review",
  description:
    "Review and drive the memory blackboard: list staged candidates (optionally by status), or run an action — stage new candidates, reconcile (dedup/score) pending ones, commit a reconciled item to a cognitive record (with audit), or reject one. Keeps low-quality extraction out of long-term memory until reviewed.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      action: { type: "string", enum: ["stage", "reconcile", "commit", "reject"], description: "Omit to just list." },
      status: { type: "string", enum: STATUSES as unknown as string[], description: "Filter the listing by status." },
      itemId: { type: "string", description: "Target item for commit/reject." },
      items: {
        type: "array",
        description: "Candidates to stage (action=stage).",
        items: {
          type: "object",
          properties: {
            sourceChunkId: { type: "string" },
            score: { type: "number" },
            candidate: {
              type: "object",
              properties: {
                content: { type: "string" },
                type: { type: "string" },
                priority: { type: "number" },
                sceneName: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["content", "type"],
            },
          },
          required: ["candidate"],
        },
      },
    },
  },
} as const;

const candidateSchema = z.object({
  content: z.string().min(1),
  type: z.string().min(1),
  priority: z.number().optional(),
  sceneName: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const schema = z.object({
  userId: z.string().optional(),
  action: z.enum(["stage", "reconcile", "commit", "reject"]).optional(),
  status: z.enum(STATUSES).optional(),
  itemId: z.string().optional(),
  items: z.array(z.object({ sourceChunkId: z.string().optional(), score: z.number().optional(), candidate: candidateSchema })).optional(),
});

export async function handleMemoryBlackboardReview(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";

    switch (params.action) {
      case "stage": {
        const staged = memoryEngine.stageBlackboardCandidates(userId, (params.items ?? []).map((i) => ({
          sourceChunkId: i.sourceChunkId ?? null,
          score: i.score,
          candidate: i.candidate as any,
        })));
        return toolResult({ staged: staged.length, items: staged });
      }
      case "reconcile":
        return toolResult(memoryEngine.reconcilePendingBlackboard(userId));
      case "commit": {
        if (!params.itemId) throw new Error("itemId is required for commit");
        return toolResult(memoryEngine.commitBlackboardItem(userId, params.itemId));
      }
      case "reject": {
        if (!params.itemId) throw new Error("itemId is required for reject");
        return toolResult({ rejected: memoryEngine.rejectBlackboardItem(userId, params.itemId) });
      }
      default:
        return toolResult({ items: memoryEngine.reviewBlackboard(userId, params.status) });
    }
  } catch (err) {
    return toolError("memory_blackboard_review", err);
  }
}
