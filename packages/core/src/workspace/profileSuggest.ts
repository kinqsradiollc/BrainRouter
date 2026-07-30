/**
 * Deterministic workspace-profile suggestion (ADR-021) — shared by the CLI
 * `/init` wizard and the desktop add-workspace onboarding, so both surfaces
 * guess identically. Filesystem signals only, no LLM: the UI shows WHY it
 * guessed what it guessed, and the user always makes the actual choice.
 *
 * Ordered rules, first match wins; falls back to `custom` when nothing is
 * recognizable. Never throws — unreadable directories contribute no signal.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceProfileId } from './profiles.js';
import {
  DEFAULT_REPOSITORY_SCAN_LIMITS,
  REPOSITORY_SCAN_ROOT_MARKERS,
  type RepositoryScanSummary,
} from './repositoryScan.js';

export interface ProfileSuggestion {
  profile: WorkspaceProfileId;
  reasons: string[];
}

export function suggestWorkspaceProfile(workspaceRoot: string): ProfileSuggestion {
  const has = (rel: string): boolean => {
    try { return fs.existsSync(path.join(workspaceRoot, rel)); } catch { return false; }
  };
  const list = (rel = '.'): string[] => {
    try { return fs.readdirSync(path.join(workspaceRoot, rel)); } catch { return []; }
  };
  const rootEntries = list();
  const rootFiles = rootEntries.filter((name) => {
    try { return fs.statSync(path.join(workspaceRoot, name)).isFile(); } catch { return false; }
  });

  // Data science: notebooks are the strongest, least ambiguous signal.
  if (rootFiles.some((name) => name.endsWith('.ipynb')) || has('notebooks') || has('dvc.yaml')) {
    return { profile: 'data-science', reasons: ['notebooks / data-pipeline files present'] };
  }

  // Engineering: any mainstream build/manifest marker.
  const codeMarkers: Array<[string, string]> = [
    ['package.json', 'Node.js (`package.json`)'],
    ['go.mod', 'Go (`go.mod`)'],
    ['Cargo.toml', 'Rust (`Cargo.toml`)'],
    ['pyproject.toml', 'Python (`pyproject.toml`)'],
    ['setup.py', 'Python (`setup.py`)'],
    ['pom.xml', 'Java (`pom.xml`)'],
    ['build.gradle', 'Gradle (`build.gradle`)'],
    ['CMakeLists.txt', 'C/C++ (`CMakeLists.txt`)'],
  ];
  const codeHits = codeMarkers.filter(([marker]) => has(marker)).map(([, label]) => label);
  if (has('src') && codeHits.length === 0) codeHits.push('source tree (`src/`)');
  if (codeHits.length > 0) return { profile: 'engineering', reasons: codeHits };

  // Research: bibliography / paper conventions.
  if (rootFiles.some((name) => name.endsWith('.bib')) || has('papers') || has('references')) {
    return { profile: 'research', reasons: ['bibliography / papers present'] };
  }

  // Writing: a markdown-dominant tree with no code signals.
  const mdCount = rootFiles.filter((name) => name.endsWith('.md')).length;
  if (mdCount >= 3) return { profile: 'writing', reasons: [`markdown-dominant (${mdCount} .md files, no code markers)`] };

  return { profile: 'custom', reasons: ['no recognizable signals — starting empty'] };
}

/**
 * The assisted path must not perform a second unbounded filesystem pass after
 * its scanner. Apply the same ordered profile rules to the bounded summary.
 */
export function suggestWorkspaceProfileFromScan(scan: RepositoryScanSummary): ProfileSuggestion {
  // Keep this public pure helper bounded even if a non-scanner caller supplies
  // a structurally valid but oversized summary.
  const paths = scan.files
    .slice(0, DEFAULT_REPOSITORY_SCAN_LIMITS.maxFiles)
    .map((file) => file.path);
  const rootFiles = paths.filter((filePath) => !filePath.includes('/'));
  const directories = Array.isArray(scan.directories)
    ? scan.directories.slice(0, DEFAULT_REPOSITORY_SCAN_LIMITS.maxEntries)
    : [];
  const markers = new Set(scan.markers.slice(0, REPOSITORY_SCAN_ROOT_MARKERS.length));
  const hasPath = (candidate: string): boolean => markers.has(candidate) || paths.includes(candidate);
  const hasDirectory = (candidate: string): boolean =>
    directories.includes(candidate) || paths.some((filePath) => filePath.startsWith(`${candidate}/`));

  if (rootFiles.some((filePath) => filePath.endsWith('.ipynb')) ||
      hasDirectory('notebooks') || hasPath('dvc.yaml')) {
    return { profile: 'data-science', reasons: ['notebooks / data-pipeline files present'] };
  }

  const codeMarkers: Array<[string, string]> = [
    ['package.json', 'Node.js (`package.json`)'],
    ['go.mod', 'Go (`go.mod`)'],
    ['Cargo.toml', 'Rust (`Cargo.toml`)'],
    ['pyproject.toml', 'Python (`pyproject.toml`)'],
    ['setup.py', 'Python (`setup.py`)'],
    ['pom.xml', 'Java (`pom.xml`)'],
    ['build.gradle', 'Gradle (`build.gradle`)'],
    ['CMakeLists.txt', 'C/C++ (`CMakeLists.txt`)'],
  ];
  const codeHits = codeMarkers.filter(([marker]) => hasPath(marker)).map(([, label]) => label);
  if (hasDirectory('src') && codeHits.length === 0) codeHits.push('source tree (`src/`)');
  if (codeHits.length > 0) return { profile: 'engineering', reasons: codeHits };

  if (rootFiles.some((filePath) => filePath.endsWith('.bib')) ||
      hasDirectory('papers') || hasDirectory('references')) {
    return { profile: 'research', reasons: ['bibliography / papers present'] };
  }

  const mdCount = rootFiles.filter((filePath) => filePath.endsWith('.md')).length;
  if (mdCount >= 3) {
    return {
      profile: 'writing',
      reasons: [`markdown-dominant (${mdCount} .md files, no code markers)`],
    };
  }
  return { profile: 'custom', reasons: ['no recognizable signals — starting empty'] };
}
