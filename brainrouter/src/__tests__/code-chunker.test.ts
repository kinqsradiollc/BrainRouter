import { describe, it, expect } from "vitest";
import { chunkCode, languageFromPath } from "../memory/source/code-chunker.js";

describe("chunkCode (MEM-6)", () => {
  it("splits TS at top-level symbols, with imports as a preamble chunk", () => {
    const src = [
      "import x from 'y';", // 1
      "",                    // 2
      "export function alpha() {", // 3
      "  return 1;",         // 4
      "}",                   // 5
      "",                    // 6
      "class Beta {",        // 7
      "  m() { return 2; }", // 8  (indented → not a boundary)
      "}",                   // 9
    ].join("\n");
    const chunks = chunkCode(src, { language: "ts", filePath: "a.ts" });
    expect(chunks.map((c) => c.symbol)).toEqual([null, "alpha", "Beta"]);
    expect(chunks.every((c) => c.filePath === "a.ts")).toBe(true);
    // MEM-18: alpha ends at its closing brace (line 5), not the trailing blank
    // (the inter-symbol blank is dropped rather than absorbed). Beta 7..9.
    expect({ s: chunks[1].startLine, e: chunks[1].endLine }).toEqual({ s: 3, e: 5 });
    expect({ s: chunks[2].startLine, e: chunks[2].endLine }).toEqual({ s: 7, e: 9 });
  });

  it("a file starting with a symbol has no preamble chunk", () => {
    const chunks = chunkCode("export const f = () => {\n  return 1;\n};\n", { language: "ts" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBe("f");
    expect(chunks[0].startLine).toBe(1);
  });

  it("Python: top-level def/class only — nested defs stay in the parent", () => {
    const src = [
      "def outer():",       // 1
      "    def inner():",   // 2 (indented)
      "        pass",       // 3
      "    return inner",   // 4
      "class C:",           // 5
      "    def method(self):", // 6 (indented)
      "        return 1",   // 7
    ].join("\n");
    const chunks = chunkCode(src, { language: "python" });
    expect(chunks.map((c) => c.symbol)).toEqual(["outer", "C"]);
    expect(chunks[0].endLine).toBe(4); // inner folded into outer
  });

  it("Rust: fn / struct / impl boundaries", () => {
    const src = [
      "pub fn run() {",     // 1
      "    0",              // 2
      "}",                  // 3
      "struct S {",         // 4
      "    x: i32,",        // 5
      "}",                  // 6
      "impl S {",           // 7
      "    fn n(&self) {}", // 8
      "}",                  // 9
    ].join("\n");
    expect(chunkCode(src, { language: "rs" }).map((c) => c.symbol)).toEqual(["run", "S", "S"]);
  });

  it("falls back to line-based chunking when no symbols are recognised", () => {
    const chunks = chunkCode("just\nsome\nprose\n", { language: "ts", filePath: "notes.txt" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBeUndefined(); // chunkSource sets no symbol
    expect(chunks[0].filePath).toBe("notes.txt");
  });

  it("sub-splits an oversized symbol, keeping the name with a #n part suffix", () => {
    const src = ["function huge() {", "  aaaa", "  bbbb", "  cccc", "}"].join("\n");
    const chunks = chunkCode(src, { language: "ts", maxTokens: 2 }); // tiny budget forces a split
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => /^huge#\d+$/.test(c.symbol ?? ""))).toBe(true);
    expect(chunks[0].startLine).toBe(1); // line numbers stay anchored to the file
    // strictly increasing, within the symbol's 1..5 line span
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine!).toBeGreaterThanOrEqual(chunks[i - 1].startLine!);
      expect(chunks[i].endLine!).toBeLessThanOrEqual(5);
    }
  });

  it("derives language from a file extension; const data is NOT a boundary", () => {
    expect(languageFromPath("src/foo/Bar.tsx")).toBe("tsx");
    expect(languageFromPath("x.py")).toBe("py");
    expect(languageFromPath(null)).toBeUndefined();
    // a plain data const must not be mistaken for a symbol → line-based fallback
    const data = chunkCode("export const COLORS = ['red', 'green'];\n", { language: "ts" });
    expect(data[0].symbol).toBeUndefined();
  });

  it("empty / whitespace-only input yields no chunks", () => {
    expect(chunkCode("", { language: "ts" })).toEqual([]);
    expect(chunkCode("   \n\n  ", { language: "ts" })).toEqual([]);
  });
});

describe("chunkCode structural scan (MEM-18)", () => {
  it("ends a symbol at its closing brace and isolates top-level code between symbols", () => {
    const src = [
      "function a() {",               // 1
      "  return 1;",                  // 2
      "}",                            // 3
      "const TABLE = buildTable();",  // 4  top-level statement between symbols
      "function b() {",               // 5
      "  return 2;",                  // 6
      "}",                            // 7
    ].join("\n");
    const chunks = chunkCode(src, { language: "ts" });
    // a (1-3), the statement as its own unlabelled region (4), b (5-7). The
    // regex heuristic would have absorbed line 4 into `a` (no real end).
    expect(chunks.map((c) => c.symbol)).toEqual(["a", null, "b"]);
    expect({ s: chunks[0].startLine, e: chunks[0].endLine }).toEqual({ s: 1, e: 3 });
    expect(chunks[1].content).toContain("const TABLE");
    expect({ s: chunks[2].startLine, e: chunks[2].endLine }).toEqual({ s: 5, e: 7 });
  });

  it("is not fooled by braces inside strings or comments", () => {
    const src = [
      "function tricky() {",            // 1
      "  const s = '} not the end {';", // 2
      "  // } also not the end",        // 3
      "  return s;",                    // 4
      "}",                              // 5
      "function after() { return 0; }", // 6
    ].join("\n");
    const chunks = chunkCode(src, { language: "ts" });
    expect(chunks.map((c) => c.symbol)).toEqual(["tricky", "after"]);
    expect(chunks[0].endLine).toBe(5); // the real brace, not the ones in the string/comment
  });

  it("ends a brace-less declaration at its semicolon", () => {
    const src = [
      "export type Id = string;",       // 1
      "export function use(id: Id) {",  // 2
      "  return id;",                   // 3
      "}",                              // 4
    ].join("\n");
    const chunks = chunkCode(src, { language: "ts" });
    expect(chunks.map((c) => c.symbol)).toEqual(["Id", "use"]);
    expect({ s: chunks[0].startLine, e: chunks[0].endLine }).toEqual({ s: 1, e: 1 });
  });

  it("Rust: a unit struct ends at its semicolon, an impl at its brace", () => {
    const src = [
      "pub struct Unit;", // 1
      "impl Unit {",      // 2
      "    fn n() {}",    // 3
      "}",                // 4
    ].join("\n");
    const chunks = chunkCode(src, { language: "rs" });
    expect(chunks.map((c) => c.symbol)).toEqual(["Unit", "Unit"]);
    expect(chunks[0].endLine).toBe(1); // unit struct is one line
  });
});

describe("chunkCode AST adapter (MEM-24)", () => {
  it("uses the real parser: an unmatched brace inside a regex literal doesn't end the symbol early", () => {
    const src = [
      "function f() {",             // 1
      "  const re = /^}/;",         // 2  the `}` in this regex would fool a brace counter
      "  return re.test('x');",     // 3
      "}",                          // 4
      "function g() { return 2; }", // 5
    ].join("\n");
    const chunks = chunkCode(src, { language: "ts" });
    expect(chunks.map((c) => c.symbol)).toEqual(["f", "g"]);
    expect(chunks[0].endLine).toBe(4); // AST ends f at its real closing brace, not the regex's
  });

  it("parses TSX + decorators (constructs the structural scanner doesn't model)", () => {
    const src = [
      "@Component({ selector: 'app' })", // 1  decorator
      "export class Widget {",           // 2
      "  render() { return <div>{1}</div>; }", // 3  JSX with braces
      "}",                               // 4
      "export const Hello = () => <h1>{'hi'}</h1>;", // 5  arrow returning JSX
    ].join("\n");
    const chunks = chunkCode(src, { language: "tsx" });
    expect(chunks.map((c) => c.symbol)).toEqual(["Widget", "Hello"]);
  });
});
