/**
 * ADR-033 D2/D9 — source/output relationships proven by exact-revision tsconfig.
 *
 * Generated JavaScript is not guessed from a similar basename. A pair exists
 * only when a bounded, inventory-listed tsconfig declares rootDir/outDir and
 * both the emitted path and its unique source candidate are in that inventory.
 */

import { dirname, extname, join, normalize } from 'node:path/posix';
import ts from 'typescript';
import { TYPESCRIPT_SOURCE_EXTENSIONS } from './pathResolution.js';

export interface TypeScriptConfigSource {
  path: string;
  source: string;
}

const EMITTED_JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function repositoryPath(configPath: string, configuredPath: string): string | null {
  const trimmed = configuredPath.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.startsWith('/') || /^[a-z]:\//i.test(trimmed)) return null;
  const resolved = normalize(join(dirname(configPath), trimmed));
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

function sourceCandidates(rootDir: string, outputRelativePath: string): string[] {
  const extension = extname(outputRelativePath).toLowerCase();
  const stem = outputRelativePath.slice(0, -extension.length);
  const preferred = extension === '.mjs'
    ? ['.mts', '.mjs', '.ts', '.js']
    : extension === '.cjs'
      ? ['.cts', '.cjs', '.ts', '.js']
      : TYPESCRIPT_SOURCE_EXTENSIONS;
  return preferred.map((candidateExtension) => join(rootDir, `${stem}${candidateExtension}`));
}

/** Return deterministic, unique source/output pairs from exact inventory data. */
export function generatedSourceRelationships(
  configs: readonly TypeScriptConfigSource[],
  eligiblePaths: ReadonlySet<string>,
): Array<[string, string]> {
  const sourcesByOutput = new Map<string, Set<string>>();
  for (const config of [...configs].sort((left, right) => left.path.localeCompare(right.path))) {
    const parsed = ts.parseConfigFileTextToJson(config.path, config.source);
    if (parsed.error || !parsed.config || typeof parsed.config !== 'object') continue;
    const compilerOptions = (parsed.config as { compilerOptions?: unknown }).compilerOptions;
    if (!compilerOptions || typeof compilerOptions !== 'object') continue;
    const { rootDir, outDir } = compilerOptions as { rootDir?: unknown; outDir?: unknown };
    if (typeof rootDir !== 'string' || typeof outDir !== 'string') continue;
    const sourceRoot = repositoryPath(config.path, rootDir);
    const outputRoot = repositoryPath(config.path, outDir);
    if (!sourceRoot || !outputRoot || sourceRoot === outputRoot) continue;

    for (const outputPath of eligiblePaths) {
      if (!outputPath.startsWith(`${outputRoot}/`) || !EMITTED_JAVASCRIPT_EXTENSIONS.has(extname(outputPath).toLowerCase())) {
        continue;
      }
      const relativeOutput = outputPath.slice(outputRoot.length + 1);
      const candidates = sourceCandidates(sourceRoot, relativeOutput).filter((candidate) => eligiblePaths.has(candidate));
      if (candidates.length !== 1) continue;
      const sources = sourcesByOutput.get(outputPath) ?? new Set<string>();
      sources.add(candidates[0]);
      sourcesByOutput.set(outputPath, sources);
    }
  }

  const relationships: Array<[string, string]> = [];
  for (const [outputPath, sources] of [...sourcesByOutput].sort(([left], [right]) => left.localeCompare(right))) {
    if (sources.size !== 1) continue;
    relationships.push([[...sources][0], outputPath]);
  }
  return relationships;
}
