/**
 * `critique` — two assessments that cannot see each other (ADR-056 D-B4).
 *
 * A design review (hierarchy, clarity, emotional resonance — heuristic scores)
 * and a deterministic evidence pass run apart: the review goes to an ISOLATED
 * seam the host provides (an ephemeral side agent in the CLI), and the detector
 * runs only after the review has ended, so deterministic findings never anchor
 * judgment. Synthesis — the turn the person sees — gets both, in that order,
 * and must end with the targeted questions. When the host has no seam the run
 * degrades to one sequential agent and its FIRST line says so. Every run
 * snapshots under `.brainrouter/design/critiques/<slug>/` so the next one can
 * show a trend. No model call happens in this module; it orchestrates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectDesign, type DesignFinding } from './detect/engine.js';
import { collectDesignFiles } from './detect/files.js';
import { readDesignSystemTokens } from './detect/designSystem.js';
import { readDesignSuppressions } from './detect/suppressions.js';
import { DESIGN_SKILL_ID, designVerbReference, type DesignModeId } from './vocabulary.js';

export const DESIGN_CRITIQUE_DIR = path.join('.brainrouter', 'design', 'critiques');
const MAX_EVIDENCE_LINES = 40;
const MAX_REVIEW_CHARS = 12_000;

export interface CritiqueScores { hierarchy: number; clarity: number; resonance: number }

/** The isolated seam: runs one prompt somewhere the main turn cannot see, returns the text. */
export interface CritiqueReviewSeam { run(prompt: string): Promise<string> }

export interface DesignCritiqueOptions {
  workspaceRoot: string;
  targets?: string[];
  mode?: DesignModeId;
  /** null/undefined = no seam available → degraded sequential run. */
  seam?: CritiqueReviewSeam | null;
  now?: () => Date;
}

export interface CritiqueSnapshot {
  version: 1;
  at: string;
  targets: string[];
  mode: DesignModeId | null;
  degraded: boolean;
  scores: CritiqueScores | null;
  evidence: { files: number; errors: number; warnings: number; findings: Array<{ rule: string; file: string; line?: number; severity: string }> };
}

export interface DesignCritiqueRun {
  degraded: boolean;
  slug: string;
  snapshotPath: string;
  review: { prompt: string; text: string; scores: CritiqueScores | null; startedAt: string; endedAt: string } | null;
  evidence: { startedAt: string; endedAt: string; files: number; errors: number; warnings: number; findings: DesignFinding[]; truncated: boolean };
  trend: string | null;
  /** What the synthesis turn starts from; first line is the degraded banner when degraded. */
  synthesisPrompt: string;
}

export function designCritiqueSlug(targets: string[]): string {
  const base = targets.length ? targets.join(' ') : 'workspace';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'workspace';
}

/** The review half's brief: the playbook, the mode, the target — and nothing from the detector. */
export function designCritiqueReviewPrompt(targets: string[], mode?: DesignModeId): string {
  return [
    `Design review — the REVIEW HALF of \`/design critique\` (the \`${DESIGN_SKILL_ID}\` skill, \`${designVerbReference('critique')}\`).`,
    `Target: ${targets.length ? targets.join(', ') : 'the UI files this workspace is about'}.`,
    mode ? `Mode: ${mode} — apply the defaults from \`references/modes.md\`.` : 'Infer the mode from the target (`references/modes.md`) and say which.',
    'Read product.md and design.md if they exist, look at the target as a user would, and write the fit verdict and the craft verdict (hierarchy, clarity, emotional resonance, rhythm, type, colour roles, states), each bullet anchored to a file and line range.',
    'Do not edit anything. Do not run any checker or detector — a separate pass does that after you finish.',
    'End with exactly one JSON line of heuristic scores from 1 to 10: {"hierarchy": n, "clarity": n, "resonance": n}',
  ].join('\n');
}

/** The last {...} object in the text that carries the three scores; null when there is none. */
export function parseCritiqueScores(text: string): CritiqueScores | null {
  const matches = text.match(/\{[^{}]*\}/g) ?? [];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]) as Record<string, unknown>;
      const pick = (k: string): number | null => { const v = Number(obj[k]); return Number.isFinite(v) && v >= 0 && v <= 10 ? v : null; };
      const h = pick('hierarchy'), c = pick('clarity'), r = pick('resonance');
      if (h !== null && c !== null && r !== null) return { hierarchy: h, clarity: c, resonance: r };
    } catch { /* not the scores line */ }
  }
  return null;
}

export function readDesignCritiqueSnapshots(workspaceRoot: string, slug: string): CritiqueSnapshot[] {
  const dir = path.join(workspaceRoot, DESIGN_CRITIQUE_DIR, slug);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out: CritiqueSnapshot[] = [];
  for (const n of names) {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as CritiqueSnapshot; if (s && s.version === 1) out.push(s); } catch { /* skip a bad snapshot */ }
  }
  return out;
}

function trendLine(prev: CritiqueSnapshot, cur: { scores: CritiqueScores | null; findings: number }): string {
  const parts: string[] = [`findings ${prev.evidence.findings.length} → ${cur.findings}`];
  if (prev.scores && cur.scores) {
    for (const k of ['hierarchy', 'clarity', 'resonance'] as const) parts.push(`${k} ${prev.scores[k]} → ${cur.scores[k]}`);
  }
  return `Trend vs ${prev.at}: ${parts.join(' · ')}`;
}

function evidenceLines(findings: DesignFinding[]): string[] {
  const counted = findings.filter((f) => !f.advisory);
  const lines = counted.slice(0, MAX_EVIDENCE_LINES).map((f) => `- ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}${f.snippet ? ` ${f.snippet}` : ''} — ${f.message}`);
  if (counted.length > MAX_EVIDENCE_LINES) lines.push(`- … ${counted.length - MAX_EVIDENCE_LINES} more (run design_detect for the full list)`);
  return lines.length ? lines : ['- no findings'];
}

/**
 * Run the orchestration. Never throws for a missing seam or a bad review; a
 * detector error surfaces as zero evidence with the reason in the prompt.
 */
export async function runDesignCritique(opts: DesignCritiqueOptions): Promise<DesignCritiqueRun> {
  const now = opts.now ?? (() => new Date());
  const targets = (opts.targets ?? []).filter(Boolean);
  const slug = designCritiqueSlug(targets);
  const degraded = !opts.seam;

  // 1. Review half — isolated, blind to the detector.
  let review: DesignCritiqueRun['review'] = null;
  if (opts.seam) {
    const prompt = designCritiqueReviewPrompt(targets, opts.mode);
    const startedAt = now().toISOString();
    let text = '';
    try { text = String(await opts.seam.run(prompt)); } catch (err) { text = `(the review pass failed: ${err instanceof Error ? err.message : String(err)})`; }
    if (text.length > MAX_REVIEW_CHARS) text = `${text.slice(0, MAX_REVIEW_CHARS)}\n… (review cut at ${MAX_REVIEW_CHARS} chars)`;
    review = { prompt, text, scores: parseCritiqueScores(text), startedAt, endedAt: new Date().toISOString() };
  }

  // 2. Evidence half — deterministic, strictly after the review ended.
  const evidenceStart = new Date();
  const collected = collectDesignFiles(opts.workspaceRoot, targets);
  const result = detectDesign(collected.files, { tokens: readDesignSystemTokens(opts.workspaceRoot), suppressions: readDesignSuppressions(opts.workspaceRoot) });
  const evidence = { startedAt: evidenceStart.toISOString(), endedAt: new Date().toISOString(), files: result.files, errors: result.errors, warnings: result.warnings, findings: result.findings, truncated: collected.truncated };

  // 3. Snapshot + trend.
  const previous = readDesignCritiqueSnapshots(opts.workspaceRoot, slug);
  const last = previous[previous.length - 1];
  const counted = result.findings.filter((f) => !f.advisory);
  const trend = last ? trendLine(last, { scores: review?.scores ?? null, findings: counted.length }) : null;
  const at = now().toISOString();
  const snapshot: CritiqueSnapshot = {
    version: 1, at, targets, mode: opts.mode ?? null, degraded, scores: review?.scores ?? null,
    evidence: { files: result.files, errors: result.errors, warnings: result.warnings, findings: counted.map((f) => ({ rule: f.rule, file: f.file, ...(f.line ? { line: f.line } : {}), severity: f.severity })) },
  };
  const snapshotPath = path.join(DESIGN_CRITIQUE_DIR, slug, `${at.replace(/[:.]/g, '-')}.json`);
  try {
    fs.mkdirSync(path.dirname(path.join(opts.workspaceRoot, snapshotPath)), { recursive: true });
    fs.writeFileSync(path.join(opts.workspaceRoot, snapshotPath), `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch { /* a snapshot that cannot be written must not fail the critique */ }

  // 4. What synthesis starts from.
  const head = degraded
    ? [
        'Degraded critique: no isolated subagent seam — the design review and the evidence pass run sequentially in this one agent.',
        `/design critique: run the \`critique\` verb of the \`${DESIGN_SKILL_ID}\` design skill (\`${designVerbReference('critique')}\`). Write the design review FIRST — fit and craft verdicts anchored to files and lines, ending with the scores line — and only then read the evidence below.`,
      ]
    : [
        `/design critique: synthesis step of the \`critique\` verb of the \`${DESIGN_SKILL_ID}\` design skill (\`${designVerbReference('critique')}\`). The two assessments below were produced apart; weigh the review on its own terms and use the evidence to verify, not to anchor.`,
      ];
  const lines = [
    ...head,
    `Target: ${targets.length ? targets.join(', ') : 'the workspace'}.${opts.mode ? ` Mode: ${opts.mode}.` : ''}`,
    ...(review ? ['', '## Design review (isolated subagent)', review.text.trim()] : []),
    '',
    `## Evidence (design_detect, ran after the review ended · ${evidence.files} file${evidence.files === 1 ? '' : 's'} · ${evidence.errors} error${evidence.errors === 1 ? '' : 's'}, ${evidence.warnings} warning${evidence.warnings === 1 ? '' : 's'}${collected.refused.length ? ` · skipped ${collected.refused.map((r) => r.path).join(', ')}` : ''})`,
    ...evidenceLines(result.findings),
    ...(trend ? ['', `## ${trend}`] : []),
    '',
    'Now: verify each finding in context (drop false positives with a reason), rank the top three fixes by user impact, say what you would leave alone and why, and END WITH THE TARGETED QUESTIONS for the owner — nothing after them. Edit nothing.',
  ];
  return { degraded, slug, snapshotPath, review, evidence, trend, synthesisPrompt: lines.join('\n') };
}
