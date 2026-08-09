/**
 * ADR-033 D2 — a review unit is a BUNDLE of related files, decided by code.
 *
 * The bot used to split a diff by SIZE, which is the one property of a change
 * that carries no meaning: a message catalogue and its translation, a function
 * and its test, a route and its handler could land in different parts and be
 * reviewed by two calls that could not see each other. Bundles group the files
 * that have to be read together, so each unit is coherent — and because
 * bundles are independent, they run concurrently instead of as one serial
 * chain.
 *
 * Bundling is ENGINEERING, not judgement. A model asked "which files go
 * together" is plausible and unstable; path relationships and import edges are
 * neither. It is also the ADR-033 D9 boundary: because scope is decided here,
 * a hostile diff cannot argue its way into a wider review — the import-edge
 * signal below only ever JOINS two files that are already in the changeset, it
 * can never add one.
 *
 * Everything in this module is pure so the grouping is testable without a
 * repository, a model, or a network.
 */

/** One file section of a unified diff, with its new-revision path. */
export interface ReviewDiffFile {
  path: string;
  diff: string;
}

/** Why the planner put a bundle's files together — reported, never guessed. */
export type ReviewBundleRelation =
  | 'implementation_and_test'
  | 'catalogue_siblings'
  | 'import_edge'
  | 'directory_adjacency'
  | 'standalone';

/** One independently reviewable unit: related files plus their diff text. */
export interface ReviewBundle {
  /** Stable, deterministic id (`bundle-1`…), used in task ids and telemetry. */
  id: string;
  /** Repo-relative new-revision paths in this bundle, sorted. */
  paths: string[];
  /** The concatenated diff sections for `paths`. */
  diff: string;
  /** The relations that put these files in one unit. */
  relations: ReviewBundleRelation[];
  /** Set only when ONE file was too large for the budget and had to split. */
  part?: { index: number; total: number };
}

export interface ReviewBundlePlanInput {
  diff: string;
  /** Per-bundle context budget in characters. */
  maxBundleChars: number;
  /** Hard ceiling on bundles; the remainder is deferred, never silently lost. */
  maxBundles: number;
  /**
   * Extra "these two files belong together" edges decided by code elsewhere —
   * the exact-revision code graph is the best source. Endpoints that are not
   * both in the changeset are ignored.
   */
  relatedPaths?: Iterable<readonly [string, string]>;
}

export interface ReviewBundlePlan {
  bundles: ReviewBundle[];
  /** Changed paths the bundle ceiling excluded, so coverage can report them. */
  deferredPaths: string[];
  totalFiles: number;
}

const DATA_EXTENSIONS = new Set([
  'json',
  'yaml',
  'yml',
  'po',
  'pot',
  'properties',
  'strings',
  'xlf',
  'xliff',
  'resx',
  'arb',
  'ini',
  'toml',
]);

const TEST_DIRECTORY_SEGMENTS = new Set([
  '__tests__',
  '__test__',
  '__specs__',
  'tests',
  'test',
  'spec',
  'specs',
]);

/** Strip the `a/` `b/` prefixes git puts on diff header paths. */
function stripDiffPathPrefix(value: string): string {
  return value.replace(/^[ab]\//, '').trim();
}

/**
 * Normalize a path a model (or a diff) reported to the repo-relative form the
 * planner and the positioner both key on. Never resolves `..` — a path that
 * tries to climb is returned unchanged so callers can reject it outright.
 */
export function normalizeReviewPath(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function extensionOf(path: string): string {
  const base = baseNameOf(path);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index + 1).toLowerCase();
}

/**
 * The key that pairs an implementation with its test: the directory with test
 * segments removed, plus the file's stem with test affixes removed. It pairs
 * `src/foo.ts` with `src/__tests__/foo.test.ts`, `foo_test.go`, and
 * `test_foo.py`, and it pairs a component with its stylesheet — all of which
 * are files a reviewer has to read as one thing.
 */
export function fileFamilyKey(path: string): string {
  const directory = directoryOf(path)
    .split('/')
    .filter((segment) => segment && !TEST_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))
    .join('/');
  const base = baseNameOf(path);
  const dot = base.indexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/^test[_-]/i, '')
    .replace(/[_-]test$/i, '')
    .replace(/[.-](test|spec)$/i, '');
  return `${directory}/${stem.toLowerCase()}`;
}

/** Split a unified diff into per-file sections keyed by their new-revision path. */
export function splitUnifiedDiffFiles(diff: string): ReviewDiffFile[] {
  const sections: string[] = [];
  let buffer: string[] = [];
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('diff --git ') && buffer.length) {
      sections.push(buffer.join('\n'));
      buffer = [];
    }
    buffer.push(line);
  }
  if (buffer.length) sections.push(buffer.join('\n'));
  return sections
    .filter((section) => section.trim().length > 0)
    .map((section) => ({ path: diffSectionPath(section), diff: section }));
}

/** The new-revision path a diff section describes ('' when it names none). */
function diffSectionPath(section: string): string {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
  if (header?.[2]) return stripDiffPathPrefix(header[2]);
  const target = /^\+\+\+ (.+)$/m.exec(section);
  if (target?.[1] && target[1].trim() !== '/dev/null') return stripDiffPathPrefix(target[1]);
  const origin = /^--- (.+)$/m.exec(section);
  if (origin?.[1] && origin[1].trim() !== '/dev/null') return stripDiffPathPrefix(origin[1]);
  return header?.[1] ? stripDiffPathPrefix(header[1]) : '';
}

/**
 * Split ONE oversized file section into `<file header>\n<hunk>` pieces, so a
 * single enormous file still gets reviewed hunk by hunk rather than truncated.
 * A section with no hunks (binary, pure rename) is indivisible.
 */
export function splitDiffFileByHunk(section: string): string[] {
  const lines = section.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return [section];
  const header = lines.slice(0, firstHunk).join('\n');
  const hunks: string[] = [];
  let buffer: string[] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@') && buffer.length) {
      hunks.push(buffer.join('\n'));
      buffer = [];
    }
    buffer.push(line);
  }
  if (buffer.length) hunks.push(buffer.join('\n'));
  return hunks.map((hunk) => `${header}\n${hunk}`);
}

const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\s+|import\(\s*)['"]([^'"]+)['"]/g;

/**
 * Import edges derived from the diff itself, restricted to files the diff
 * already changes.
 *
 * ADR-033 D9: this reads untrusted content, so it is deliberately incapable of
 * widening scope — an unresolvable or unchanged target is dropped, and the only
 * possible effect is joining two files that were both going to be reviewed
 * anyway. The exact-revision code graph is the stronger signal when a caller
 * has one; this is the floor for every other case.
 */
export function relatedPathsFromDiff(diff: string): Array<[string, string]> {
  const files = splitUnifiedDiffFiles(diff).filter((file) => file.path);
  const changed = new Set(files.map((file) => file.path));
  const edges: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const file of files) {
    const directory = directoryOf(file.path);
    IMPORT_SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER.exec(file.diff)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue; // package imports cannot name a changed file
      const target = resolveRelativeSpecifier(directory, specifier, changed);
      if (!target || target === file.path) continue;
      const key = [file.path, target].sort().join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([file.path, target]);
    }
  }
  return edges;
}

/** Resolve `./x.js` against the changed set, honouring ESM `.js` → `.ts`. */
function resolveRelativeSpecifier(
  directory: string,
  specifier: string,
  changed: ReadonlySet<string>,
): string | null {
  const joined = `${directory ? `${directory}/` : ''}${specifier}`;
  const parts: string[] = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null; // climbing out of the repository is never a changed file
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const base = parts.join('/');
  if (!base) return null;
  const withoutExtension = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].flatMap((extension) => [
      `${withoutExtension}.${extension}`,
      `${base}.${extension}`,
      `${withoutExtension}/index.${extension}`,
      `${base}/index.${extension}`,
    ]),
  ];
  for (const candidate of candidates) {
    if (changed.has(candidate)) return candidate;
  }
  return null;
}

class DisjointSet {
  private readonly parent = new Map<number, number>();

  find(node: number): number {
    const parent = this.parent.get(node);
    if (parent === undefined || parent === node) return node;
    const root = this.find(parent);
    this.parent.set(node, root);
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    this.parent.set(Math.max(a, b), Math.min(a, b));
  }
}

interface FileGroup {
  indexes: number[];
  relations: Set<ReviewBundleRelation>;
  chars: number;
  sortKey: string;
}

/**
 * Group the diff's files into related units, then pack those units into
 * bundles within the per-bundle budget.
 *
 * Invariants the tests pin: every changed file lands in exactly one bundle or
 * in `deferredPaths`; the plan is a pure function of its input (same diff, same
 * bundles, same ids); and a group is never split across bundles unless the
 * group is one file too large for the budget on its own.
 */
export function planReviewBundles(input: ReviewBundlePlanInput): ReviewBundlePlan {
  const maxBundleChars = Math.max(1_000, Math.trunc(input.maxBundleChars));
  const maxBundles = Math.max(1, Math.trunc(input.maxBundles));
  const files = splitUnifiedDiffFiles(input.diff).filter((file) => file.diff.trim().length > 0);
  if (files.length === 0) return { bundles: [], deferredPaths: [], totalFiles: 0 };

  const pathIndex = new Map<string, number>();
  files.forEach((file, index) => {
    if (file.path && !pathIndex.has(file.path)) pathIndex.set(file.path, index);
  });

  const sets = new DisjointSet();
  const relations = new Map<number, Set<ReviewBundleRelation>>();
  const noteRelation = (index: number, relation: ReviewBundleRelation): void => {
    const root = sets.find(index);
    const current = relations.get(root) ?? new Set<ReviewBundleRelation>();
    current.add(relation);
    relations.set(root, current);
  };
  const join = (left: number, right: number, relation: ReviewBundleRelation): void => {
    const leftRelations = relations.get(sets.find(left)) ?? new Set<ReviewBundleRelation>();
    const rightRelations = relations.get(sets.find(right)) ?? new Set<ReviewBundleRelation>();
    sets.union(left, right);
    const merged = new Set<ReviewBundleRelation>([...leftRelations, ...rightRelations, relation]);
    relations.set(sets.find(left), merged);
  };

  const byFamily = new Map<string, number[]>();
  const byCatalogue = new Map<string, number[]>();
  files.forEach((file, index) => {
    if (!file.path) return;
    const family = fileFamilyKey(file.path);
    byFamily.set(family, [...(byFamily.get(family) ?? []), index]);
    const extension = extensionOf(file.path);
    if (DATA_EXTENSIONS.has(extension)) {
      const key = `${directoryOf(file.path)}::${extension}`;
      byCatalogue.set(key, [...(byCatalogue.get(key) ?? []), index]);
    }
  });
  for (const members of byFamily.values()) {
    for (let i = 1; i < members.length; i++) join(members[0], members[i], 'implementation_and_test');
  }
  for (const members of byCatalogue.values()) {
    for (let i = 1; i < members.length; i++) join(members[0], members[i], 'catalogue_siblings');
  }
  for (const [from, to] of input.relatedPaths ?? []) {
    const left = pathIndex.get(normalizeReviewPath(from));
    const right = pathIndex.get(normalizeReviewPath(to));
    if (left === undefined || right === undefined || left === right) continue;
    join(left, right, 'import_edge');
  }

  const groups = new Map<number, FileGroup>();
  files.forEach((file, index) => {
    const root = sets.find(index);
    const group = groups.get(root) ?? {
      indexes: [],
      relations: new Set<ReviewBundleRelation>(),
      chars: 0,
      sortKey: '',
    };
    group.indexes.push(index);
    group.chars += file.diff.length + 1;
    groups.set(root, group);
  });
  for (const [root, group] of groups) {
    const inherited = relations.get(root);
    if (inherited) for (const relation of inherited) group.relations.add(relation);
    if (group.indexes.length === 1 && group.relations.size === 0) group.relations.add('standalone');
    // Ordering by directory keeps packed bundles local to one area of the tree,
    // so a bundle that ends up holding two small groups is still coherent.
    const paths = group.indexes.map((index) => files[index].path || `￿${index}`).sort();
    group.sortKey = `${directoryOf(paths[0])} ${paths[0]}`;
  }

  const ordered = [...groups.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  const packed: Array<{ indexes: number[]; relations: Set<ReviewBundleRelation>; part?: { index: number; total: number } }> = [];
  /** Diff text for the split parts of one oversized file, by packed index. */
  const partText = new Map<number, string>();
  let current: { indexes: number[]; relations: Set<ReviewBundleRelation>; chars: number } | null = null;
  const flush = (): void => {
    if (current && current.indexes.length) packed.push({ indexes: current.indexes, relations: current.relations });
    current = null;
  };
  for (const group of ordered) {
    if (group.chars > maxBundleChars && group.indexes.length === 1) {
      // One file larger than a whole bundle: split it along hunk boundaries so
      // it is still reviewed end to end, and say so on every part.
      flush();
      const file = files[group.indexes[0]];
      const pieces = packOversizedFile(file, maxBundleChars);
      pieces.forEach((piece, pieceIndex) => {
        packed.push({
          indexes: [group.indexes[0]],
          relations: new Set(group.relations),
          part: { index: pieceIndex + 1, total: pieces.length },
        });
        partText.set(packed.length - 1, piece);
      });
      continue;
    }
    if (current && current.chars + group.chars > maxBundleChars) flush();
    if (!current) current = { indexes: [], relations: new Set<ReviewBundleRelation>(), chars: 0 };
    if (current.indexes.length > 0) current.relations.add('directory_adjacency');
    current.indexes.push(...group.indexes);
    for (const relation of group.relations) current.relations.add(relation);
    current.chars += group.chars;
    if (current.chars >= maxBundleChars) flush();
  }
  flush();

  const bundles: ReviewBundle[] = [];
  const deferredPaths: string[] = [];
  packed.forEach((entry, index) => {
    const paths = [...new Set(entry.indexes.map((fileIndex) => files[fileIndex].path).filter(Boolean))].sort();
    if (index >= maxBundles) {
      deferredPaths.push(...paths);
      return;
    }
    const text = partText.get(index)
      ?? entry.indexes.map((fileIndex) => files[fileIndex].diff).join('\n');
    bundles.push({
      id: `bundle-${bundles.length + 1}`,
      paths,
      diff: text,
      relations: [...entry.relations].sort(),
      ...(entry.part ? { part: entry.part } : {}),
    });
  });

  return {
    bundles,
    deferredPaths: [...new Set(deferredPaths)].sort(),
    totalFiles: files.length,
  };
}

/** Hunk-packed pieces of one file whose own diff exceeds the bundle budget. */
function packOversizedFile(file: ReviewDiffFile, maxBundleChars: number): string[] {
  const hunks = splitDiffFileByHunk(file.diff);
  if (hunks.length <= 1) return [file.diff];
  const pieces: string[] = [];
  let current = '';
  for (const hunk of hunks) {
    if (!current) current = hunk;
    else if (current.length + 1 + hunk.length <= maxBundleChars) current += `\n${hunk}`;
    else {
      pieces.push(current);
      current = hunk;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
