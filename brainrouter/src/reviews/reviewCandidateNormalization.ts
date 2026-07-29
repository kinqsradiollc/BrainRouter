/**
 * Deterministic normalization of model review output into assurance candidates.
 *
 * Model assertions remain candidate-only and evidence-free here. A later
 * independent verifier may attach exact-revision evidence and disposition them;
 * normalization itself never grants publication or blocking authority.
 */

import { findingFingerprint } from "@kinqs/brainrouter-core/review";
import type {
  AssuranceFinding,
  AssuranceSeverity,
  RepositoryAssuranceRun,
} from "@kinqs/brainrouter-types/review";
import { isSafeRepositoryRelativePath } from "./repositoryContextAssurance.js";

export interface ReviewCandidateProjection {
  file: string;
  line?: number;
  endLine?: number;
  severity: string;
  confidence?: number;
  title: string;
  details?: string;
  suggestion?: string;
  cwe?: string;
}

export interface NormalizeReviewCandidatesInput {
  run: RepositoryAssuranceRun;
  findings: ReviewCandidateProjection[];
  now: string;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : undefined;
}

function severity(value: string): AssuranceSeverity {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "critical" || normalized === "high"
    || normalized === "medium" || normalized === "low" || normalized === "info") {
    return normalized;
  }
  if (normalized === "security") return "high";
  if (normalized === "bug" || normalized === "warn") return "medium";
  if (normalized === "perf") return "low";
  return "info";
}

function confidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.7;
  const ratio = value <= 1 ? value : value / 100;
  return Math.max(0, Math.min(1, ratio));
}

function positiveLine(value: number | undefined): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function normalizedCwe(value: string | undefined, title: string): string | undefined {
  const match = /\bCWE-(\d+)\b/i.exec(String(value ?? title));
  return match ? `CWE-${match[1]}` : undefined;
}

export function normalizeReviewCandidates(
  input: NormalizeReviewCandidatesInput,
): AssuranceFinding[] {
  const candidates = new Map<string, AssuranceFinding>();
  for (const raw of input.findings.slice(0, 500)) {
    const path = bounded(raw.file, 1_024);
    const title = bounded(raw.title, 500);
    if (!path || !title || !isSafeRepositoryRelativePath(path)) continue;
    const line = positiveLine(raw.line);
    const rawEndLine = positiveLine(raw.endLine);
    const endLine = rawEndLine && rawEndLine >= (line ?? 1) ? rawEndLine : undefined;
    const cwe = normalizedCwe(raw.cwe, title);
    const remediation = bounded(raw.suggestion, 4_000);
    const fingerprint = findingFingerprint(input.run.program, {
      file: path,
      ...(line ? { line } : {}),
      ...(endLine ? { endLine } : {}),
      severity: raw.severity,
      title,
      ...(cwe ? { cwe } : {}),
    });
    if (candidates.has(fingerprint)) continue;
    candidates.set(fingerprint, {
      id: `finding:${input.run.id}:${fingerprint}`,
      fingerprint,
      program: input.run.program,
      revisionSha: input.run.revision.headSha,
      state: "candidate",
      severity: severity(raw.severity),
      confidence: confidence(raw.confidence),
      title,
      mechanism: bounded(raw.details, 4_000) ?? title,
      location: {
        path,
        ...(line ? { line } : {}),
        ...(endLine ? { endLine } : {}),
      },
      evidence: [],
      provenance: [{
        producerKind: "model",
        producerId: "llm-diff-review",
        policyHash: input.run.policySnapshot.policyHash,
        createdAt: input.now,
      }],
      coverageLimitations: input.run.coverage.limitations.slice(0, 128),
      ...(cwe ? { cwe } : {}),
      ...(remediation ? { remediation } : {}),
      createdAt: input.run.createdAt,
      updatedAt: input.now,
    });
  }
  return [...candidates.values()];
}
