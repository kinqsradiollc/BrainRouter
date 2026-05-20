import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

// ── Schema ────────────────────────────────────────────────────────────────────

export const memoryExplainToolSchema = {
  name: "memory_explain_recall",
  description:
    "Re-run a recall query in explain mode. Returns the full pipeline breakdown: FTS hits, vector hits, " +
    "RRF scores, intent detected, type boosts, skill boost, reranker status, graph expansion, and per-record scores. " +
    "Use this to debug why specific memories did or didn't surface for a query.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The query to explain recall for.",
      },
      userId: {
        type: "string",
        description: "User ID to run explain against. Defaults to the authenticated user.",
      },
      sessionKey: {
        type: "string",
        description: "Session key for the recall context.",
      },
      activeSkill: {
        type: "string",
        description: "Active skill to simulate skill-boost scoring.",
      },
    },
    required: ["query"],
  },
} as const;

const memoryExplainInputSchema = z.object({
  query: z.string().min(1, "Query must not be empty"),
  userId: z.string().optional(),
  sessionKey: z.string().optional(),
  activeSkill: z.string().optional(),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleMemoryExplainRecall(
  args: unknown,
  context: { defaultUserId: string }
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const input = memoryExplainInputSchema.parse(args);
  const userId = input.userId ?? context.defaultUserId;
  const sessionKey = input.sessionKey ?? `explain_${Date.now()}`;

  const result = await memoryEngine.explainRecall({
    userId,
    sessionKey,
    query: input.query,
    activeSkill: input.activeSkill,
  });

  const explanation = result.recallExplanation;

  const lines: string[] = [
    `## Recall Explain: "${input.query}"`,
    "",
    `**Strategy**: ${result.recallStrategy}`,
    `**Duration**: ${explanation?.durationMs ?? 0}ms`,
    `**Intent Detected**: ${explanation?.intentDetected ?? "none"}`,
    "",
    "### Search Hits",
    `- FTS5 hits: ${explanation?.ftsHits ?? 0}`,
    `- Vector hits: ${explanation?.vecHits ?? 0}`,
    `- File-path expansion hits: ${explanation?.filePathHits ?? 0}`,
    `- Top RRF score: ${explanation?.rrfTopScore?.toFixed(4) ?? "n/a"}`,
    "",
    "### Boosting",
    `- Reranker used: ${explanation?.rerankerUsed ? "yes" : "no"} (candidates: ${explanation?.rerankerCandidates ?? 0})`,
    `- Skill boost applied: ${explanation?.skillBoostApplied ? "yes" : "no"}`,
    `- Graph expansion: ${explanation?.graphExpansion ? "yes" : "no"}`,
  ];

  if (explanation?.typeBoosts && Object.keys(explanation.typeBoosts).length > 0) {
    lines.push("", "### Intent Type Boosts");
    for (const [type, boost] of Object.entries(explanation.typeBoosts)) {
      lines.push(`- ${type}: ${boost.toFixed(2)}×`);
    }
  }

  if (explanation?.citationBoosts && Object.keys(explanation.citationBoosts).length > 0) {
    lines.push("", "### Citation Boosts (recordId → boost)");
    for (const [id, boost] of Object.entries(explanation.citationBoosts)) {
      lines.push(`- ${id}: +${(boost * 100).toFixed(0)}%`);
    }
  }

  if (explanation?.scoredRecords && explanation.scoredRecords.length > 0) {
    lines.push("", "### Ranked Results");
    explanation.scoredRecords.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.type}] ${r.recordId} (score: ${r.finalScore.toFixed(4)})`);
    });
  } else {
    lines.push("", "_(No memories matched this query)_");
  }

  if (result.recalledCognitiveMemories && result.recalledCognitiveMemories.length > 0) {
    lines.push("", "### Memory Content Preview");
    result.recalledCognitiveMemories.slice(0, 5).forEach((m: any, i: number) => {
      lines.push(`${i + 1}. **[${m.type}]** ${m.content.slice(0, 120)}${m.content.length > 120 ? "…" : ""}`);
    });
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
