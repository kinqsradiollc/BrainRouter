import fs from 'node:fs';
import path from 'node:path';

function safeDeclaredEntry(entry) {
  if (typeof entry !== 'string' || !entry.trim() || entry.startsWith('!')) return null;
  const normalized = path.normalize(entry);
  if (
    path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
    || /[*?[\]{}]/.test(normalized)
  ) {
    throw new Error(`Unsupported workspace package files entry: ${entry}`);
  }
  return normalized;
}

export function declaredPackageEntries(packageJson) {
  const files = Array.isArray(packageJson?.files) ? packageJson.files : ['dist'];
  return [...new Set(files.map(safeDeclaredEntry).filter(Boolean))];
}

function assertContainedSource(source, sourceRoot) {
  const realSource = fs.realpathSync(source);
  const relative = path.relative(sourceRoot, realSource);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Workspace package runtime entry escapes its package: ${source}`);
  }
}

export function copyDeclaredPackageFiles(sourceDir, destinationDir, packageJson) {
  const copied = [];
  const sourceRoot = fs.realpathSync(sourceDir);
  for (const entry of declaredPackageEntries(packageJson)) {
    const source = path.join(sourceDir, entry);
    if (!fs.existsSync(source)) {
      throw new Error(`Workspace package declares missing runtime entry: ${source}`);
    }
    assertContainedSource(source, sourceRoot);
    const destination = path.join(destinationDir, entry);
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.cpSync(source, destination, {
        recursive: true,
        dereference: true,
        filter: (nestedSource) => {
          assertContainedSource(nestedSource, sourceRoot);
          return true;
        },
      });
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } else {
      throw new Error(`Workspace package runtime entry is not a file or directory: ${source}`);
    }
    copied.push(entry);
  }
  return copied;
}
