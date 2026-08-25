/**
 * ADR-049 S5 / D4 — card generation: the prompt, and the single safe boundary
 * every generated card passes through. Browser-safe + pure (the model call is
 * the host's; this builds the ask and parses the reply).
 *
 * The parse is deliberately the ONE chokepoint for LLM-authored card JSON (the
 * study-side analogue of the memory `extractJsonValue` discipline): fences
 * stripped, one array located, each row validated and bounded, everything else
 * dropped. A malformed reply yields `[]`, never a half-card — and because the
 * output is only ever PROPOSALS a human then accepts (D4), source text can never
 * inject a live card.
 */
import type { StudyCardProposal, StudyProvenance } from "@kinqs/brainrouter-types";

const MAX_CARDS = 50;
const MAX_FRONT = 500;
const MAX_BACK = 1_000;
const MAX_TAGS = 6;

export interface GenerationPrompt {
  system: string;
  user: string;
}

/** A source the "Generate cards" flow can draw from. */
export type StudySourceKind = "text" | "doc" | "decisions" | "atlas";
export interface StudySourceHint { kind: StudySourceKind; label: string; hint: string }

const SOURCE_HINT: Record<StudySourceKind, StudySourceHint> = {
  text: { kind: "text", label: "Paste text", hint: "Any material — notes, an article, a transcript." },
  doc: { kind: "doc", label: "A document", hint: "A Markdown file in this workspace." },
  decisions: { kind: "decisions", label: "A decision (ADR)", hint: "An architecture decision record." },
  atlas: { kind: "atlas", label: "The codebase map", hint: "What the Atlas map knows about this repo." },
};

/**
 * ADR-049 D2 — the sources the Generate flow offers FIRST, ordered by the active
 * workspace's profile. Every source stays reachable from every profile (the
 * order is a lead, not a gate); `text` (paste) is always available.
 */
export function profileGenerationSources(profileId: string): StudySourceHint[] {
  const order: StudySourceKind[] =
    profileId === "engineering" || profileId === "data-science"
      ? ["decisions", "atlas", "doc", "text"]
      : profileId === "research" || profileId === "writing"
        ? ["doc", "text", "decisions"]
        : profileId === "study" || profileId === "education"
          ? ["doc", "text", "decisions"]
          : ["text", "doc", "decisions", "atlas"];
  const all: StudySourceKind[] = ["text", "doc", "decisions", "atlas"];
  const seen = new Set<StudySourceKind>();
  const ordered: StudySourceHint[] = [];
  for (const kind of [...order, ...all]) {
    if (!seen.has(kind)) { seen.add(kind); ordered.push(SOURCE_HINT[kind]); }
  }
  return ordered;
}

/** Build the generation ask over `sourceText`. */
export function buildGenerationPrompt(
  sourceText: string,
  opts: { count?: number; focus?: string } = {},
): GenerationPrompt {
  const count = Math.max(1, Math.min(30, Math.floor(opts.count ?? 12)));
  const system = [
    "You write spaced-repetition flashcards. Return ONLY a JSON array — no prose, no code fence.",
    "Each element is {\"front\": string, \"back\": string, \"tags\": string[]}.",
    "The front is a specific question; the back is the concise answer. One fact per card.",
    "Prefer atomic recall prompts over essays. Do not invent facts not in the source.",
  ].join(" ");
  const focus = opts.focus?.trim() ? `Focus on: ${opts.focus.trim()}. ` : "";
  const user = `${focus}Make up to ${count} flashcards from the material below.\n\n---\n${sourceText.slice(0, 24_000)}`;
  return { system, user };
}

function clampStr(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Locate the first balanced JSON array in `text` (after stripping fences). */
function extractJsonArray(text: string): unknown[] | null {
  const stripped = String(text ?? "")
    .replace(/^\s*```[a-zA-Z]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = stripped.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stripped.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse an LLM reply into bounded, validated card proposals, each stamped with
 * `provenance`. Drops any row without a non-empty front and back; returns `[]`
 * for a malformed reply.
 */
export function parseCardProposals(
  llmText: string,
  provenance?: StudyProvenance,
): StudyCardProposal[] {
  const rows = extractJsonArray(llmText);
  if (!rows) return [];
  const out: StudyCardProposal[] = [];
  for (const row of rows) {
    if (out.length >= MAX_CARDS) break;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const front = clampStr(r.front ?? r.question ?? r.q, MAX_FRONT);
    const back = clampStr(r.back ?? r.answer ?? r.a, MAX_BACK);
    if (!front || !back) continue;
    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, MAX_TAGS)
      : [];
    out.push({ front, back, format: "basic", tags, ...(provenance ? { provenance } : {}) });
  }
  return out;
}
