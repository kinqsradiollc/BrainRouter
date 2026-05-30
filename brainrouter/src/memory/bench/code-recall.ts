/**
 * MEM-25 (0.4.4) — code-recall benchmark: a publishable metric for the code
 * chunker (MEM-18 structural + MEM-24 AST adapter), closing the codegraph/Semble
 * "no code-recall numbers" gap.
 *
 * Self-retrieval is the right shape for cognitive records, but code quality is
 * about whether the chunker ISOLATES the right symbols. So this measures, over a
 * set of code samples with known top-level symbols, the fraction that the chunker
 * surfaces as their own labelled chunk (symbol recall) plus how cleanly it does
 * it (chunks per isolated symbol — 1.0 is ideal; higher means over-splitting).
 *
 * Pure: chunk + count, no store / LLM / network. The engine wraps it to write a
 * numbers file; the bench runner publishes it.
 */
import { chunkCode } from "../source/code-chunker.js";

export interface CodeChunkSample {
  language: string;
  code: string;
  /** Known top-level symbols the chunker should isolate. */
  expectedSymbols: string[];
}

export interface CodeRecallResult {
  samples: number;
  expectedSymbols: number;
  isolatedSymbols: number;
  /** isolatedSymbols / expectedSymbols — the headline code-recall number. */
  symbolRecall: number;
  /** Labelled chunks per isolated symbol (1.0 ideal; >1 = over-splitting). */
  chunksPerSymbol: number;
}

/** Strip the `#n` part suffix the chunker adds to a sub-split oversized symbol. */
function baseSymbol(symbol: string | null | undefined): string {
  return (symbol ?? "").replace(/#\d+$/, "");
}

export function benchmarkCodeChunking(samples: CodeChunkSample[]): CodeRecallResult {
  let expected = 0;
  let isolated = 0;
  let labelledChunks = 0;
  for (const s of samples) {
    const chunks = chunkCode(s.code, { language: s.language });
    const labels = new Set(chunks.map((c) => baseSymbol(c.symbol)).filter(Boolean));
    labelledChunks += chunks.filter((c) => c.symbol).length;
    for (const sym of s.expectedSymbols) {
      expected++;
      if (labels.has(sym)) isolated++;
    }
  }
  return {
    samples: samples.length,
    expectedSymbols: expected,
    isolatedSymbols: isolated,
    symbolRecall: expected ? isolated / expected : 0,
    chunksPerSymbol: isolated ? labelledChunks / isolated : 0,
  };
}

/** Built-in fixtures (TS / Python / Rust) for a default code-recall run. */
export const DEFAULT_CODE_SAMPLES: CodeChunkSample[] = [
  {
    language: "ts",
    expectedSymbols: ["add", "Calc", "sub", "Shape"],
    code: [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export class Calc {",
      "  mul(a: number, b: number) { return a * b; }",
      "}",
      "export const sub = (a: number, b: number): number => a - b;",
      "export interface Shape { kind: string; area(): number; }",
    ].join("\n"),
  },
  {
    language: "python",
    expectedSymbols: ["normalize", "Pipeline"],
    code: [
      "def normalize(text):",
      "    return text.strip().lower()",
      "",
      "class Pipeline:",
      "    def run(self, items):",
      "        return [normalize(i) for i in items]",
    ].join("\n"),
  },
  {
    language: "rs",
    expectedSymbols: ["run", "Store"],
    code: [
      "pub fn run() -> i32 {",
      "    0",
      "}",
      "pub struct Store {",
      "    size: usize,",
      "}",
      "impl Store {",
      "    fn len(&self) -> usize { self.size }",
      "}",
    ].join("\n"),
  },
];

/** Markdown one-liner for the published numbers file. */
export function formatCodeRecallMd(r: CodeRecallResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    "# Code-recall benchmark (chunk symbol isolation)",
    "",
    `- samples: ${r.samples}`,
    `- expected symbols: ${r.expectedSymbols}`,
    `- isolated: ${r.isolatedSymbols} (**symbol recall ${pct(r.symbolRecall)}**)`,
    `- chunks per isolated symbol: ${r.chunksPerSymbol.toFixed(2)} (1.0 ideal)`,
    "",
  ].join("\n");
}
