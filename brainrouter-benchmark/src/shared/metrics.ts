export function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (top.has(id)) hits++;
  }
  return hits / relevant.size;
}

export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  let hits = 0;
  for (const id of top) {
    if (relevant.has(id)) hits++;
  }
  return hits / top.length;
}

function dcg(relevances: boolean[], k: number): number {
  let total = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    if (relevances[i]) total += 1 / Math.log2(i + 2);
  }
  return total;
}

export function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const rels = retrieved.slice(0, k).map((id) => relevant.has(id));
  const ideal = Array.from({ length: Math.min(k, relevant.size) }, () => true);
  const idealDcg = dcg(ideal, k);
  return idealDcg === 0 ? 0 : dcg(rels, k) / idealDcg;
}

export function meanReciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : 0;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(100, p));
  const index = Math.ceil((clamped / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
