/**
 * Test coverage (ATLAS-15) — does anything test this file? A deterministic
 * signal that's gold for reviewing AI edits: "the AI changed payment.ts and
 * nothing covers it." A file counts as covered if a test file imports it or a
 * name-adjacent test (foo.test.ts next to foo.ts) exists.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";

/** True for typical test file paths (*.test.* / *.spec.* / under __tests__/tests). */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec|node-test)\.[cm]?[jt]sx?$/.test(path);
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(test|spec|node-test)$/, "");
}

/**
 * Code file node ids that have NO test covering them. A file is covered if a
 * test file imports it, or a test file shares its base name.
 */
export function atlasUncoveredFiles(graph: AtlasGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const codeFiles = graph.nodes.filter((n) => n.type === "file" && n.category === "code" && n.filePath && !isTestFile(n.filePath));
  const testBaseNames = new Set<string>();
  for (const n of graph.nodes) if (n.filePath && isTestFile(n.filePath)) testBaseNames.add(baseName(n.filePath));

  // files imported by a test file
  const importedByTest = new Set<string>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const src = byId.get(e.source);
    if (src?.filePath && isTestFile(src.filePath)) importedByTest.add(e.target);
  }

  const uncovered = new Set<string>();
  for (const f of codeFiles) {
    const covered = importedByTest.has(f.id) || testBaseNames.has(baseName(f.filePath!));
    if (!covered) uncovered.add(f.id);
  }
  return uncovered;
}
