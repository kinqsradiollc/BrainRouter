/**
 * CC-P8.1 — behavior-suite runner: score recorded CLI session transcripts.
 *
 * Reads one or more `transcript.jsonl` files (a single file, or a directory
 * scanned recursively) — i.e. the CLI's own session state under
 * `<workspace>/.brainrouter/cli/sessions/...` — scores each session with the
 * pure metrics, and writes/prints the aggregate report. This is the BASELINE
 * path: record normal sessions, score them, commit the report; behavior PRs
 * re-run it and ship the delta.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  aggregateBehavior,
  formatBehaviorReport,
  scoreSession,
  type BehaviorTranscriptEntry,
} from './behaviorMetrics.js';

export interface BehaviorSuiteOptions {
  /** transcript.jsonl file OR a directory to scan recursively. */
  input: string;
  /** Optional output markdown path; printed to stdout regardless. */
  out?: string;
  title?: string;
}

export function findTranscripts(input: string): string[] {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'transcript.jsonl') found.push(p);
    }
  };
  walk(input);
  return found.sort();
}

export function parseTranscript(file: string): BehaviorTranscriptEntry[] {
  const out: BehaviorTranscriptEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as BehaviorTranscriptEntry); } catch { /* tolerate bad lines */ }
  }
  return out;
}

export async function runBehaviorSuite(opts: BehaviorSuiteOptions): Promise<string> {
  const files = findTranscripts(opts.input);
  if (files.length === 0) throw new Error(`No transcript.jsonl found under ${opts.input}`);
  const scores = files.map((f) => scoreSession(parseTranscript(f)));
  const report = formatBehaviorReport(aggregateBehavior(scores), {
    title: opts.title ?? `Agent behavior — ${files.length} session(s)`,
  });
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, report, 'utf-8');
  }
  return report;
}
