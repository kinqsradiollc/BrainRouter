/**
 * Purpose: Enforce BrainRouter's package and host dependency direction from
 * source imports without requiring packages to be built first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.open-next',
  '.turbo',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
]);

const INTERNAL_PACKAGES = new Map([
  ['@kinqs/brainrouter-types', 'types'],
  ['@kinqs/brainrouter-agent-protocol', 'protocol'],
  ['@kinqs/brainrouter-core', 'core'],
  ['@kinqs/brainrouter-sdk', 'sdk'],
  ['@kinqs/brainrouter-hooks', 'hooks'],
  ['@kinqs/brainrouter-mcp-server', 'backend'],
  ['@kinqs/brainrouter-cli', 'cli'],
]);

const ALLOWED_INTERNAL_EDGES = new Map([
  ['types', new Set()],
  ['protocol', new Set()],
  ['core', new Set(['types', 'protocol'])],
  ['sdk', new Set(['types'])],
  ['hooks', new Set(['sdk', 'types'])],
  ['backend', new Set(['core', 'types'])],
  ['cli', new Set(['core', 'sdk', 'types'])],
  ['desktop-host', new Set(['core', 'protocol', 'types'])],
  ['desktop-renderer', new Set(['core', 'protocol', 'types'])],
  ['dashboard', new Set(['hooks', 'sdk', 'types'])],
]);

const SOURCE_AREAS = [
  { id: 'types', root: 'packages/types/src' },
  { id: 'protocol', root: 'packages/agent-protocol/src' },
  { id: 'core', root: 'packages/core/src' },
  { id: 'sdk', root: 'packages/sdk/src' },
  { id: 'hooks', root: 'packages/hooks/src' },
  { id: 'backend', root: 'brainrouter/src' },
  { id: 'cli', root: 'brainrouter-cli/src' },
  { id: 'desktop-host', root: 'brainrouter-desktop/electron' },
  { id: 'desktop-renderer', root: 'brainrouter-desktop/src' },
  { id: 'dashboard', root: 'brainrouter-dashboard' },
];

const PACKAGE_SOURCE_AREAS = new Set(['types', 'protocol', 'core', 'sdk', 'hooks']);
const APPLICATION_ROOTS = [
  'brainrouter/src',
  'brainrouter-cli/src',
  'brainrouter-desktop/electron',
  'brainrouter-desktop/src',
  'brainrouter-dashboard',
];

const MANIFEST_RULES = new Map([
  [
    'types',
    {
      path: 'packages/types/package.json',
      requiredInternalDependencies: [],
      requiredPeerDependencies: [],
    },
  ],
  [
    'protocol',
    {
      path: 'packages/agent-protocol/package.json',
      requiredInternalDependencies: [],
      requiredPeerDependencies: [],
    },
  ],
  [
    'core',
    {
      path: 'packages/core/package.json',
      requiredInternalDependencies: ['@kinqs/brainrouter-agent-protocol', '@kinqs/brainrouter-types'],
      requiredPeerDependencies: [],
    },
  ],
  [
    'sdk',
    {
      path: 'packages/sdk/package.json',
      requiredInternalDependencies: ['@kinqs/brainrouter-types'],
      requiredPeerDependencies: [],
    },
  ],
  [
    'hooks',
    {
      path: 'packages/hooks/package.json',
      requiredInternalDependencies: ['@kinqs/brainrouter-sdk', '@kinqs/brainrouter-types'],
      requiredPeerDependencies: ['react'],
    },
  ],
]);

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isTestFile(filePath) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function packageNameForSpecifier(specifier) {
  for (const packageName of INTERNAL_PACKAGES.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return packageName;
    }
  }
  return undefined;
}

export function collectModuleSpecifiers(sourceText, filePath = 'fixture.ts') {
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];

  function record(node) {
    if (node && ts.isStringLiteralLike(node)) {
      imports.push(node.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

export function loadBoundaryPolicy(repoRoot) {
  const corePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8'));
  const curatedCoreExports = new Set(
    Object.keys(corePackage.exports ?? {})
      .filter((exportPath) => !exportPath.includes('*'))
      .map((exportPath) => (exportPath === '.' ? '' : exportPath.slice(2))),
  );

  return {
    applicationRoots: APPLICATION_ROOTS.map((root) => path.join(repoRoot, root)),
    coreRouterCompatibilityRoot: path.join(repoRoot, 'packages/core/src/router'),
    curatedCoreExports,
    repoRoot,
  };
}

export function checkImport({ area, filePath, specifier, policy }) {
  const normalizedFile = normalizeRelative(path.relative(policy.repoRoot, filePath));
  const violation = (reason) => ({ area, file: normalizedFile, reason, specifier });
  const packageName = packageNameForSpecifier(specifier);

  if (packageName) {
    const target = INTERNAL_PACKAGES.get(packageName);
    if (target !== area && !ALLOWED_INTERNAL_EDGES.get(area)?.has(target)) {
      return violation(`${area} may not depend on ${target}`);
    }

    if (packageName === '@kinqs/brainrouter-core' && specifier !== packageName) {
      const subpath = specifier.slice(`${packageName}/`.length);
      if (subpath === 'router' || subpath.startsWith('router/')) {
        return violation('maintained consumers use the provider surface; router is an external compatibility façade');
      }
      if (subpath.startsWith('dist/')) {
        if (area !== 'desktop-renderer') {
          return violation('compiled Core internals are restricted to the Desktop renderer compatibility exception');
        }
      } else if (!policy.curatedCoreExports.has(subpath)) {
        return violation(`Core subpath "${subpath}" is not a curated public export`);
      }
    }
  }

  if ((area === 'sdk' || area === 'hooks') && !isTestFile(filePath) && specifier.startsWith('node:')) {
    return violation(`${area} production code must remain browser-safe and may not import node:*`);
  }

  if (PACKAGE_SOURCE_AREAS.has(area) && (specifier.startsWith('.') || path.isAbsolute(specifier))) {
    const resolved = path.resolve(path.dirname(filePath), specifier);
    if (
      area === 'core'
      && isWithin(resolved, policy.coreRouterCompatibilityRoot)
      && !isWithin(filePath, policy.coreRouterCompatibilityRoot)
    ) {
      return violation('Core implementation imports provider/routing; router is a compatibility façade');
    }
    if (policy.applicationRoots.some((root) => isWithin(resolved, root))) {
      return violation('shared packages may not import application source');
    }
  }

  return undefined;
}

export function checkManifest(area, manifest, manifestPath = 'package.json') {
  const rule = MANIFEST_RULES.get(area);
  if (!rule) return [];
  const dependencies = manifest.dependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  const actualInternal = Object.keys(dependencies)
    .filter((name) => INTERNAL_PACKAGES.has(name))
    .sort();
  const expectedInternal = [...rule.requiredInternalDependencies].sort();
  const violations = [];
  const add = (reason) =>
    violations.push({
      area,
      file: normalizeRelative(manifestPath),
      reason,
      specifier: manifest.name ?? area,
    });

  if (JSON.stringify(actualInternal) !== JSON.stringify(expectedInternal)) {
    add(`internal dependencies must be exactly: ${expectedInternal.join(', ') || '(none)'}`);
  }
  for (const dependency of rule.requiredPeerDependencies) {
    if (!peerDependencies[dependency]) {
      add(`${dependency} must remain a peer dependency`);
    }
  }
  if ((area === 'types' || area === 'protocol') && Object.keys(dependencies).length > 0) {
    add(`${area} must remain dependency-free`);
  }
  return violations;
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(candidate);
    }
  }
  return files.sort();
}

function areaForFile(filePath, repoRoot) {
  const absolute = path.resolve(repoRoot, filePath);
  for (const area of SOURCE_AREAS) {
    if (isWithin(absolute, path.join(repoRoot, area.root))) return area.id;
  }
  return undefined;
}

export function checkRepositoryBoundaries(repoRoot, requestedFiles = undefined) {
  const policy = loadBoundaryPolicy(repoRoot);
  const candidates = requestedFiles
    ? requestedFiles
        .map((filePath) => path.resolve(repoRoot, filePath))
        .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)) && fs.existsSync(filePath))
    : SOURCE_AREAS.flatMap((area) => filesUnder(path.join(repoRoot, area.root)));
  const violations = [];

  for (const [area, rule] of MANIFEST_RULES) {
    const manifestPath = path.join(repoRoot, rule.path);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    violations.push(...checkManifest(area, manifest, path.relative(repoRoot, manifestPath)));
  }

  for (const filePath of [...new Set(candidates)].sort()) {
    const area = areaForFile(filePath, repoRoot);
    if (!area) continue;
    const sourceText = fs.readFileSync(filePath, 'utf8');
    for (const specifier of collectModuleSpecifiers(sourceText, filePath)) {
      const result = checkImport({ area, filePath, policy, specifier });
      if (result) violations.push(result);
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.specifier.localeCompare(right.specifier) ||
      left.reason.localeCompare(right.reason),
  );
}

function printViolations(violations) {
  if (violations.length === 0) {
    console.log('Package boundary check passed.');
    return;
  }
  console.error(`Package boundary check failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier} — ${violation.reason}`);
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fileFlag = process.argv.indexOf('--files');
  const requestedFiles = fileFlag === -1 ? undefined : process.argv.slice(fileFlag + 1);
  const violations = checkRepositoryBoundaries(repoRoot, requestedFiles);
  printViolations(violations);
  process.exitCode = violations.length === 0 ? 0 : 1;
}
