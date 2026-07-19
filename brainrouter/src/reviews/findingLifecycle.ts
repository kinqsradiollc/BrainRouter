import { createHash } from "node:crypto";

export type LifecycleStatus = "open" | "fixed" | "ignored" | "in progress" | "snoozed";

export interface LifecycleFindingInput {
  file: string;
  line?: number;
  endLine?: number;
  severity: string;
  title: string;
  cwe?: string;
  preExisting?: boolean;
  suggestable?: boolean;
}

export interface LifecycleCurrentFinding {
  id: string;
  fingerprint: string;
  file: string;
  title: string;
  cwe?: string;
  status: LifecycleStatus;
}

export interface NormalizedLifecycleFinding extends LifecycleFindingInput {
  file: string;
  severity: string;
  title: string;
  cwe?: string;
  fingerprint: string;
}

export type LifecycleTransitionType = "discovered" | "observed" | "fixed" | "reopened";

export interface LifecycleTransition {
  type: LifecycleTransitionType;
  findingId: string | null;
  fingerprint: string;
  finding?: NormalizedLifecycleFinding;
}

export interface ReconcileFindingLifecycleInput {
  lens: string;
  previous: LifecycleCurrentFinding[];
  incoming: LifecycleFindingInput[];
  complete: boolean;
}

const AUTO_FIXABLE = new Set<LifecycleStatus>(["open", "in progress", "snoozed"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could", "for", "from",
  "in", "into", "is", "it", "may", "might", "of", "on", "or", "that", "the", "this", "to", "was", "were",
  "will", "with", "without",
]);

function normalizeFile(file: string): string {
  return String(file ?? "").trim().replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
}

function normalizeCwe(cwe: string | undefined, title: string): string | undefined {
  const value = String(cwe ?? /\bCWE-\d+\b/i.exec(title)?.[0] ?? "").trim().toUpperCase();
  if (!value) return undefined;
  const digits = /\d+/.exec(value)?.[0];
  return digits ? `CWE-${digits}` : undefined;
}

function rootCauseTokens(title: string): string[] {
  const normalized = String(title ?? "")
    .toLowerCase()
    .replace(/\bcwe-\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [...new Set(normalized.split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)))].sort();
}

function rootCause(title: string): string {
  return rootCauseTokens(title).join(" ");
}

function similarity(left: string, right: string): number {
  const a = new Set(rootCauseTokens(left));
  const b = new Set(rootCauseTokens(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function findingFingerprint(lens: string, finding: LifecycleFindingInput): string {
  const canonical = [
    String(lens ?? "").trim().toLowerCase(),
    normalizeFile(finding.file),
    normalizeCwe(finding.cwe, finding.title) ?? "",
    rootCause(finding.title),
  ].join("\0");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function normalizeFinding(lens: string, finding: LifecycleFindingInput): NormalizedLifecycleFinding {
  const file = String(finding.file ?? "").trim().replace(/^\.\//, "").replace(/\\/g, "/");
  const title = String(finding.title ?? "").trim();
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? Number(finding.line) : undefined;
  const endLine = Number.isInteger(finding.endLine) && Number(finding.endLine) >= (line ?? 1) ? Number(finding.endLine) : undefined;
  const cwe = normalizeCwe(finding.cwe, title);
  const normalized: LifecycleFindingInput = {
    file,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    severity: String(finding.severity ?? "info").trim().toLowerCase() || "info",
    title,
    ...(cwe ? { cwe } : {}),
    ...(finding.preExisting ? { preExisting: true } : {}),
    ...(finding.suggestable ? { suggestable: true } : {}),
  };
  return { ...normalized, fingerprint: findingFingerprint(lens, normalized) };
}

function fallbackMatch(
  finding: NormalizedLifecycleFinding,
  previous: LifecycleCurrentFinding[],
  used: Set<string>,
): LifecycleCurrentFinding | undefined {
  const candidates = previous
    .filter((item) => !used.has(item.id) && normalizeFile(item.file) === normalizeFile(finding.file))
    .map((item) => {
      const previousCwe = normalizeCwe(item.cwe, item.title);
      const sameCwe = Boolean(finding.cwe && previousCwe && finding.cwe === previousCwe);
      if (finding.cwe && previousCwe && !sameCwe) return { item, score: -1 };
      const lexical = similarity(item.title, finding.title);
      return { item, score: lexical + (sameCwe ? 0.25 : 0) };
    })
    .filter(({ score }) => score >= (finding.cwe ? 0.6 : 0.72))
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));
  if (!candidates.length) return undefined;
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return undefined;
  return candidates[0]!.item;
}

export function reconcileFindingLifecycle(input: ReconcileFindingLifecycleInput): { transitions: LifecycleTransition[] } {
  const previous = input.previous ?? [];
  const byFingerprint = new Map<string, LifecycleCurrentFinding[]>();
  for (const item of previous) {
    const bucket = byFingerprint.get(item.fingerprint) ?? [];
    bucket.push(item);
    byFingerprint.set(item.fingerprint, bucket);
  }

  const used = new Set<string>();
  const seenIncoming = new Set<string>();
  const transitions: LifecycleTransition[] = [];
  for (const raw of input.incoming ?? []) {
    const finding = normalizeFinding(input.lens, raw);
    if (!finding.file || !finding.title || seenIncoming.has(finding.fingerprint)) continue;
    seenIncoming.add(finding.fingerprint);
    const exact = (byFingerprint.get(finding.fingerprint) ?? []).find((item) => !used.has(item.id));
    const match = exact ?? fallbackMatch(finding, previous, used);
    if (!match) {
      transitions.push({ type: "discovered", findingId: null, fingerprint: finding.fingerprint, finding });
      continue;
    }
    used.add(match.id);
    transitions.push({
      type: match.status === "fixed" ? "reopened" : "observed",
      findingId: match.id,
      fingerprint: finding.fingerprint,
      finding,
    });
  }

  if (input.complete) {
    for (const item of previous) {
      if (!used.has(item.id) && AUTO_FIXABLE.has(item.status)) {
        transitions.push({ type: "fixed", findingId: item.id, fingerprint: item.fingerprint });
      }
    }
  }
  return { transitions };
}
