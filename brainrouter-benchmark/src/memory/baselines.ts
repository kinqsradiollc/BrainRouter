import type { BenchmarkQuery, BenchmarkRecord, RankedResult, SystemAdapter } from "../shared/schema.js";

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => token.length > 2);
}

function lexicalScore(query: string, content: string): number {
  return lexicalScoreTerms(tokenize(query), new Set(tokenize(content)));
}

function lexicalScoreTerms(q: string[], c: Set<string>): number {
  if (q.length === 0) return 0;
  return q.reduce((score, token) => score + (c.has(token) ? 1 : 0), 0) / q.length;
}

function deterministicVector(text: string, dims = 64): Float32Array {
  const vec = new Float32Array(dims);
  for (const token of tokenize(text)) {
    let hash = 2166136261;
    for (const ch of token) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    const idx = Math.abs(hash) % dims;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, value) => acc + value * value, 0));
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}

abstract class InMemoryAdapter implements SystemAdapter {
  protected records: BenchmarkRecord[] = [];
  constructor(public id: string, public label: string, public kind: "baseline" = "baseline") {}
  async isAvailable(): Promise<{ available: boolean }> {
    return { available: true };
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    this.records = records;
  }
  abstract query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]>;
}

export class FullDumpAdapter extends InMemoryAdapter {
  private tokenSets = new Map<string, Set<string>>();
  constructor() {
    super("baseline-full-dump", "Full dump");
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    await super.ingest(records);
    this.tokenSets = new Map(records.map((record) => [record.id, new Set(tokenize(record.content))]));
  }
  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const queryTerms = tokenize(query.query);
    return this.records
      .map((record) => ({ recordId: record.id, score: lexicalScoreTerms(queryTerms, this.tokenSets.get(record.id) ?? new Set()), content: record.content, metadata: record.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export class CappedDumpAdapter extends InMemoryAdapter {
  private tokenSets = new Map<string, Set<string>>();
  constructor(private cap = 200) {
    super("baseline-capped-dump", "Capped dump");
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    await super.ingest(records);
    this.tokenSets = new Map(records.slice(0, this.cap).map((record) => [record.id, new Set(tokenize(record.content))]));
  }
  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const queryTerms = tokenize(query.query);
    return this.records
      .slice(0, this.cap)
      .map((record) => ({ recordId: record.id, score: lexicalScoreTerms(queryTerms, this.tokenSets.get(record.id) ?? new Set()), content: record.content, metadata: record.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export class Bm25Adapter extends InMemoryAdapter {
  private docs: Array<{ record: BenchmarkRecord; length: number; termFreq: Map<string, number> }> = [];
  private postings = new Map<string, Array<{ index: number; tf: number }>>();
  private avgLen = 0;
  constructor() {
    super("baseline-bm25", "BM25 baseline");
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    await super.ingest(records);
    this.docs = records.map((record) => {
      const terms = tokenize(record.content);
      const termFreq = new Map<string, number>();
      for (const term of terms) termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      return { record, length: terms.length, termFreq };
    });
    this.avgLen = this.docs.reduce((acc, doc) => acc + doc.length, 0) / Math.max(1, this.docs.length);
    this.postings = new Map();
    this.docs.forEach((doc, index) => {
      for (const [term, tf] of doc.termFreq) {
        const list = this.postings.get(term) ?? [];
        list.push({ index, tf });
        this.postings.set(term, list);
      }
    });
  }
  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const queryTerms = tokenize(query.query);
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Float64Array(this.docs.length);
    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      const df = posting?.length ?? 0;
      if (df === 0) continue;
      const idf = Math.log((this.docs.length - df + 0.5) / (df + 0.5) + 1);
      for (const { index, tf } of posting ?? []) {
        const doc = this.docs[index];
        const denom = tf + k1 * (1 - b + b * (doc.length / Math.max(1, this.avgLen)));
        scores[index] += idf * ((tf * (k1 + 1)) / denom);
      }
    }
    return this.docs
      .map((doc, index) => ({ recordId: doc.record.id, score: scores[index], content: doc.record.content, metadata: doc.record.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export class VectorAdapter extends InMemoryAdapter {
  private vectors = new Map<string, Float32Array>();
  constructor() {
    super("baseline-vector", "Deterministic vector baseline");
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    await super.ingest(records);
    this.vectors = new Map(records.map((record) => [record.id, deterministicVector(record.content)]));
  }
  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const qv = deterministicVector(query.query);
    return this.records
      .map((record) => ({ recordId: record.id, score: cosine(qv, this.vectors.get(record.id) ?? new Float32Array(qv.length)), content: record.content, metadata: record.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export class HybridAdapter extends InMemoryAdapter {
  private bm25 = new Bm25Adapter();
  private vector = new VectorAdapter();
  constructor() {
    super("baseline-hybrid", "Hybrid baseline");
  }
  async ingest(records: BenchmarkRecord[]): Promise<void> {
    await super.ingest(records);
    await this.bm25.ingest(records);
    await this.vector.ingest(records);
  }
  async query(query: BenchmarkQuery, limit: number): Promise<RankedResult[]> {
    const lists = [await this.bm25.query(query, limit * 2), await this.vector.query(query, limit * 2)];
    const scores = new Map<string, number>();
    for (const list of lists) {
      list.forEach((item, index) => scores.set(item.recordId, (scores.get(item.recordId) ?? 0) + 1 / (60 + index + 1)));
    }
    return this.records
      .map((record) => ({ recordId: record.id, score: scores.get(record.id) ?? 0, content: record.content, metadata: record.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export function memoryBaselineAdapters(): SystemAdapter[] {
  return [new FullDumpAdapter(), new CappedDumpAdapter(), new Bm25Adapter(), new VectorAdapter(), new HybridAdapter()];
}
