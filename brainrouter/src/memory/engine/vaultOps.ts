import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { MemoryTreeNode } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { readTreePolicy, treeAutobuildEnabled, topicKeyForScene, SCENE_LEAF_DOMAIN } from "../tree/policy.js";
import { renderRecordMarkdown, renderTreeNodeMarkdown, vaultHash } from "../vault/render.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the scene-tree autobuild + markdown vault
 * export engine operations, extracted verbatim from MemoryEngine as free
 * functions taking the engine instance (type-only import → no runtime cycle).
 * `engine.ts`'s methods are now thin wrappers delegating here. No behavior
 * change.
 */

export async function autobuildSceneTree(engine: MemoryEngine, userId: string): Promise<{ leafed: number; sealableBucket: string[] | null }> {
  if (!treeAutobuildEnabled()) return { leafed: 0, sealableBucket: null };
  const store = engine.store as any;
  if (
    typeof store.getDistinctScenes !== "function" ||
    typeof store.getSceneLeafKeys !== "function" ||
    typeof store.appendTreeNode !== "function" ||
    typeof store.getUnsealedSceneLeaves !== "function"
  ) {
    return { leafed: 0, sealableBucket: null };
  }

  const policy = readTreePolicy();
  const leafedKeys = new Set<string>(await store.getSceneLeafKeys(userId));
  const scenes = (await store.getDistinctScenes(userId)) as Array<{ sceneName: string; recordCount: number }>;
  let leafed = 0;
  for (const sc of scenes) {
    if (leafed >= policy.leafPerPass) break;
    if (!sc.sceneName || sc.recordCount < policy.minSceneRecords || leafedKeys.has(sc.sceneName)) continue;
    const contents = (await store.getSceneRecordContents(userId, sc.sceneName, 8)) as string[];
    const digest = contents.map((c) => `- ${redactSensitiveMemoryText(c).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
    await store.appendTreeNode(userId, {
      kind: SCENE_LEAF_DOMAIN, // MEM-20 — scene leaves are topic-domain
      level: 0,
      summaryMd: `Topic: ${topicKeyForScene(sc.sceneName)} · Scene: ${sc.sceneName} (${sc.recordCount} records)\n${digest}`,
      sceneKey: sc.sceneName,
    });
    leafed++;
  }

  // Eager seal once a full bucket accumulates; otherwise seal a SETTLED bucket
  // (this pass added no new leaf) down to idleSealFloor — so realistic users
  // with only a handful of mature scenes still get their leaves sealed, and
  // tree_sealer + tree_digest actually run instead of waiting forever for a
  // full bucket of `sealThreshold`.
  const fetchLimit = Math.max(policy.sealThreshold, 24);
  const unsealed = (await store.getUnsealedSceneLeaves(userId, fetchLimit)) as Array<{ id: string }>;
  const eager = unsealed.length >= policy.sealThreshold;
  const settled = leafed === 0 && unsealed.length >= policy.idleSealFloor;
  const sealableBucket = eager || settled ? unsealed.map((n) => n.id) : null;
  return { leafed, sealableBucket };
}

export async function exportVault(engine: MemoryEngine, userId: string, baseDir?: string): Promise<{ dir: string; written: number; unchanged: number; total: number }> {
  const store = engine.store as any;
  if (typeof store.upsertVaultExport !== "function" || typeof store.getVaultExports !== "function") {
    return { dir: "", written: 0, unchanged: 0, total: 0 };
  }
  const dir = baseDir ?? path.join(os.homedir(), ".brainrouter", "vault", userId);
  const ledger = new Map<string, string>(((await store.getVaultExports(userId)) as Array<{ path: string; hash: string }>).map((e) => [e.path, e.hash]));
  let written = 0;
  let unchanged = 0;

  const writeIf = async (relPath: string, raw: string, kind: "record" | "tree", refId: string): Promise<void> => {
    const content = redactSensitiveMemoryText(raw);
    const hash = vaultHash(content);
    if (ledger.get(relPath) === hash) { unchanged++; return; }
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    await store.upsertVaultExport(userId, { path: relPath, hash, kind, refId });
    written++;
  };

  for (const rec of await engine.store.listMemories(userId, { archived: false })) {
    await writeIf(`records/${rec.recordId}.md`, renderRecordMarkdown(rec), "record", rec.recordId);
  }
  const nodes: MemoryTreeNode[] = typeof store.getAllTreeNodes === "function" ? await store.getAllTreeNodes(userId) : [];
  for (const node of nodes) {
    await writeIf(`tree/${node.id}.md`, renderTreeNodeMarkdown(node), "tree", node.id);
  }
  return { dir, written, unchanged, total: written + unchanged };
}
