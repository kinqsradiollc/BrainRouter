import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { splitIdentifier, languageScopeFor, fileExtension, extractChunkQueryTerms, pathPriorPenalty, rankRelatedChunks } from "../memory/code-retrieval.js";
import type { SourceChunk } from "@kinqs/brainrouter-types";

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem29-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Seed a small multi-file code corpus that shares the `parseConfig` symbol. */
function seed(store: SqliteMemoryStore) {
  const parser = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/parser.ts", hash: "h1", title: "parser.ts" });
  const parserChunks = store.addSourceChunks(parser.id, [
    { content: "export function parseConfig(raw: string) { return JSON.parse(raw); }", tokenCount: 12, filePath: "src/parser.ts", symbol: "parseConfig", startLine: 1, endLine: 3 },
    { content: "export function parseArgs(argv) { /* parse argv tokens */ }", tokenCount: 10, filePath: "src/parser.ts", symbol: "parseArgs", startLine: 5, endLine: 7 },
  ]);
  const config = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/config.ts", hash: "h2", title: "config.ts" });
  const configChunks = store.addSourceChunks(config.id, [
    { content: "import { parseConfig } from './parser'; const cfg = parseConfig(text); return cfg;", tokenCount: 14, filePath: "src/config.ts", symbol: "loadConfig", startLine: 1, endLine: 4 },
  ]);
  const py = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/util.py", hash: "h3", title: "util.py" });
  const pyChunks = store.addSourceChunks(py.id, [
    { content: "def parse_config(raw): return json.loads(raw)", tokenCount: 8, filePath: "src/util.py", symbol: "parse_config", startLine: 1, endLine: 2 },
  ]);
  const other = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/ui.ts", hash: "h4", title: "ui.ts" });
  store.addSourceChunks(other.id, [
    { content: "export function renderButton(props) { return makeElement('button', props); }", tokenCount: 10, filePath: "src/ui.ts", symbol: "renderButton", startLine: 1, endLine: 3 },
  ]);
  return { seedChunkId: parserChunks[0].id, parserChunks, configChunks, pyChunks };
}

test("MEM-29 find_related: by chunkId surfaces cross-file matches, excludes the seed + other languages", () => {
  const { store, cleanup } = fresh("by-id");
  try {
    const { seedChunkId } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.findRelatedChunks("u1", { chunkId: seedChunkId });
    assert.equal(r.found, true);
    assert.equal(r.seed?.symbol, "parseConfig");
    const paths = r.related.map((x) => x.chunk.filePath);
    assert.ok(r.related.length >= 1, "at least one related chunk");
    assert.ok(paths.includes("src/config.ts"), "config.ts (uses parseConfig) is related");
    assert.ok(r.related.every((x) => x.chunk.id !== seedChunkId), "seed chunk excluded");
    assert.ok(!paths.includes("src/util.py"), "other-language chunk excluded by default language scope");
    assert.ok(!paths.includes("src/ui.ts"), "unrelated chunk not matched");
    // scores normalized 0..1, descending
    for (let i = 1; i < r.related.length; i++) assert.ok(r.related[i - 1].score >= r.related[i].score);
    assert.ok(r.related.every((x) => x.score >= 0 && x.score <= 1));
  } finally { cleanup(); }
});

test("MEM-29 find_related: file:line seed resolves the covering chunk", () => {
  const { store, cleanup } = fresh("by-line");
  try {
    const { seedChunkId } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.findRelatedChunks("u1", { filePath: "src/parser.ts", line: 2 });
    assert.equal(r.found, true);
    assert.equal(r.seed?.chunkId, seedChunkId, "line 2 falls inside the parseConfig chunk (1-3)");
  } finally { cleanup(); }
});

test("MEM-29 find_related: sameLanguage:false admits other-language neighbours", () => {
  const { store, cleanup } = fresh("cross-lang");
  try {
    const { seedChunkId } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.findRelatedChunks("u1", { chunkId: seedChunkId }, { sameLanguage: false });
    assert.equal(r.found, true);
    assert.ok(r.related.some((x) => x.chunk.filePath === "src/util.py"), "python parse_config now included");
  } finally { cleanup(); }
});

test("MEM-29 find_related: ownership gate — another user cannot seed from u1's chunk", () => {
  const { store, cleanup } = fresh("owner");
  try {
    const { seedChunkId } = seed(store);
    const engine = new MemoryEngine(store);
    const r = engine.findRelatedChunks("intruder", { chunkId: seedChunkId });
    assert.equal(r.found, false);
    assert.deepEqual(r.related, []);
  } finally { cleanup(); }
});

test("MEM-29 find_related: unknown seed → found:false", () => {
  const { store, cleanup } = fresh("missing");
  try {
    seed(store);
    const engine = new MemoryEngine(store);
    assert.equal(engine.findRelatedChunks("u1", { chunkId: "nope" }).found, false);
  } finally { cleanup(); }
});

function chunk(over: Partial<SourceChunk> & { id: string; ftsRank: number }): SourceChunk & { ftsRank: number } {
  return {
    documentId: "d", ordinal: 0, content: "x", tokenCount: 1, filePath: null, symbol: null,
    startLine: null, endLine: null, hash: "h", ...over,
  };
}

test("MEM-27 pathPriorPenalty: vendored/generated/test/.d.ts/barrel down-ranked, real source unpenalized", () => {
  assert.equal(pathPriorPenalty("src/parser.ts").multiplier, 1);
  assert.equal(pathPriorPenalty("src/parser.ts").tag, null);
  assert.ok(pathPriorPenalty("node_modules/lib/x.js").multiplier <= 0.2);
  assert.equal(pathPriorPenalty("dist/bundle.js").tag, "build-output");
  assert.equal(pathPriorPenalty("src/api.generated.ts").tag, "generated");
  assert.equal(pathPriorPenalty("src/types.d.ts").tag, "type-decl");
  assert.equal(pathPriorPenalty("src/parser.test.ts").tag, "test");
  assert.equal(pathPriorPenalty("src/__tests__/x.ts").tag, "test");
  // barrel is content-aware: an index.* of pure re-exports
  assert.equal(pathPriorPenalty("src/index.ts", "export * from './a';\nexport { b } from './b';").tag, "barrel");
  // an index.* with real code is NOT a barrel
  assert.equal(pathPriorPenalty("src/index.ts", "function main(){ run(); }\nmain();").tag, null);
});

test("MEM-27 rankRelatedChunks: a real-source hit outranks a stronger test/.d.ts hit", () => {
  const hits = [
    chunk({ id: "t", filePath: "src/parser.test.ts", content: "parseConfig test", ftsRank: -5 }), // stronger lexical
    chunk({ id: "s", filePath: "src/parser.ts", content: "parseConfig impl", ftsRank: -3 }),       // weaker lexical
  ];
  const ranked = rankRelatedChunks({ symbol: "parseConfig" }, hits, 10);
  assert.equal(ranked[0].chunk.id, "s", "real source beats the test despite a stronger raw match");
  assert.ok(ranked.find((r) => r.chunk.id === "t")!.reason.includes("-test"));
});

test("MEM-27 per-file saturation: one file cannot dominate the top-k", () => {
  const hits = [
    chunk({ id: "a1", filePath: "src/big.ts", content: "x", ftsRank: -9 }),
    chunk({ id: "a2", filePath: "src/big.ts", content: "x", ftsRank: -8 }),
    chunk({ id: "a3", filePath: "src/big.ts", content: "x", ftsRank: -7 }),
    chunk({ id: "b1", filePath: "src/other.ts", content: "x", ftsRank: -1 }),
  ];
  const ranked = rankRelatedChunks({}, hits, 3, { maxPerFile: 2 });
  const fromBig = ranked.filter((r) => r.chunk.filePath === "src/big.ts").length;
  assert.equal(fromBig, 2, "big.ts capped at 2");
  assert.ok(ranked.some((r) => r.chunk.filePath === "src/other.ts"), "other.ts gets a slot");
});

test("MEM-29 helpers: splitIdentifier / fileExtension / languageScopeFor / extractChunkQueryTerms", () => {
  assert.deepEqual(splitIdentifier("getUserName"), ["get", "User", "Name"]);
  assert.deepEqual(splitIdentifier("parse_config_file"), ["parse", "file"]); // 'config' is boilerplate
  assert.equal(fileExtension("src/a/b.test.ts"), ".ts");
  assert.equal(fileExtension("Makefile"), "");
  assert.ok(languageScopeFor("src/a.ts").includes(".tsx"));
  assert.deepEqual(languageScopeFor("Makefile"), []);
  const terms = extractChunkQueryTerms({ symbol: "parseConfig", content: "function parseConfig(raw){ return JSON.parse(raw); }" });
  assert.ok(terms.includes("parseConfig"));
  assert.ok(terms.toLowerCase().includes("raw"));
});
