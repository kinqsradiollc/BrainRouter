/**
 * ADR-033 D2/D9 — deterministic semantic edges visible in a changed-file diff.
 *
 * This module recognizes only explicit references (imports, local Markdown
 * links, workflow/config and package-script paths, HTML/CSS assets), exact UI
 * class/protocol/dependency matches, manifest/lock ownership, and conventional
 * test layouts. Every candidate is resolved against the paths already present
 * in the diff. Untrusted text can therefore join two files the review already
 * owns, but can never add a repository path to review scope.
 */

export interface ChangedReviewFile {
  path: string;
  diff: string;
}

const CODE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'] as const;
const INVOKABLE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|mjs|cjs|sh|bash|py|rb|go|rs|java|kt|ps1)$/i;
const CODE_REFERENCE = /(?:from\s+|require\(\s*|import\s+|import\(\s*)['"]([^'"]+)['"]/g;
const HTML_REFERENCE = /(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi;
const CSS_REFERENCE = /(?:@import\s+(?:url\(\s*)?|url\(\s*)['"]?([^'"\s)]+)|@import\s+['"]([^'"]+)['"]/gi;
const MARKDOWN_REFERENCE = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const CSS_CLASS_SELECTOR = /\.(-?[_a-zA-Z]+[_a-zA-Z\d-]*)/g;
const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*=\s*(?:\{\s*)?(['"`])([\s\S]*?)\1\s*\}?/g;
const PROTOCOL_PRODUCER = /\bkind\s*:\s*['"]([a-z][\w:-]*[-:][\w:-]*)['"]/gi;
const PROTOCOL_CONSUMER = /\bcase\s+['"]([a-z][\w:-]*[-:][\w:-]*)['"]\s*:/gi;
const DEPENDENCY_ENTRY = /"((?:@[^/"\s]+\/)?[^/"\s]+)"\s*:\s*"((?:[\^~<>=*]|\d|workspace:|file:|link:|npm:|git\+|https?:\/\/)[^"]*)"/gi;

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function normalizePath(value: string): string | null {
  const parts: string[] = [];
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function newRevisionText(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || line.startsWith(' '))
    .map((line) => line.slice(1))
    .join('\n');
}

function cleanReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(trimmed)) return null;
  const withoutSuffix = trimmed.split(/[?#]/, 1)[0]?.trim() ?? '';
  return withoutSuffix || null;
}

function resolveChangedReference(
  fromPath: string,
  reference: string,
  changed: ReadonlySet<string>,
  baseDirectory = directoryOf(fromPath),
): string | null {
  const cleaned = cleanReference(reference);
  if (!cleaned) return null;
  const joined = cleaned.startsWith('/')
    ? cleaned.slice(1)
    : `${baseDirectory ? `${baseDirectory}/` : ''}${cleaned}`;
  const base = normalizePath(joined);
  if (!base) return null;
  const extensionless = base.replace(/\.[cm]?jsx?$/i, '');
  const candidates = [
    base,
    ...CODE_EXTENSIONS.flatMap((extension) => [
      `${extensionless}.${extension}`,
      `${base}.${extension}`,
      `${extensionless}/index.${extension}`,
      `${base}/index.${extension}`,
    ]),
  ];
  return candidates.find((candidate) => changed.has(candidate)) ?? null;
}

function relativePath(fromDirectory: string, target: string): string | null {
  const from = normalizePath(fromDirectory)?.split('/').filter(Boolean) ?? [];
  const to = normalizePath(target)?.split('/').filter(Boolean) ?? [];
  if (!to.length) return null;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join('/');
}

function containsCommandPath(command: string, value: string): boolean {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s'"=(:,])(?:\\./)?${escaped}(?=$|[\\s'"),;])`).test(command);
}

function invokedChangedPaths(
  command: string,
  baseDirectory: string,
  changedPaths: readonly string[],
  repositoryRelative: boolean,
): string[] {
  const matches: string[] = [];
  for (const target of changedPaths) {
    if (!INVOKABLE_EXTENSIONS.test(target)) continue;
    const relative = relativePath(baseDirectory, target);
    if ((repositoryRelative && containsCommandPath(command, target)) || (relative && containsCommandPath(command, relative))) {
      matches.push(target);
    }
  }
  return matches;
}

function isWorkflowOrInvocationConfig(path: string): boolean {
  return /^(?:\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/i.test(path)
    || /(^|\/)(?:\.circleci|ci)\/.*\.ya?ml$/i.test(path)
    || /(^|\/)(?:Dockerfile|docker-compose(?:\.[^/]+)?\.ya?ml)$/i.test(path);
}

function isExplicitPathConfig(path: string): boolean {
  return /(^|\/)(?:[^/]+\.config\.(?:[cm]?[jt]s|json|ya?ml)|tsconfig(?:\.[^/]+)?\.json)$/i.test(path);
}

function isViteConfig(path: string): boolean {
  return /(^|\/)vite\.config\.[cm]?[jt]s$/i.test(path);
}

function explicitlyReferencedChangedPaths(
  text: string,
  baseDirectory: string,
  changedPaths: readonly string[],
): string[] {
  const matches: string[] = [];
  for (const target of changedPaths) {
    const relative = relativePath(baseDirectory, target);
    if (containsCommandPath(text, target) || (relative && containsCommandPath(text, relative))) {
      matches.push(target);
    }
  }
  return matches;
}

function collectMatches(text: string, expression: RegExp): Set<string> {
  const values = new Set<string>();
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value) values.add(value);
  }
  return values;
}

function cssSelectorClasses(text: string): Set<string> {
  return new Set([...collectMatches(text, CSS_CLASS_SELECTOR)].filter((token) => token.length >= 3));
}

function markupClasses(text: string): Set<string> {
  const values = new Set<string>();
  CLASS_ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_ATTRIBUTE.exec(text)) !== null) {
    for (const token of (match[2] ?? '').match(/-?[_a-zA-Z]+[_a-zA-Z\d-]*/g) ?? []) {
      if (token.length >= 3) values.add(token);
    }
  }
  return values;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function importedPackageNames(text: string): Set<string> {
  const packages = new Set<string>();
  CODE_REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_REFERENCE.exec(text)) !== null) {
    const specifier = match[1]?.trim() ?? '';
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) continue;
    const segments = specifier.split('/');
    const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    if (packageName) packages.add(packageName);
  }
  return packages;
}

function dependencyNames(text: string): Set<string> {
  const names = new Set<string>();
  DEPENDENCY_ENTRY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEPENDENCY_ENTRY.exec(text)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function isWithinDirectory(path: string, directory: string): boolean {
  return !directory || path.startsWith(`${directory}/`);
}

function sourceExtension(path: string): string {
  return /\.[a-z\d]+$/i.exec(path)?.[0] ?? '.ts';
}

function implementationCandidates(testPath: string): string[] {
  const base = baseNameOf(testPath);
  if (!/(?:^test[_-]|[_-]test\.|\.(?:test|spec)\.)/i.test(base)) return [];
  const extension = sourceExtension(base);
  const stem = base
    .slice(0, -extension.length)
    .replace(/^test[_-]/i, '')
    .replace(/[_-]test$/i, '')
    .replace(/\.(?:test|spec)$/i, '');
  const segments = testPath.split('/');
  const testDirectory = segments.findIndex((segment) => /^(?:__tests__|tests?|specs?)$/i.test(segment));
  const suffix = testDirectory >= 0 ? segments.slice(testDirectory + 1, -1) : [];
  const prefix = testDirectory >= 0 ? segments.slice(0, testDirectory) : segments.slice(0, -1);
  const roots = testDirectory >= 0 && /^(?:tests?|specs?)$/i.test(segments[testDirectory])
    ? [prefix, [...prefix, 'src'], [...prefix, 'lib'], [...prefix, 'app']]
    : [prefix];
  return roots.map((root) => [...root, ...suffix, `${stem}${extension}`].filter(Boolean).join('/'));
}

function nearestChangedPackageLock(packagePath: string, changed: ReadonlySet<string>): string | null {
  let directory = directoryOf(packagePath);
  for (;;) {
    const candidate = directory ? `${directory}/package-lock.json` : 'package-lock.json';
    if (changed.has(candidate)) return candidate;
    if (!directory) return null;
    directory = directoryOf(directory);
  }
}

/** Return semantic pairs without ever introducing a path outside `files`. */
export function relatedPathsFromChangedFiles(files: readonly ChangedReviewFile[]): Array<[string, string]> {
  const changedPaths = files.map((file) => file.path).filter(Boolean);
  const changed = new Set(changedPaths);
  const edges: Array<[string, string]> = [];
  const seen = new Set<string>();
  const cssClassesByPath = new Map<string, Set<string>>();
  const markupClassesByPath = new Map<string, Set<string>>();
  const protocolProducersByPath = new Map<string, Set<string>>();
  const protocolConsumersByPath = new Map<string, Set<string>>();
  const importedPackagesByPath = new Map<string, Set<string>>();
  const dependenciesByManifest = new Map<string, Set<string>>();
  const add = (from: string, to: string | null): void => {
    if (!to || from === to || !changed.has(from) || !changed.has(to)) return;
    const key = [from, to].sort().join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([from, to]);
  };

  for (const file of files) {
    if (!file.path) continue;
    const text = newRevisionText(file.diff);
    const importedPackages = importedPackageNames(text);
    if (importedPackages.size) importedPackagesByPath.set(file.path, importedPackages);
    const producers = collectMatches(text, PROTOCOL_PRODUCER);
    const consumers = collectMatches(text, PROTOCOL_CONSUMER);
    if (producers.size) protocolProducersByPath.set(file.path, producers);
    if (consumers.size) protocolConsumersByPath.set(file.path, consumers);
    if (/\.(?:css|scss|sass|less)$/i.test(file.path)) {
      const classes = cssSelectorClasses(text);
      if (classes.size) cssClassesByPath.set(file.path, classes);
    } else {
      const classes = markupClasses(text);
      if (classes.size) markupClassesByPath.set(file.path, classes);
    }
    CODE_REFERENCE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CODE_REFERENCE.exec(text)) !== null) {
      if (match[1]?.startsWith('.')) add(file.path, resolveChangedReference(file.path, match[1], changed));
    }

    if (/\.html?$/i.test(file.path)) {
      HTML_REFERENCE.lastIndex = 0;
      while ((match = HTML_REFERENCE.exec(text)) !== null) {
        add(file.path, resolveChangedReference(file.path, match[1] ?? '', changed));
      }
    }
    if (/\.(?:css|scss|sass|less)$/i.test(file.path)) {
      CSS_REFERENCE.lastIndex = 0;
      while ((match = CSS_REFERENCE.exec(text)) !== null) {
        add(file.path, resolveChangedReference(file.path, match[1] ?? match[2] ?? '', changed));
      }
    }
    if (/\.mdx?$/i.test(file.path)) {
      MARKDOWN_REFERENCE.lastIndex = 0;
      while ((match = MARKDOWN_REFERENCE.exec(text)) !== null) {
        add(file.path, resolveChangedReference(file.path, match[1] ?? match[2] ?? '', changed));
      }
    }
    if (baseNameOf(file.path) === 'package.json') {
      for (const target of invokedChangedPaths(text, directoryOf(file.path), changedPaths, false)) add(file.path, target);
      add(file.path, nearestChangedPackageLock(file.path, changed));
      const dependencies = dependencyNames(text);
      if (dependencies.size) dependenciesByManifest.set(file.path, dependencies);
    }
    if (isWorkflowOrInvocationConfig(file.path)) {
      for (const target of invokedChangedPaths(text, '', changedPaths, true)) add(file.path, target);
    }
    if (isExplicitPathConfig(file.path)) {
      for (const target of explicitlyReferencedChangedPaths(text, directoryOf(file.path), changedPaths)) {
        add(file.path, target);
      }
    }
    if (isViteConfig(file.path)) {
      const directory = directoryOf(file.path);
      add(file.path, directory ? `${directory}/index.html` : 'index.html');
    }
    for (const candidate of implementationCandidates(file.path)) {
      if (changed.has(candidate)) add(file.path, candidate);
    }
  }

  // Exact CSS selectors connect only to changed markup that uses the same
  // class token; utility text elsewhere in a hunk is not considered.
  for (const [stylePath, styleClasses] of cssClassesByPath) {
    for (const [markupPath, classes] of markupClassesByPath) {
      if (intersects(styleClasses, classes)) add(stylePath, markupPath);
    }
  }

  // A protocol producer and switch consumer share a review unit only for an
  // exact, structured discriminant (for example `kind: 'set-model'` and
  // `case 'set-model':`). Requiring punctuation avoids generic status words.
  for (const [producerPath, producers] of protocolProducersByPath) {
    for (const [consumerPath, consumers] of protocolConsumersByPath) {
      if (intersects(producers, consumers)) add(producerPath, consumerPath);
    }
  }

  // Manifest dependencies connect to changed importers inside that manifest's
  // package boundary. Versions are recognized, script values are not.
  for (const [manifestPath, dependencies] of dependenciesByManifest) {
    const packageDirectory = directoryOf(manifestPath);
    for (const [importerPath, imports] of importedPackagesByPath) {
      if (isWithinDirectory(importerPath, packageDirectory) && intersects(dependencies, imports)) {
        add(manifestPath, importerPath);
      }
    }
  }
  return edges;
}
