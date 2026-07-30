/**
 * Filename, directory, binary, and ordering policy for repository scans.
 * Filesystem traversal and model-boundary credential detection live separately.
 */
import path from 'node:path';
import { REPOSITORY_SCAN_ROOT_MARKERS } from './types.js';

const IGNORED_DIRECTORIES = new Set([
  '.brainrouter',
  '.bundle',
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.idea',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.terraform',
  '.turbo',
  '.venv',
  '.vscode',
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'deps',
  'dist',
  'env',
  'node_modules',
  'obj',
  'out',
  'pods',
  'target',
  'third-party',
  'third_party',
  'vendor',
  'venv',
]);

const SENSITIVE_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.config',
  '.credentials',
  '.docker',
  '.gnupg',
  '.kube',
  '.secrets',
  '.ssh',
  'credentials',
  'secrets',
]);

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.avif',
  '.bin',
  '.bmp',
  '.class',
  '.db',
  '.dmg',
  '.doc',
  '.docx',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.o',
  '.otf',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.pyc',
  '.rar',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.tiff',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
]);

const ROOT_MARKER_RANK = new Map(REPOSITORY_SCAN_ROOT_MARKERS.map((marker, index) => [marker, index]));

export function isIgnoredRepositoryDirectory(name: string): boolean {
  const lowerName = name.toLowerCase();
  return IGNORED_DIRECTORIES.has(lowerName) || SENSITIVE_DIRECTORIES.has(lowerName);
}

export function isKnownBinaryRepositoryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function isSensitiveRepositoryFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.envrc' ||
      ((lower === '.env' || lower.endsWith('.env') || lower.includes('.env.')) &&
        !isEnvironmentTemplate(lower))) return true;
  if (lower.endsWith('.tfstate') || lower.endsWith('.tfstate.backup')) return true;
  if (['.git-credentials', '.netrc', '.npmrc', '.pypirc', 'auth.json'].includes(lower)) return true;
  if (/^(?:id_(?:dsa|ecdsa|ed25519|rsa))(?:\.|$)/.test(lower)) return true;
  if (/^(?:credentials?|secrets?)(?:[._-].*)?$/.test(lower)) return true;
  if (/^service[-_]account.*\.json$/.test(lower)) return true;
  return ['.jks', '.kdbx', '.key', '.keystore', '.mobileprovision', '.p12', '.pem', '.pfx'].includes(
    path.extname(lower),
  );
}

export function isProbablyBinaryRepositoryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 27) controlBytes += 1;
  }
  return controlBytes / buffer.length > 0.1;
}

export function compareRootRepositoryEntries(left: import('node:fs').Dirent, right: import('node:fs').Dirent): number {
  const leftRank = ROOT_MARKER_RANK.get(left.name);
  const rightRank = ROOT_MARKER_RANK.get(right.name);
  if (leftRank !== undefined || rightRank !== undefined) {
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return compareRepositoryStrings(left.name, right.name);
}

export function compareRepositoryDirents(left: import('node:fs').Dirent, right: import('node:fs').Dirent): number {
  return compareRepositoryStrings(left.name, right.name);
}

export function compareRepositoryStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isEnvironmentTemplate(name: string): boolean {
  return /(?:^|\.)env\.(?:example|sample|template)$/.test(name);
}
