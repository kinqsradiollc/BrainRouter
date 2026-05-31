/**
 * CODE-SCALE (0.4.5) — a deterministic, labelled, repo-scale-ish synthetic
 * codebase for the find_related retrieval benchmark.
 *
 * The repo is a set of independent CLUSTERS. Within a cluster, files share a
 * distinctive symbol prefix and import each other in a chain, so they are
 * genuinely related (import edges + lexical overlap). Across clusters there is
 * no shared vocabulary, so a good retriever should NOT mix clusters.
 *
 * The gold label for a seed file is "the other files in its cluster" — exactly
 * what find_related should surface. Pure: no fs / store / time / randomness, so
 * it's reproducible across runs and machines.
 */

export interface CodeScaleFile {
  filePath: string;
  content: string;
  language: string;
}

export interface CodeScaleQuery {
  /** Seed file path. */
  seed: string;
  /** Gold-relevant files (the rest of the seed's cluster). */
  relevant: string[];
}

export interface CodeScaleFixture {
  files: CodeScaleFile[];
  queries: CodeScaleQuery[];
}

const CLUSTER_THEMES = [
  "auth", "billing", "search", "ingest", "render", "scheduler", "vault", "graph",
];

/**
 * Build `clusters` clusters of `perCluster` files each. Defaults give 8×5 = 40
 * files / 8 queries — large enough to be repo-scale-ish, small enough to keep
 * the integration test fast.
 */
export function buildCodeScaleFixture(opts?: { clusters?: number; perCluster?: number }): CodeScaleFixture {
  const clusterCount = Math.min(opts?.clusters ?? 8, CLUSTER_THEMES.length);
  const perCluster = Math.max(opts?.perCluster ?? 5, 2);

  const files: CodeScaleFile[] = [];
  const queries: CodeScaleQuery[] = [];

  for (let c = 0; c < clusterCount; c++) {
    const theme = CLUSTER_THEMES[c];
    const clusterFiles: string[] = [];
    for (let i = 0; i < perCluster; i++) {
      clusterFiles.push(`src/${theme}/${theme}_mod${i}.ts`);
    }
    for (let i = 0; i < perCluster; i++) {
      const next = clusterFiles[(i + 1) % perCluster];
      // Import the next file in the cluster (relative path) → import edge.
      const rel = "./" + next.split("/").pop()!.replace(/\.ts$/, "");
      const sym = `${theme}_handle${i}`;
      const helper = `${theme}_normalize`;
      const content = [
        `import { ${theme}_handle${(i + 1) % perCluster} } from "${rel}";`,
        ``,
        `// ${theme} module ${i} — part of the ${theme} subsystem.`,
        `export function ${sym}(input: string): string {`,
        `  const v = ${helper}(input);`,
        `  return ${theme}_handle${(i + 1) % perCluster} ? v + "${theme}" : v;`,
        `}`,
        ``,
        `export function ${helper}(s: string): string {`,
        `  return s.trim().toLowerCase() + "_${theme}";`,
        `}`,
        ``,
        `export const ${theme}_CONFIG${i} = { subsystem: "${theme}", index: ${i} };`,
      ].join("\n");
      files.push({ filePath: clusterFiles[i], content, language: "ts" });
    }
    // One query per cluster: seed = file 0, gold = the rest of the cluster.
    queries.push({ seed: clusterFiles[0], relevant: clusterFiles.slice(1) });
  }

  return { files, queries };
}
