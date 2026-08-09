/**
 * ADR-033 D2 — resolve workspace package imports to exact-revision source.
 *
 * Package manifests are parsed as inert data. Export targets are allowed to
 * resolve only inside their own package root and only to an inventoried source
 * path, so a hostile manifest cannot widen review scope. Dist/type export paths
 * are mapped back to their source counterparts for monorepos that publish from
 * `dist/` while reviewing `src/`.
 */

import { dirname, extname, join, normalize } from 'node:path/posix';
import { TYPESCRIPT_SOURCE_EXTENSIONS } from './pathResolution.js';

export interface WorkspacePackageManifestSource {
  path: string;
  source: string;
}

export interface WorkspaceModuleAlias {
  name: string;
  root: string;
  exports: unknown;
  entryTargets: string[];
}

function safePackageName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(name) && name.length <= 214 ? name : null;
}

function stringTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap(stringTargets);
}

/** Invalid or irrelevant manifests are ignored; the parser index reports JSON as unsupported coverage. */
export function parseWorkspaceModuleAliases(
  manifests: readonly WorkspacePackageManifestSource[],
): WorkspaceModuleAlias[] {
  const aliases: WorkspaceModuleAlias[] = [];
  for (const manifest of manifests) {
    try {
      const parsed = JSON.parse(manifest.source) as Record<string, unknown>;
      const name = safePackageName(parsed.name);
      if (!name) continue;
      aliases.push({
        name,
        root: dirname(manifest.path) === '.' ? '' : dirname(manifest.path),
        exports: parsed.exports,
        entryTargets: [parsed.types, parsed.module, parsed.main].flatMap(stringTargets),
      });
    } catch {
      // Unsupported/malformed package metadata cannot grant a relationship.
    }
  }
  const counts = new Map<string, number>();
  for (const alias of aliases) counts.set(alias.name, (counts.get(alias.name) ?? 0) + 1);
  return aliases
    .filter((alias) => counts.get(alias.name) === 1)
    .sort((left, right) =>
      right.name.length - left.name.length
      || left.name.localeCompare(right.name)
      || left.root.localeCompare(right.root));
}

function exportTargets(exportsValue: unknown, subpath: string): string[] {
  if (typeof exportsValue === 'string') return subpath ? [] : [exportsValue];
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return [];
  const entries = Object.entries(exportsValue as Record<string, unknown>);
  if (!entries.some(([key]) => key.startsWith('.'))) return subpath ? [] : stringTargets(exportsValue);
  const requested = subpath ? `./${subpath}` : '.';
  const exact = entries.find(([key]) => key === requested);
  if (exact) return stringTargets(exact[1]);
  for (const [key, value] of entries) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) continue;
    const replacement = requested.slice(prefix.length, requested.length - suffix.length);
    return stringTargets(value).map((target) => target.replaceAll('*', replacement));
  }
  return [];
}

function sourceCandidates(root: string, relativeTarget: string): string[] {
  const joined = normalize(join(root || '.', relativeTarget));
  const packagePrefix = root ? `${root}/` : '';
  if (joined === '..' || joined.startsWith('../') || (root && joined !== root && !joined.startsWith(packagePrefix))) {
    return [];
  }
  const withoutDeclaration = joined.replace(/\.d\.[cm]?ts$/i, '');
  const withoutRuntimeExtension = joined.replace(/\.[cm]?jsx?$/i, '');
  const bases = new Set([
    joined,
    withoutDeclaration,
    withoutRuntimeExtension,
    joined.replace(/(^|\/)dist\//, '$1src/'),
    withoutDeclaration.replace(/(^|\/)dist\//, '$1src/'),
    withoutRuntimeExtension.replace(/(^|\/)dist\//, '$1src/'),
  ]);
  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(base);
    const extension = extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    for (const sourceExtension of TYPESCRIPT_SOURCE_EXTENSIONS) {
      candidates.push(`${stem}${sourceExtension}`, join(base, `index${sourceExtension}`));
    }
  }
  return [...new Set(candidates)];
}

export function resolveWorkspaceModule(
  specifier: string,
  eligiblePaths: ReadonlySet<string>,
  aliases: readonly WorkspaceModuleAlias[],
): string | null {
  const alias = aliases.find((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
  if (!alias) return null;
  const subpath = specifier === alias.name ? '' : specifier.slice(alias.name.length + 1);
  const declaredExports = exportTargets(alias.exports, subpath);
  const targets = alias.exports !== undefined
    ? declaredExports
    : [
        ...(subpath ? [`./src/${subpath}`, `./${subpath}`] : alias.entryTargets),
        ...(subpath ? [] : ['./src/index', './index']),
      ];
  for (const target of targets) {
    for (const candidate of sourceCandidates(alias.root, target)) {
      if (eligiblePaths.has(candidate)) return candidate;
    }
  }
  return null;
}
