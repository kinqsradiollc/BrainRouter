/**
 * ADR-056 D-B8 — the Review Console filters cards by who produced them: the
 * model lens, or the deterministic static design detector (advisory cards).
 */
export type FindingProducerFilter = "all" | "model" | "design";

export const FINDING_PRODUCER_OPTIONS: Array<{ value: FindingProducerFilter; label: string }> = [
  { value: "model", label: "Model findings" },
  { value: "design", label: "Design (static)" },
];

export function findingProducer(finding: { producer?: string }): "model" | "design" {
  return finding.producer === "design-static" ? "design" : "model";
}

export function filterFindingsByProducer<T extends { producer?: string }>(findings: readonly T[], filter: FindingProducerFilter): T[] {
  if (filter === "all") return [...findings];
  return findings.filter((finding) => findingProducer(finding) === filter);
}

/** Counts per producer, for the control's labels. */
export function countFindingsByProducer(findings: readonly { producer?: string }[]): { model: number; design: number } {
  let model = 0; let design = 0;
  for (const finding of findings) { if (findingProducer(finding) === "design") design += 1; else model += 1; }
  return { model, design };
}
