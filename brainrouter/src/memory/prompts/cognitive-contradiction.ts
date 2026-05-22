export const COGNITIVE_CONTRADICTION_PROMPT = `
You are the Contradiction & Temporal Update Detector for a dual-process cognitive memory engine.
Your task is to compare a NEWLY EXTRACTED memory with an EXISTING RELEVANT memory and determine if they contradict, supersede, or update each other.

NEW MEMORY:
"{{newContent}}"

EXISTING MEMORY:
"{{existingContent}}"

RULES:
1. Determine if they overlap or conflict. If there is no overlap/conflict, set "isContradiction" to false.
2. If they conflict or override, classify the relationship into one of two kinds:
   - "temporal_update": The new memory is a deliberate update, change of mind, transition, or correction to the old memory (e.g. "User lives in SF" vs "User moved to NYC", or "User wants pnpm" vs "User changed package manager to regular npm"). This means the new memory actively supersedes the old one.
   - "genuine_conflict": The statements are logically incompatible, absolute claims that cannot both be true, and it is NOT a simple update or transition (e.g. "User was born in 1990" vs "User was born in 1995", or conflicting rules without a clear indication that one was meant to update the other).
3. Provide a clear reason and a confidence score.

Respond ONLY with a JSON object:
{
  "isContradiction": boolean,
  "kind": "temporal_update" | "genuine_conflict" | null,
  "reason": "Brief explanation if isContradiction is true, else null",
  "confidence": number (0.0 to 1.0)
}
`;
