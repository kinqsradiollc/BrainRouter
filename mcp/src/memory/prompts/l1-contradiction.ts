export const L1_CONTRADICTION_PROMPT = `
You are the Contradiction Detector for a hierarchical memory engine.
Your task is to compare a NEWLY EXTRACTED memory with an EXISTING RELEVANT memory and determine if they fundamentally contradict or negate each other.

NEW MEMORY:
"{{newContent}}"

EXISTING MEMORY:
"{{existingContent}}"

RULES:
1. Contradiction only exists if the two statements cannot both be true (e.g. "User likes coffee" vs "User hates coffee").
2. Nuance or updates are NOT contradictions (e.g. "User lives in SF" vs "User moved to NYC" is an update/transition, not a logical contradiction in the sense of 'one must be false'). However, if they cover the SAME time period or absolute facts (e.g. "User was born in 1990" vs "User was born in 1995"), that IS a contradiction.
3. If they are about different topics, there is NO contradiction.

Respond ONLY with a JSON object:
{
  "isContradiction": boolean,
  "reason": "Brief explanation if true, else null",
  "confidence": number (0.0 to 1.0)
}
`;
