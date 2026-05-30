import { createHash } from "node:crypto";
import type { MemoryListItem, MemoryTreeNode } from "@kinqs/brainrouter-types";

/**
 * 0.4.3 (MEM-7) — pure markdown renderers + content hash for the vault mirror.
 * Deterministic so re-export is idempotent: same record/node → same bytes →
 * same hash → the ledger skips the write.
 */

export function vaultHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function frontmatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}

export function renderRecordMarkdown(rec: MemoryListItem): string {
  return [
    frontmatter({
      id: rec.recordId,
      type: rec.type,
      priority: rec.priority,
      scene: rec.sceneName || "",
      skill: rec.skillTag || "",
      created: rec.createdTime || "",
      citations: rec.citationCount,
    }),
    "",
    rec.content ?? "",
    "",
  ].join("\n");
}

export function renderTreeNodeMarkdown(node: MemoryTreeNode): string {
  return [
    frontmatter({
      id: node.id,
      kind: node.kind,
      level: node.level,
      parent: node.parentId ?? "",
      sealed: node.sealedAt ?? "",
      heat: node.heatScore,
      chunks: node.sourceChunkIds.length,
    }),
    "",
    node.summaryMd ?? "",
    "",
  ].join("\n");
}
