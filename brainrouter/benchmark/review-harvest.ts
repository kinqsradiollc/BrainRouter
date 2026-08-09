/**
 * ADR-033 D7 — build the review benchmark's ground truth from OUR OWN history.
 *
 * For every `fix(...)` commit in the window, take the lines it changed, blame
 * their previous state, and keep the ones whose blame lands on a commit that
 * merged a numbered pull request. That pairing — "PR #N introduced this line,
 * and a later fix commit had to change it" — is a defect location we know was
 * real, because we fixed it.
 *
 * The result is written to `benchmark/data/review-cases.json` and committed, so
 * the benchmark is a frozen set two reviewer versions can be compared on rather
 * than a moving target. Re-run it to grow the set; the bias statement it writes
 * into the file is part of the data (see `reviewBenchmark.ts`).
 *
 *   npx tsx benchmark/review-harvest.ts [--since=<git date>] [--max-cases=40]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReviewBenchmarkCase,
  ReviewBenchmarkDataset,
  ReviewBenchmarkDefect,
} from "../src/reviews/benchmark/reviewBenchmark.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const OUTPUT = join(HERE, "data", "review-cases.json");

const GROUND_TRUTH_BIAS =
  "Defect locations are lines that a later fix(...) commit changed, blamed back to the merged pull request that introduced them. "
  + "This covers only defects we noticed, only those fixed as their own commit, and is therefore biased toward what our review and tests already catch. "
  + "Compare two reviewer versions on this frozen set; do not read the absolute numbers as a bug-finding rate.";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const REVIEWABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs|sql)$/i;
/**
 * Test files are excluded from DEFECT locations on purpose: a fix commit that
 * edits an assertion is usually recording the behaviour change, not the bug, so
 * counting those lines as defects the reviewer "missed" would depress recall
 * with cases that were never a defect. Tests are still reviewed — they are just
 * not ground truth.
 */
const TEST_FILE = /(^|\/)(__tests__|__test__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py|rb)$/i;

/** New-side line numbers a commit REPLACED (its `-` lines, in the parent). */
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
    }
  }
  return out;
}

/** Where a line came from: the commit that introduced it, and where it sat THERE. */
interface BlamedOrigin {
  sha: string;
  /** Line number in `sha`'s own revision — NOT in the revision blame was run on. */
  line: number;
  /** Path in `sha`'s own revision; differs from the queried path across a rename. */
  path: string;
}

/**
 * Blame `path:line` as of just before `sha`, in PORCELAIN form.
 *
 * Porcelain is not a stylistic preference — it is the only format that reports
 * the line's number and filename IN THE BLAMED COMMIT. The first version
 * recorded the line number from the fix commit's parent instead, which is a
 * different revision from the pull request being reviewed: every commit that
 * touched the file in between shifted it. Measured over the harvested set, a
 * third of the defects landed more than the scorer's tolerance away from where
 * the same source line actually sits in the reviewed revision — so a perfectly
 * positioned finding scored as "not on the right line", and the number ADR-033
 * §6 says the reviewer is judged on was measuring drift in the ground truth.
 */
function blame(sha: string, path: string, line: number): BlamedOrigin | null {
  try {
    // `-C` follows content across a rename so the recorded path is the one the
    // reviewed revision actually has — the other source of unfindable defects.
    const output = git(["blame", "--porcelain", "-C", "-L", `${line},${line}`, `${sha}^`, "--", path]);
    const header = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)/.exec(output);
    if (!header) return null;
    const filename = /^filename (.+)$/m.exec(output)?.[1]?.trim();
    return { sha: header[1], line: Number(header[2]), path: filename || path };
  } catch {
    return null; // the file did not exist in the parent, or blame refused
  }
}

/** Does `path` exist at `sha`? Ground truth nobody can look at is not truth. */
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

function main(): void {
  const args = process.argv.slice(2);
  const since = args.find((arg) => arg.startsWith("--since="))?.slice(8) ?? "12 months ago";
  const maxCases = Number(args.find((arg) => arg.startsWith("--max-cases="))?.slice(12) ?? 40);

  const fixes = git([
    "log", `--since=${since}`, "--format=%H", "--extended-regexp", "--grep=^fix(\\(|:)",
  ]).split("\n").filter(Boolean);

  const byPr = new Map<number, { sha: string; title: string; defects: ReviewBenchmarkDefect[] }>();
  for (const fix of fixes) {
    const fixSubject = subjectOf(fix);
    for (const [path, lines] of replacedLines(fix)) {
      for (const line of [...new Set(lines)].slice(0, 5)) {
        const origin = blame(fix, path, line);
        if (!origin) continue;
        const subject = subjectOf(origin.sha);
        const pr = Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? 0);
        if (!pr) continue; // not a merged pull request; nothing to review against
        // Re-apply the source filter to the BLAMED path: `-C` may have followed
        // the content back into a file the fix commit's own path never named.
        if (!REVIEWABLE.test(origin.path) || TEST_FILE.test(origin.path)) continue;
        // A defect the reviewed revision does not contain can never be found,
        // and it depresses recall permanently. Drop it rather than ship it.
        if (!existsAt(origin.sha, origin.path)) continue;
        const entry = byPr.get(pr) ?? { sha: origin.sha, title: subject, defects: [] };
        if (entry.defects.some(
          (defect) => defect.file === origin.path && Math.abs(defect.line - origin.line) <= 3,
        )) continue;
        entry.defects.push({
          file: origin.path,
          line: origin.line,
          description: fixSubject,
          fixedBy: fix.slice(0, 12),
        });
        byPr.set(pr, entry);
      }
    }
    if (byPr.size >= maxCases) break;
  }

  const cases: ReviewBenchmarkCase[] = [...byPr.entries()]
    .sort(([left], [right]) => right - left)
    .slice(0, maxCases)
    .map(([pr, entry]) => ({
      id: `pr-${pr}`,
      pr,
      sha: entry.sha,
      title: entry.title,
      defects: entry.defects.slice(0, 10),
    }));

  const dataset: ReviewBenchmarkDataset = {
    generatedAt: new Date().toISOString(),
    groundTruthBias: GROUND_TRUTH_BIAS,
    cases,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${cases.length} case(s), ${cases.reduce((sum, item) => sum + item.defects.length, 0)} known defect location(s) → ${OUTPUT}\n`,
  );
}

main();
