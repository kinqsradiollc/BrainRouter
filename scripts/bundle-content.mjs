#!/usr/bin/env node
/**
 * ADR-031 D2/D2b/D3 — one skill library, generated copies, notices generated with them.
 *
 * The root `skills/` directory is the ONLY place a skill is edited. Every package
 * that ships skills gets a generated copy of the whole library, and each generated
 * copy carries a generated third-party notice listing the licensed material inside
 * it.
 *
 * WHY generated rather than committed: `brainrouter/` has worked this way the whole
 * time and its 54 skills have never drifted, while the hand-committed copies in
 * `packages/core/` and `brainrouter-cli/` carried thirteen and could drift the
 * moment somebody edited the wrong file. A copy nobody can commit is a copy nobody
 * can silently change; the check in each package's test suite is the other half.
 *
 * WHY the whole library rather than a selection: a subset makes a workspace profile
 * honest in one package and lying in another, and the entire library is under a
 * megabyte of text (ADR-031 D2b).
 *
 * WHY the notice is generated from what was copied rather than from a list: a list
 * is a second thing to keep in agreement with the first, and §3 of that ADR is a
 * record of what happens to those. Enumerating the licence files that actually
 * landed in the package makes shipping licensed material without its notice
 * impossible rather than merely discouraged.
 *
 * Usage (as a CLI — this is what the package scripts call):
 *
 *   node scripts/bundle-content.mjs --package packages/core            # generate
 *   node scripts/bundle-content.mjs --package packages/core --check    # verify only
 *   node scripts/bundle-content.mjs --package packages/core --clean    # remove
 *
 * Usage (as a module): the exports below are what the packages' own prepack scripts
 * and the drift tests import, so the copy, the check and the notice can never be
 * three different implementations of the same idea.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_LIBRARY = path.join(REPO_ROOT, 'skills');
export const THIRD_PARTY_NOTICE_FILE = 'THIRD-PARTY-NOTICES.md';

/**
 * Never copied. `node_modules`/`.git` would be a catastrophe; the rest is editor
 * and OS debris that npm strips from the tarball anyway — leaving it out of the
 * copy keeps "what the package has" and "what the package ships" the same set,
 * which is what the drift check compares.
 */
const NEVER_COPY = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** A licence file at any depth marks the directory holding it as third-party. */
const LICENCE_FILE = /^licen[cs]e(\.[^.]+)?$/i;

/** First-party workspace packages need no notice — they are this repository. */
const FIRST_PARTY_SCOPE = '@kinqs/';

/**
 * Every regular file under `root`, as sorted repo-style relative paths.
 * One implementation for the copy, the check and the notice: if they disagreed
 * about which files count, the check would pass on a package that ships something
 * else.
 */
export function listContentFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (NEVER_COPY.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root, '');
  return files;
}

/** Copy `sourceDir` to `destDir` file by file, filtered and deterministic. */
export function copyContentDir(sourceDir, destDir) {
  const files = listContentFiles(sourceDir);
  for (const rel of files) {
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, rel), target);
  }
  return files.length;
}

/** Replace `destDir` outright — a renamed or deleted skill must not linger. */
export function syncContentDir(sourceDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  return copyContentDir(sourceDir, destDir);
}

/**
 * Every licence file inside the copied content, keyed by the directory it governs.
 * This is the whole third-party-skill discovery rule: a vendored skill carries its
 * licence beside it in the library (`skills/<category>/<name>/LICENSE`), the copy
 * step carries it along with everything else, and this finds it there.
 */
export function listLicensedContent(packageDir, contentDirs) {
  const found = [];
  for (const dirName of contentDirs) {
    const root = path.join(packageDir, dirName);
    if (!fs.existsSync(root)) continue;
    for (const rel of listContentFiles(root)) {
      const base = path.posix.basename(rel);
      if (!LICENCE_FILE.test(base)) continue;
      const governs = path.posix.dirname(rel);
      found.push({
        /** Path of the licensed material, relative to the package root. */
        subject: governs === '.' ? dirName : `${dirName}/${governs}`,
        licenceFile: `${dirName}/${rel}`,
        text: fs.readFileSync(path.join(root, rel), 'utf8').trimEnd(),
      });
    }
  }
  return found.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}

/** Resolve an installed dependency by walking node_modules up from the package. */
function resolveInstalled(packageDir, name) {
  let dir = packageDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The third-party packages this package declares at runtime, read from the
 * installed tree rather than from anybody's notes. ADR-030's WebAssembly document
 * parser is the entry that made this necessary: it is MIT, we redistribute it in
 * an npm tarball and in a desktop binary, and it had no notice anywhere.
 *
 * Direct runtime dependencies only. Dev dependencies are not redistributed, and
 * transitive ones arrive with their own package (and their own licence file) when
 * npm installs them.
 */
export function listDependencyNotices(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
    .filter((name) => !name.startsWith(FIRST_PARTY_SCOPE))
    .sort();

  return declared.map((name) => {
    const installed = resolveInstalled(packageDir, name);
    if (!installed) {
      // Fail loudly: a notice generated from a half-installed tree would be a
      // notice that quietly omits whatever was missing.
      throw new Error(
        `[bundle-content] ${manifest.name} declares "${name}" but it is not installed — run npm install before packing`,
      );
    }
    const depManifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    const licenceFile = fs
      .readdirSync(installed, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()[0];
    const licence = typeof depManifest.license === 'string' ? depManifest.license : undefined;
    if (!licence && !licenceFile) {
      throw new Error(
        `[bundle-content] ${name}@${depManifest.version} declares no licence and ships no licence file — it cannot be redistributed until that is resolved`,
      );
    }
    return {
      name,
      version: depManifest.version ?? 'unknown',
      licence: licence ?? 'see licence text',
      text: licenceFile ? fs.readFileSync(path.join(installed, licenceFile), 'utf8').trimEnd() : undefined,
    };
  });
}

/** Fence licence text so a stray ``` inside it cannot break out of the block. */
function fence(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${text}\n${ticks}`;
}

/** Render the notice. Pure, so the check can re-render and compare byte for byte. */
export function renderThirdPartyNotice({ packageName, licensedContent, dependencies }) {
  const lines = [
    `# Third-party notices — ${packageName}`,
    '',
    'GENERATED FILE — do not edit. `scripts/bundle-content.mjs` regenerates it from',
    'what this package actually ships, and a test fails when the file and the shipped',
    'content disagree. Anything added by hand is lost on the next build.',
    '',
    'This package redistributes the material below. Each entry reproduces its licence',
    'verbatim.',
    '',
    '## Bundled content',
    '',
  ];

  if (licensedContent.length === 0) {
    lines.push('No third-party content is bundled with this package.', '');
  } else {
    for (const item of licensedContent) {
      lines.push(`### ${item.subject}`, '', `Licence: \`${item.licenceFile}\``, '', fence(item.text), '');
    }
  }

  lines.push('## Dependencies', '');
  if (dependencies.length === 0) {
    lines.push('This package declares no third-party runtime dependencies.', '');
  } else {
    for (const dep of dependencies) {
      lines.push(`### ${dep.name}@${dep.version} — ${dep.licence}`, '');
      if (dep.text) lines.push(fence(dep.text), '');
      else lines.push('The package ships no licence file; the identifier above is its own declaration.', '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Build the notice for a package from what is on disk right now. */
export function buildThirdPartyNotice(packageDir, contentDirs) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  return renderThirdPartyNotice({
    packageName: manifest.name,
    licensedContent: listLicensedContent(packageDir, contentDirs),
    dependencies: listDependencyNotices(packageDir),
  });
}

export function writeThirdPartyNotice(packageDir, contentDirs) {
  const notice = buildThirdPartyNotice(packageDir, contentDirs);
  fs.writeFileSync(path.join(packageDir, THIRD_PARTY_NOTICE_FILE), notice, 'utf8');
  return notice;
}

/**
 * Generate a package's shipped skills and its notice. Idempotent: the whole
 * directory is replaced, so this is safe to run on every build.
 */
export function bundleSkills(packageDir, { libraryRoot = SKILLS_LIBRARY, contentDirs = ['skills'] } = {}) {
  if (!fs.existsSync(libraryRoot)) {
    throw new Error(`[bundle-content] skill library not found at ${libraryRoot}`);
  }
  const copied = syncContentDir(libraryRoot, path.join(packageDir, 'skills'));
  writeThirdPartyNotice(packageDir, contentDirs);
  return { copied };
}

/** Remove what `bundleSkills` generated, restoring the pre-pack working tree. */
export function cleanBundledSkills(packageDir) {
  fs.rmSync(path.join(packageDir, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(packageDir, THIRD_PARTY_NOTICE_FILE), { force: true });
}

/**
 * The teeth. Reports every way a package's shipped skills or notice disagree with
 * the library it claims to carry — a missing file, an extra file, an edited byte,
 * or a licence that landed in the package without reaching the notice.
 */
export function checkBundledSkills(packageDir, { libraryRoot = SKILLS_LIBRARY, contentDirs = ['skills'] } = {}) {
  const problems = [];
  const shippedRoot = path.join(packageDir, 'skills');
  if (!fs.existsSync(shippedRoot)) {
    problems.push('skills/ is missing — run the package build');
    return problems;
  }

  const source = listContentFiles(libraryRoot);
  const shipped = new Set(listContentFiles(shippedRoot));
  for (const rel of source) {
    if (!shipped.has(rel)) {
      problems.push(`skills/${rel} is missing from the package`);
      continue;
    }
    shipped.delete(rel);
    const a = fs.readFileSync(path.join(libraryRoot, rel));
    const b = fs.readFileSync(path.join(shippedRoot, rel));
    if (!a.equals(b)) problems.push(`skills/${rel} differs from the library`);
  }
  for (const rel of shipped) problems.push(`skills/${rel} is in the package but not in the library`);

  const noticePath = path.join(packageDir, THIRD_PARTY_NOTICE_FILE);
  if (!fs.existsSync(noticePath)) {
    problems.push(`${THIRD_PARTY_NOTICE_FILE} is missing`);
  } else if (fs.readFileSync(noticePath, 'utf8') !== buildThirdPartyNotice(packageDir, contentDirs)) {
    problems.push(`${THIRD_PARTY_NOTICE_FILE} no longer matches what the package ships`);
  }

  return problems;
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const packageIndex = argv.indexOf('--package');
  const packageDir = path.resolve(packageIndex === -1 ? process.cwd() : argv[packageIndex + 1]);
  const dirsIndex = argv.indexOf('--dirs');
  const contentDirs = dirsIndex === -1 ? ['skills'] : argv[dirsIndex + 1].split(',');
  const name = path.relative(REPO_ROOT, packageDir) || '.';

  if (argv.includes('--clean')) {
    cleanBundledSkills(packageDir);
    console.log(`[bundle-content] removed generated skills/ and ${THIRD_PARTY_NOTICE_FILE} from ${name}`);
    return 0;
  }

  if (argv.includes('--check')) {
    const problems = checkBundledSkills(packageDir, { contentDirs });
    if (problems.length === 0) {
      console.log(`[bundle-content] ${name} ships the library verbatim`);
      return 0;
    }
    for (const problem of problems) console.error(`[bundle-content] ${name}: ${problem}`);
    console.error(`[bundle-content] regenerate with: node scripts/bundle-content.mjs --package ${name}`);
    return 1;
  }

  const { copied } = bundleSkills(packageDir, { contentDirs });
  console.log(`[bundle-content] ${name}: ${copied} skill file(s) + ${THIRD_PARTY_NOTICE_FILE}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
