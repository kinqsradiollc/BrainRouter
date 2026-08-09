/**
 * ADR-033 D7 — mine review-corpus CANDIDATES from this repository's history.
 *
 * A later fix that changes a line introduced by a merged pull request is useful
 * evidence, but it is not semantic ground truth by itself: one fix can repair
 * several concepts and one concept can span several lines. This command writes
 * a separate candidate file for manual curation. It never overwrites the frozen
 * benchmark corpus.
 *
 * Before a candidate enters review-cases.json, a curator must split it into one
 * conceptual issue per entry, describe the actual failure, add semantic aliases,
 * verify every location in the reviewed revision, and add independently checked
 * clean controls.
 *
 *   npx tsx benchmark/review-harvest.ts [--since=<git date>] [--max-candidates=40]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const OUTPUT = join(HERE, "data", "review-candidates.json");

interface CandidateLocation {
  file: string;
  line: number;
}

interface ReviewBenchmarkCandidate {
  id: string;
  pr: number;
  reviewedSha: string;
  pullRequestTitle: string;
  fixedBySha: string;
  fixTitle: string;
  locations: CandidateLocation[];
  needsManualCuration: true;
}

interface ReviewBenchmarkCandidateDataset {
  schemaVersion: 1;
  generatedAt: string;
  warning: string;
  requiredCuration: string[];
  candidates: ReviewBenchmarkCandidate[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const REVIEWABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs|sql)$/i;
const TEST_FILE = /(^|\/)(__tests__|__test__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py|rb)$/i;

/** Parent-revision line numbers replaced by a fix commit. */
function replacedLines(sha: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const diff = git(["show", "--unified=0", "--no-color", "--format=", sha]);
  let path: string | null = null;
  let oldLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      path = REVIEWABLE.test(header[1]) && !TEST_FILE.test(header[1]) ? header[1] : null;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      out.set(path, [...(out.get(path) ?? []), oldLine]);
      oldLine += 1;
    } else if (!raw.startsWith("+")) {
      oldLine += 1;
    }
  }
  return out;
}

interface BlamedOrigin {
  sha: string;
  line: number;
  path: string;
}

/** Locate the changed source line in the commit that originally introduced it. */
function blame(sha: string, path: string, line: number): BlamedOrigin | null {
  try {
    const output = git(["blame", "--porcelain", "-C", "-L", `${line},${line}`, `${sha}^`, "--", path]);
    const header = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)/.exec(output);
    if (!header) return null;
    const filename = /^filename (.+)$/m.exec(output)?.[1]?.trim();
    return { sha: header[1], line: Number(header[2]), path: filename || path };
  } catch {
    return null;
  }
}

function existsAt(sha: string, path: string): boolean {
  try {
    git(["cat-file", "-e", `${sha}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

function subjectOf(sha: string): string {
  try {
    return git(["log", "-1", "--format=%s", sha]).trim();
  } catch {
    return "";
  }
}

function integerArgument(args: readonly string[], name: string, fallback: number): number {
  const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`--${name} must be an integer between 1 and 500.`);
  }
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const since = args.find((arg) => arg.startsWith("--since="))?.slice(8) ?? "12 months ago";
  const maxCandidates = integerArgument(args, "max-candidates", 40);
  const fixes = git([
    "log", `--since=${since}`, "--format=%H", "--extended-regexp", "--grep=^fix(\\(|:)",
  ]).split("\n").filter(Boolean);

  const candidates = new Map<string, ReviewBenchmarkCandidate>();
  for (const fix of fixes) {
    const fixTitle = subjectOf(fix);
    for (const [path, lines] of replacedLines(fix)) {
      for (const line of [...new Set(lines)].slice(0, 20)) {
        const origin = blame(fix, path, line);
        if (!origin) continue;
        const pullRequestTitle = subjectOf(origin.sha);
        const pr = Number(/\(#(\d+)\)\s*$/.exec(pullRequestTitle)?.[1] ?? 0);
        if (!pr || !REVIEWABLE.test(origin.path) || TEST_FILE.test(origin.path)) continue;
        if (!existsAt(origin.sha, origin.path)) continue;

        const key = `${pr}:${origin.sha}:${fix}`;
        const candidate = candidates.get(key) ?? {
          id: `candidate-pr-${pr}-${fix.slice(0, 12)}`,
          pr,
          reviewedSha: origin.sha,
          pullRequestTitle,
          fixedBySha: fix,
          fixTitle,
          locations: [],
          needsManualCuration: true,
        };
        if (!candidate.locations.some(
          (location) => location.file === origin.path && Math.abs(location.line - origin.line) <= 3,
        )) {
          candidate.locations.push({ file: origin.path, line: origin.line });
        }
        candidates.set(key, candidate);
      }
    }
    if (candidates.size >= maxCandidates) break;
  }

  const selected = [...candidates.values()]
    .sort((left, right) => right.pr - left.pr || left.fixedBySha.localeCompare(right.fixedBySha))
    .slice(0, maxCandidates);
  const dataset: ReviewBenchmarkCandidateDataset = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    warning: "Candidates are history-mined evidence, not benchmark ground truth. Do not score against this file.",
    requiredCuration: [
      "Split each candidate so every issue represents exactly one conceptual defect.",
      "Verify the failure description and every eligible location in the reviewed revision.",
      "Add at least two discriminating semantic requirement groups with reviewed aliases.",
      "Add separately reviewed clean pull requests as negative controls.",
      "Freeze the curated result in review-cases.json and review it as data.",
    ],
    candidates: selected,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  process.stdout.write(`${selected.length} uncurated candidate(s) -> ${OUTPUT}\n`);
}

main();
