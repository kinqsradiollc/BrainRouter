/**
 * ADR-056 D-B8 — the bot runs the static design detector on changed UI files.
 *
 * For a pull request, the diff's UI files are read AT THE EXACT HEAD SHA
 * (contents API, never the working tree), together with the workspace's
 * `design.md` tokens and `.brainrouter/design-detector.json` suppressions at
 * that same revision, and run through the deterministic detector from core.
 * The result is an evidence block: advisory, never gating, zero model cost.
 * Findings carry the rule id in their title and the line in their location,
 * which is what the review store dedupes on across re-runs.
 */
import {
  detectDesign,
  parseDesignTokens,
  parseDesignSuppressions,
  type DesignFinding,
  type DesignInputFile,
} from '@kinqs/brainrouter-core/design';
import { readRepoTextAtRef } from './repoContents.js';

export const STATIC_DESIGN_PRODUCER = 'design-static';
const UI_FILE = /\.(html?|xhtml|svelte|vue|jsx|tsx|astro|mdx|css|scss|less)$/i;
const LIMITS = { files: 25, fileBytes: 256 * 1024, findings: 60 } as const;
const DESIGN_MD_PATHS = ['design.md', '.brainrouter/design.md', 'docs/design.md'];
const SUPPRESSIONS_PATH = '.brainrouter/design-detector.json';

export interface StaticDesignFinding {
  file: string;
  line?: number;
  severity: 'low' | 'info';
  title: string;
  producer: typeof STATIC_DESIGN_PRODUCER;
  advisory: true;
  rule: string;
}

export interface StaticDesignEvidence {
  producer: typeof STATIC_DESIGN_PRODUCER;
  catalogVersion: string;
  /** UI files in the diff that were read at head. */
  files: number;
  /** UI files in the diff that could not be read at head (deleted, too large, API miss). */
  skipped: string[];
  findings: StaticDesignFinding[];
  suppressed: Array<{ rule: string; file: string; reason: string }>;
  /** True when the finding list was cut at the bound. */
  truncated: boolean;
}

export interface CollectStaticDesignEvidenceInput {
  fetchImpl: typeof fetch;
  apiBase: string;
  repo: string;
  headSha: string;
  headers: Record<string, string>;
  changedPaths: readonly string[];
}

async function readAtHead(input: CollectStaticDesignEvidenceInput, path: string): Promise<string | null> {
  return readRepoTextAtRef({ fetchImpl: input.fetchImpl, apiBase: input.apiBase, repo: input.repo, ref: input.headSha, headers: input.headers }, path, LIMITS.fileBytes);
}

function toFinding(f: DesignFinding): StaticDesignFinding {
  return {
    file: f.file,
    ...(f.line ? { line: f.line } : {}),
    severity: f.severity === 'error' ? 'low' : 'info',
    title: `Design: ${f.rule} — ${f.message}`.slice(0, 200),
    producer: STATIC_DESIGN_PRODUCER,
    advisory: true,
    rule: f.rule,
  };
}

/**
 * Null when the diff touches no UI file (nothing to say); otherwise the
 * evidence, even when every file was unreadable (the block then says so).
 */
export async function collectStaticDesignEvidence(input: CollectStaticDesignEvidenceInput): Promise<StaticDesignEvidence | null> {
  const uiPaths = [...new Set(input.changedPaths.filter((p) => UI_FILE.test(p)))].slice(0, LIMITS.files);
  if (!uiPaths.length) return null;
  const files: DesignInputFile[] = [];
  const skipped: string[] = [];
  for (const path of uiPaths) {
    const content = await readAtHead(input, path);
    if (content === null) skipped.push(path); else files.push({ path, content });
  }
  let tokens = null;
  for (const p of DESIGN_MD_PATHS) {
    const md = await readAtHead(input, p);
    if (md) { tokens = parseDesignTokens(md, p); break; }
  }
  const rawSuppressions = await readAtHead(input, SUPPRESSIONS_PATH);
  let suppressions;
  try { suppressions = rawSuppressions ? parseDesignSuppressions(JSON.parse(rawSuppressions)) : undefined; } catch { suppressions = undefined; }
  const result = detectDesign(files, { ...(tokens ? { tokens } : {}), ...(suppressions ? { suppressions } : {}) });
  const counted = result.findings.filter((f) => !f.advisory);
  return {
    producer: STATIC_DESIGN_PRODUCER,
    catalogVersion: result.catalogVersion,
    files: files.length,
    skipped,
    findings: counted.slice(0, LIMITS.findings).map(toFinding),
    suppressed: result.suppressed.map((s) => ({ rule: s.rule, file: s.file, reason: s.reason })),
    truncated: counted.length > LIMITS.findings,
  };
}

/** One line for the check-run summary. */
export function staticDesignSummaryLine(evidence: StaticDesignEvidence): string {
  const parts = [`Design (static, advisory): ${evidence.findings.length} finding(s) over ${evidence.files} UI file(s)`];
  if (evidence.suppressed.length) parts.push(`${evidence.suppressed.length} suppressed (${evidence.suppressed.slice(0, 3).map((s) => `${s.rule}@${s.file} — ${s.reason}`).join('; ')}${evidence.suppressed.length > 3 ? '; …' : ''})`);
  if (evidence.skipped.length) parts.push(`${evidence.skipped.length} unread at head`);
  return parts.join(' · ');
}

/** The Markdown block appended to the pinned summary comment. */
export function staticDesignSummaryNote(evidence: StaticDesignEvidence): string {
  const lines = ['', '---', `**Static design evidence** (advisory, deterministic, catalog ${evidence.catalogVersion}) — ${staticDesignSummaryLine(evidence)}.`];
  for (const f of evidence.findings.slice(0, 12)) lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${f.title.replace(/^Design: /, '')}`);
  if (evidence.findings.length > 12) lines.push(`- … ${evidence.findings.length - 12} more in the Review Console`);
  return lines.join('\n');
}
