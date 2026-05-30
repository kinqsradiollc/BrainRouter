/**
 * 0.4.3 (MEM-10) — tree_digest: LLM re-summary for memory-tree parents.
 *
 * tree_sealer creates a parent with a DETERMINISTIC digest (concatenated child
 * summaries). tree_digest refines that into a real summary via the synthesis
 * LLM. Mirrors the identity/focus distillers: a synthesis function over
 * { store, llmRunner }, gracefully degrading when no LLM is configured (it keeps
 * the deterministic summary rather than blanking it).
 */

import type { IMemoryStore, LLMRunner } from "@kinqs/brainrouter-types";
import { redactSensitiveMemoryText } from "../redaction.js";

const TREE_DIGEST_SYSTEM =
  "You are a memory summarizer. Given several child memory-note summaries, write ONE concise parent summary that captures their shared themes and the most important specifics. Output only the summary prose — no preamble, no bullet headers, no markdown headings. Keep it under 120 words.";

/** Minimal tree surface the digest needs (capability-detected on the store). */
interface TreeDigestStore {
  getTreeNode(id: string): { id: string; userId: string; summaryMd: string } | null;
  getTreeChildren(parentId: string): Array<{ summaryMd: string }>;
  updateTreeNodeSummary(id: string, summaryMd: string): void;
}

/**
 * Re-summarize each parent node from its children with the LLM. Returns the ids
 * that were re-summarized and how many were skipped (ownership mismatch, no
 * children, empty LLM output, or LLM unconfigured/timeout — in which case the
 * deterministic summary is left intact).
 */
export async function digestTreeNodes(params: {
  userId: string;
  nodeIds: string[];
  store: IMemoryStore;
  llmRunner: LLMRunner;
}): Promise<{ summarized: string[]; skipped: number }> {
  const store = params.store as unknown as TreeDigestStore & Record<string, unknown>;
  if (
    typeof store.getTreeNode !== "function" ||
    typeof store.getTreeChildren !== "function" ||
    typeof store.updateTreeNodeSummary !== "function"
  ) {
    return { summarized: [], skipped: params.nodeIds.length };
  }

  const summarized: string[] = [];
  let skipped = 0;
  for (const nodeId of params.nodeIds) {
    const node = store.getTreeNode(nodeId);
    if (!node || node.userId !== params.userId) { skipped++; continue; } // ownership (MEM-14)
    const children = store.getTreeChildren(nodeId);
    if (children.length === 0) { skipped++; continue; }

    const childText = children
      .map((c, i) => `${i + 1}. ${(c.summaryMd ?? "").replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n");
    try {
      const out = await params.llmRunner.run({
        taskId: "tree-digest",
        systemPrompt: TREE_DIGEST_SYSTEM,
        prompt: `Summarize these ${children.length} child memory summaries into ONE concise parent summary:\n\n${childText}`,
        timeoutMs: 90_000,
      });
      const clean = redactSensitiveMemoryText((out ?? "").trim());
      if (clean) {
        store.updateTreeNodeSummary(nodeId, clean);
        summarized.push(nodeId);
      } else {
        skipped++; // empty LLM output → keep the deterministic summary
      }
    } catch {
      skipped++; // LLM unconfigured / timeout / error → keep the deterministic summary
    }
  }
  return { summarized, skipped };
}
