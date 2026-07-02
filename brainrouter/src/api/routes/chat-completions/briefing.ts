// Request-message parsing + the multi-source memory briefing that gets injected
// at the front of the outbound messages array, plus the memory-status badge.

import { memoryEngine } from "../../../memory/engine.js";
import type { IncomingMessage } from "./types.js";

function flattenContent(content: IncomingMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function buildBriefingMessage(briefing: string, sessionKey: string): IncomingMessage {
  return {
    role: "system",
    content: [
      "## BrainRouter Memory Briefing",
      `Session: ${sessionKey}`,
      "",
      briefing.trim(),
      "",
      "Cite the IDs of records you actually used in your reasoning.",
    ].join("\n"),
  };
}

/**
 * Multi-source briefing. Pull whatever the BrainRouter brain already knows
 * about the authenticated user and stitch it into one compact system message.
 *
 * Sources (each is best-effort; missing sources are silently skipped):
 *   - Core identity / persona (cross-session — this is the big cross-session win)
 *   - Top focus scenes (what the user has been working on lately)
 *   - Cognitive recall against the current query
 *   - Working memory canvas for the current session
 *
 * recall is already user-scoped at the FTS layer, so memories from CLI
 * sessions surface here too — provided extraction has run on those sessions.
 */
async function fetchBriefing(
  userId: string,
  sessionKey: string,
  query: string,
  activeSkill?: string,
): Promise<string> {
  const sections: string[] = [];

  // 1. Persona (cross-session identity).
  try {
    const persona = await memoryEngine.getPersona(userId);
    const personaMd = (persona as any)?.personaMd?.toString().trim();
    if (personaMd) {
      sections.push(`### Who I'm talking to (core identity)\n${personaMd.slice(0, 1600)}`);
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] persona briefing failed:", err);
  }

  // 2. Recent focus scenes.
  try {
    const scenes = await memoryEngine.getTopScenes(userId, 3);
    if (Array.isArray(scenes) && scenes.length > 0) {
      const lines: string[] = ["### Recent focus scenes (what they've been working on)"];
      for (const s of scenes) {
        const heatScore = (s as any).heatScore ?? "";
        const name = (s as any).sceneName ?? "";
        const summary = ((s as any).summary ?? "").toString().replace(/\s+/g, " ").slice(0, 220);
        if (name) lines.push(`- ${name}${heatScore !== "" ? ` · heat ${Number(heatScore).toFixed(2)}` : ""}: ${summary}`);
      }
      if (lines.length > 1) sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] scenes briefing failed:", err);
  }

  // 3. Cognitive recall against the query (FTS + vector + graph).
  const recalledIds = new Set<string>();
  try {
    const recall = await memoryEngine.recall({ userId, sessionKey, query, activeSkill });
    const records =
      (recall as any)?.recalledCognitiveMemories ??
      (recall as any)?.recalledCognitiveRecords ?? // legacy alias for old callers
      [];
    if (Array.isArray(records) && records.length > 0) {
      const lines: string[] = ["### Recalled cognitive memories for this question"];
      for (const r of records.slice(0, 10)) {
        const id = (r.recordId ?? "").toString();
        if (id) recalledIds.add(id);
        const content = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
        lines.push(`- [${id}] (${r.type ?? "memory"}) ${content}`);
      }
      sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] recall briefing failed:", err);
  }

  // 4. Recency-based memories — what we've been doing lately even when the
  //    user's query doesn't share keywords with cognitive content. This is
  //    what makes "what did we talk about last time?" / "remind me about the
  //    previous bug" actually work; FTS alone misses them.
  try {
    const recent: any[] = (await memoryEngine.store.listMemories(userId, { archived: false }, { limit: 8 })) ?? [];
    const deduped = recent.filter((r) => !recalledIds.has((r.recordId ?? "").toString()));
    if (deduped.length > 0) {
      const lines: string[] = ["### Most recent memories (chronological, may or may not match the question)"];
      for (const r of deduped.slice(0, 6)) {
        const id = (r.recordId ?? "").toString();
        const content = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
        const when = (r.createdTime ?? "").toString().slice(0, 10);
        lines.push(`- [${id}] (${r.type ?? "memory"}, ${when}) ${content}`);
      }
      sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] recency briefing failed:", err);
  }

  return sections.join("\n\n");
}

/** Lightweight per-user memory counts for the chat status badge. */
export async function getMemoryStatusForUser(userId: string): Promise<{
  cognitive: number;
  scenes: number;
  hasPersona: boolean;
}> {
  let cognitive = 0;
  let scenes = 0;
  let hasPersona = false;
  try {
    const stats = await memoryEngine.store?.getMemoryStats?.(userId);
    if (stats && typeof stats.total === "number") cognitive = stats.total;
  } catch { /* ignore */ }
  try {
    const list = (await memoryEngine.getTopScenes(userId, 50)) as any[];
    if (Array.isArray(list)) scenes = list.length;
  } catch { /* ignore */ }
  try {
    const p: any = await memoryEngine.getPersona(userId);
    hasPersona = Boolean(p?.personaMd?.trim());
  } catch { /* ignore */ }
  return { cognitive, scenes, hasPersona };
}

function pickLastUserText(messages: IncomingMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return flattenContent(messages[i].content);
    }
  }
  return "";
}

export { flattenContent, buildBriefingMessage, fetchBriefing, pickLastUserText };
