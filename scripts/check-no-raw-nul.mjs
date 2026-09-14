/**
 * Purpose: Reject a raw NUL byte (0x00) in any tracked text/source file.
 *
 * Why: several composite-key sentinels (`${a}\0${b}`, `parts.join('\0')`) had
 * been authored as a literal 0x00 byte inside the string instead of the `\0`
 * escape. The program is semantically identical, but the byte is invisible in
 * every editor and diff viewer, git shows the file as binary, and one such byte
 * later masqueraded as a missing space in a template string. A sentinel is
 * written as the escape sequence in source, never as the raw byte.
 *
 * Constraints: pure byte scan — no parsing, no dependency on a build. Runs over
 * `git ls-files` (CLI default, the `lint:nul` gate) or over an explicit
 * `--files …` list (the staged-files pre-commit hook). Binary assets are kept
 * out by an allow-list of text extensions, not a deny-list.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const CONTEXT_BYTES = 24;

export function isTextSourcePath(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Every 0x00 in `buffer` as `{ line, column, context }` (1-based, column in
 * bytes; context is the surrounding bytes with the NUL shown as `<NUL>`).
 */
export function findRawNulBytes(buffer) {
  const hits = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte === 0x0a) {
      line += 1;
      lineStart = i + 1;
      continue;
    }
    if (byte !== 0x00) continue;
    const before = buffer.subarray(Math.max(0, i - CONTEXT_BYTES), i).toString('latin1');
    const after = buffer.subarray(i + 1, i + 1 + CONTEXT_BYTES).toString('latin1');
    hits.push({
      line,
      column: i - lineStart + 1,
      context: `${before}<NUL>${after}`.replace(/\r?\n/g, '⏎'),
    });
  }
  return hits;
}

/** Tracked files under `repoRoot` with a text extension, repo-relative, sorted. */
export function listTrackedTextFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter((relativePath) => relativePath && isTextSourcePath(relativePath))
    .filter((relativePath) => {
      const absolute = path.join(repoRoot, relativePath);
      try {
        return fs.lstatSync(absolute).isFile();
      } catch {
        return false; // deleted in the work tree but still tracked
      }
    })
    .sort();
}

/**
 * Scan `relativePaths` (default: every tracked text file) and return one
 * violation per NUL byte: `{ file, line, column, context }`.
 */
export function checkNoRawNulBytes(repoRoot, relativePaths = listTrackedTextFiles(repoRoot)) {
  const violations = [];
  for (const relativePath of relativePaths) {
    if (!isTextSourcePath(relativePath)) continue;
    const absolute = path.resolve(repoRoot, relativePath);
    let buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      continue; // staged deletion / rename source — nothing to scan
    }
    for (const hit of findRawNulBytes(buffer)) {
      violations.push({ file: path.relative(repoRoot, absolute), ...hit });
    }
  }
  return violations;
}

export function formatViolation(violation) {
  return (
    `${violation.file}:${violation.line}:${violation.column} raw NUL byte (0x00) — ` +
    `write the sentinel as the \\0 escape, not a literal byte. Context: ${violation.context}`
  );
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fileFlag = process.argv.indexOf('--files');
  const requestedFiles = fileFlag === -1 ? undefined : process.argv.slice(fileFlag + 1);
  const violations = checkNoRawNulBytes(repoRoot, requestedFiles);
  for (const violation of violations) console.error(formatViolation(violation));
  if (violations.length > 0) {
    console.error(`check-no-raw-nul: ${violations.length} raw NUL byte(s) in tracked source.`);
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}
