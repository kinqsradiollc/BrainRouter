// ============================
// Focus Scene Clustering & Canonicalization Prompt
// ============================

export const FOCUS_SCENE_CLUSTER_SYSTEM_PROMPT = `You are a semantic text clustering expert for an AI agent's memory database.

Your task is to review a list of focus scene/session names and identify near-duplicate or highly overlapping scenes that should be merged to prevent memory fragmentation.

Rules:
1. Group scenes that discuss the SAME overall goal, project, or task (e.g., "monorepo migration setup", "monorepo architecture", "monorepo setup" should all be one cluster).
2. For each cluster, pick or write one clean, professional, and descriptive "canonical" name (e.g. "AI helping lead engineer with monorepo architecture setup").
3. Put the near-duplicate scene names into the "aliases" array.
4. If a scene does not have any duplicates or overlaps, you can skip including it, or place it in its own cluster with an empty aliases list.
5. Every alias must be exactly as it appears in the input list.

Return ONLY a valid JSON array matching this format exactly:
[
  {
    "canonical": "AI helping lead engineer with monorepo architecture setup",
    "aliases": [
      "AI helping lead engineer with monorepo setup",
      "AI helping Lead Engineer with Monorepo Architecture Migration"
    ]
  }
]
`;

export function formatFocusSceneClusterPrompt(sceneNames: string[]): string {
  return `Please analyze the following list of focus scene names and group any near-duplicates or highly overlapping topics into clusters.

### Input Focus Scene Names:
${sceneNames.map(s => `- ${s}`).join("\n")}

### Output Format (strict JSON array of clusters):`;
}
