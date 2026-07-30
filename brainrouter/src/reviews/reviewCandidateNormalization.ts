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
  AssuranceImpactPacketAssembly,
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

export interface NormalizeDeterministicCandidatesInput {
  run: RepositoryAssuranceRun;
  assembly: AssuranceImpactPacketAssembly;
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

function deterministicSeverity(run: RepositoryAssuranceRun): AssuranceSeverity {
  return run.program === "code_review" ? "medium" : "high";
}

function deterministicTitle(mechanism: string): string {
  return `Parser-identified source-to-sink ${mechanism.replaceAll("_", " ")}`;
}

function locationLabel(path: string, line: number | undefined): string {
  return line ? `${path}:${line}` : path;
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

export function normalizeDeterministicCandidates(
  input: NormalizeDeterministicCandidatesInput,
): AssuranceFinding[] {
  if (input.assembly.revisionSha !== input.run.revision.headSha) {
    throw new Error("Deterministic candidates must match the assurance run exact revision.");
  }
  const candidates = new Map<string, AssuranceFinding>();
  const limitations = [
    ...input.run.coverage.limitations,
    ...input.assembly.limitations,
  ].filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  ).slice(0, 128);

  packetLoop: for (const packet of input.assembly.packets.slice(0, 500)) {
    if (
      packet.revisionSha !== input.run.revision.headSha
      || packet.program !== input.run.program
    ) {
      throw new Error("Deterministic packet candidates must match the run program and revision.");
    }
    const evidenceById = new Map(packet.context.map((item) => [item.evidence.id, item.evidence]));
    for (const path of packet.sourceToSinkPaths) {
      if (
        !isSafeRepositoryRelativePath(path.source.path)
        || !isSafeRepositoryRelativePath(path.sink.path)
      ) {
        continue;
      }
      const evidence = path.evidenceRefs
        .map((id) => evidenceById.get(id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (
        evidence.length !== path.evidenceRefs.length
        || evidence.some((item) => item.revisionSha !== input.run.revision.headSha)
      ) {
        continue;
      }
      const title = deterministicTitle(path.mechanism);
      const fingerprint = findingFingerprint(input.run.program, {
        file: path.sink.path,
        ...(path.sink.line ? { line: path.sink.line } : {}),
        ...(path.sink.endLine ? { endLine: path.sink.endLine } : {}),
        severity: deterministicSeverity(input.run),
        title,
      });
      const existing = candidates.get(fingerprint);
      if (existing) {
        existing.evidence = [
          ...new Map(
            [...existing.evidence, ...evidence].map((item) => [item.id, item]),
          ).values(),
        ].slice(0, 256);
        existing.updatedAt = input.now;
        continue;
      }
      if (candidates.size >= 500) break packetLoop;
      candidates.set(fingerprint, {
        id: `finding:${input.run.id}:${fingerprint}`,
        fingerprint,
        program: input.run.program,
        revisionSha: input.run.revision.headSha,
        state: "candidate",
        severity: deterministicSeverity(input.run),
        confidence: 0.8,
        title,
        mechanism: [
          path.mechanism.replaceAll("_", " "),
          "from",
          locationLabel(path.source.path, path.source.line),
          "to",
          locationLabel(path.sink.path, path.sink.line),
        ].join(" ").slice(0, 4_000),
        location: { ...path.sink },
        evidence: evidence.slice(0, 256),
        provenance: [{
          producerKind: "deterministic_analyzer",
          producerId: "typescript-source-to-sink",
          version: "1",
          policyHash: input.run.policySnapshot.policyHash,
          createdAt: input.now,
        }],
        coverageLimitations: limitations,
        createdAt: input.run.createdAt,
        updatedAt: input.now,
      });
    }
  }
  return [...candidates.values()];
}

export function mergeAssuranceCandidates(
  findings: AssuranceFinding[],
): AssuranceFinding[] {
  const merged = new Map<string, AssuranceFinding>();
  for (const finding of findings) {
    const existing = merged.get(finding.fingerprint);
    if (!existing) {
      if (merged.size >= 500) break;
      merged.set(finding.fingerprint, structuredClone(finding));
      continue;
    }
    existing.confidence = Math.max(existing.confidence, finding.confidence);
    existing.evidence = [
      ...new Map(
        [...existing.evidence, ...finding.evidence].map((item) => [item.id, item]),
      ).values(),
    ].slice(0, 256);
    existing.provenance = [
      ...new Map(
        [...existing.provenance, ...finding.provenance]
          .map((item) => [
            `${item.producerKind}:${item.producerId}:${item.policyHash}`,
            item,
          ]),
      ).values(),
    ].slice(0, 64);
    existing.coverageLimitations = [
      ...new Map(
        [...existing.coverageLimitations, ...finding.coverageLimitations]
          .map((item) => [item.id, item]),
      ).values(),
    ].slice(0, 128);
    existing.updatedAt = finding.updatedAt;
  }
  return [...merged.values()];
}
