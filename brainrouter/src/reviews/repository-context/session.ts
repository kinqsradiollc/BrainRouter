/**
 * Exact-revision repository-context campaign orchestration.
 *
 * This service advances durable stages and owns retained-handle lifetime.
 * Contracts, coverage calculation, and prompt serialization live in sibling
 * modules so this file stays focused on lifecycle coordination.
 */

import {
  evaluateDeepReviewActivation,
  validateAssuranceImpactPacketAssembly,
} from "@kinqs/brainrouter-core/review";
import type {
  AssuranceCodeIndexResult,
  AssuranceCoverageLimitation,
  AssuranceImpactPacketAssembly,
  AssuranceSourceLocation,
  DeepReviewActivationSource,
  DeepReviewPolicy,
  DeepReviewTelemetry,
  RepositoryAssuranceRun,
} from "@kinqs/brainrouter-types/review";
import type {
  RepositoryContextAssuranceInput,
  RepositoryContextPrompt,
} from "./contracts.js";
import {
  assertRepositoryModelContextLimit,
  isSafeRepositoryRelativePath,
} from "./contracts.js";
import {
  coverageLimitation,
  dedupeCoverageLimitations,
  packetCoverage,
  parserCoverage,
} from "./coverage.js";
import { buildRepositoryContextPrompt } from "./prompt.js";

const SOURCE_UNAVAILABLE = "EXACT_SOURCE_UNAVAILABLE";
const INDEX_UNAVAILABLE = "PARSER_INDEX_UNAVAILABLE";
const PACKETS_UNAVAILABLE = "IMPACT_PACKETS_UNAVAILABLE";
const NO_CHANGED_ANCHORS = "NO_CHANGED_SOURCE_ANCHORS";
const CLEANUP_FAILED = "REPOSITORY_CONTEXT_CLEANUP_FAILED";

function active(run: RepositoryAssuranceRun | null): run is RepositoryAssuranceRun {
  return run?.status === "queued" || run?.status === "running";
}


export class RepositoryContextAssuranceSession {
  private readonly now: () => string;
  private readonly limitations = new Map<string, AssuranceCoverageLimitation>();
  private indexResult: AssuranceCodeIndexResult | null = null;
  private assembly: AssuranceImpactPacketAssembly | null = null;
  private checkoutRef: string | null = null;
  private indexRef: string | null = null;
  private artifactRefs: string[] = [];
  private prompt: RepositoryContextPrompt | null = null;
  private cleaned = false;
  private canceled = false;

  constructor(private readonly input: RepositoryContextAssuranceInput) {
    assertRepositoryModelContextLimit(input.analysis.maxModelContextBytes);
    this.now = input.now ?? (() => new Date().toISOString());
  }

  get hasPromptContext(): boolean {
    return Boolean(this.prompt?.text);
  }

  get contextInputRefs(): string[] {
    return [
      ...(this.assembly?.packets.map((packet) => packet.id) ?? []),
      ...this.artifactRefs,
    ];
  }

  get deterministicAnalysis(): AssuranceImpactPacketAssembly | null {
    return this.assembly ? structuredClone(this.assembly) : null;
  }

  get verificationContext(): string | null {
    return this.prompt?.text ?? null;
  }

  get limitationIds(): string[] {
    return [...this.limitations.keys()];
  }

  /**
   * ADR-033 D3 — serve one file from the retained exact-revision checkout.
   *
   * Returns null when there is nothing to read from (no checkout, or the
   * composition wired no reader), so the caller can tell the reviewer the
   * evidence is unavailable instead of inventing it. Path safety and symlink
   * containment stay where they already are: this only hands the request on.
   */
  get canReadSource(): boolean {
    return Boolean(this.checkoutRef && this.input.analysis.readSourceFile && !this.cleaned);
  }

  /**
   * ADR-033 D2 — related-file edges among the changed paths, or none.
   *
   * Empty before the index exists (it is built during context preparation) and
   * empty after cleanup, so a caller that asks too early or too late plans its
   * bundles from path adjacency alone rather than from a stale graph.
   */
  relatedChangedPaths(changedPaths: readonly string[]): Array<[string, string]> {
    if (!this.indexRef || !this.input.analysis.relatedChangedPaths || this.cleaned) return [];
    const safe = changedPaths.filter((path) => isSafeRepositoryRelativePath(path));
    if (safe.length < 2) return [];
    try {
      return this.input.analysis.relatedChangedPaths(this.indexRef, safe);
    } catch {
      // Grouping is an optimisation over a correct default; a graph that cannot
      // answer must never sink the review that asked it.
      return [];
    }
  }

  async readSourceFile(relativePath: string, maxBytes: number): Promise<string> {
    if (!this.checkoutRef || !this.input.analysis.readSourceFile || this.cleaned) {
      throw new Error("The exact-revision checkout is not available for reading.");
    }
    if (!isSafeRepositoryRelativePath(relativePath)) {
      throw new Error("Requested review evidence path is not repo-relative.");
    }
    return this.input.analysis.readSourceFile(this.checkoutRef, relativePath, maxBytes);
  }

  async enforceDeepReviewPreflight(input: {
    policy: DeepReviewPolicy;
    organizationId: string;
    source: DeepReviewActivationSource;
    estimatedModelCalls: number;
    estimatedToolCalls: number;
    estimatedDurationMs: number;
    estimatedUsd: number;
  }): Promise<DeepReviewTelemetry> {
    const run = await this.input.runs.get(this.input.runId);
    if (!active(run) || !this.indexResult) {
      throw new Error("DEEP_REVIEW_PREFLIGHT_SOURCE_UNAVAILABLE");
    }
    if (this.input.program !== "code_review" && this.input.program !== "security_review") {
      throw new Error("DEEP_REVIEW_PROGRAM_UNSUPPORTED");
    }
    const program = this.input.program;
    const telemetry: DeepReviewTelemetry = {
      repositoryFiles: run.sourceSnapshot.fileCount,
      eligibleFiles: this.indexResult.receipt.filesEligible,
      indexedFiles: this.indexResult.receipt.filesIndexed,
      estimatedModelCalls: input.estimatedModelCalls,
      estimatedToolCalls: input.estimatedToolCalls,
      estimatedDurationMs: input.estimatedDurationMs,
      estimatedUsd: input.estimatedUsd,
    };
    await this.input.campaign.runStage(
      this.input.runId,
      "coverage_risk_map",
      1,
      async (current) => {
        const decision = evaluateDeepReviewActivation({
          policy: input.policy,
          organizationId: input.organizationId,
          repository: current.repository,
          program,
          source: input.source,
          explicitRequest: true,
          telemetry,
        });
        if (!decision.eligible) {
          throw new Error(`DEEP_REVIEW_PREFLIGHT_DENIED:${decision.reasons.join(",")}`);
        }
        return {
          status: "succeeded",
          inputRefs: [
            current.sourceSnapshot.inventoryRef ?? current.sourceSnapshot.id,
            this.indexResult!.receipt.indexRef,
          ],
          outputRefs: [
            `deep-policy:${input.policy.policyHash}`,
            `deep-coverage:${decision.coverageLabel}`,
          ],
        };
      },
    );
    return telemetry;
  }

  async prepareDeepPrompt(maxAnchors: number): Promise<RepositoryContextPrompt | null> {
    if (!this.indexRef || !this.input.analysis.selectDeepReviewAnchors) {
      throw new Error("DEEP_REVIEW_ANCHOR_SELECTION_UNAVAILABLE");
    }
    const selection = this.input.analysis.selectDeepReviewAnchors(
      this.indexRef,
      maxAnchors,
    );
    if (!selection.anchors.length) {
      throw new Error("DEEP_REVIEW_ANCHORS_UNAVAILABLE");
    }
    this.limitations.set(
      "deep-review-bounded-scope",
      coverageLimitation(
        "deep-review-bounded-scope",
        "deep-review",
        "partial",
        "DEEP_REVIEW_BOUNDED_SCOPE",
        selection.indexedFiles > selection.anchors.length
          ? `Bounded deep review selected ${selection.anchors.length} of ${selection.indexedFiles} indexed files.`
          : "Deep review used bounded parser-selected packets and does not claim exhaustive repository coverage.",
      ),
    );
    return this.preparePrompt(selection.anchors);
  }

  async prepareSourceAndIndex(): Promise<void> {
    const initial = await this.input.runs.get(this.input.runId);
    if (!active(initial)) return;
    if (await this.cancelIfRequested()) return;

    await this.input.campaign.runStage(this.input.runId, "checkout_inventory", 1, async (run) => {
      try {
        const prepared = await this.input.analysis.source.prepare({
          runId: run.id,
          repository: run.repository,
          revision: run.revision,
        }, { isCancellationRequested: () => this.isCancellationRequested() });
        for (const item of prepared.limitations) this.limitations.set(item.id, item);
        this.checkoutRef = prepared.source.checkoutRef ?? null;
        return {
          status: prepared.source.status === "ready" && prepared.limitations.length === 0
            ? "succeeded"
            : "partial",
          source: {
            ...prepared.source,
            id: run.sourceSnapshot.id,
            createdAt: run.sourceSnapshot.createdAt,
          },
          outputRefs: [
            ...(prepared.source.inventoryRef ? [prepared.source.inventoryRef] : []),
            ...(prepared.source.checkoutRef ? [prepared.source.checkoutRef] : []),
          ],
          limitationIds: prepared.limitations.map((item) => item.id),
          ...(prepared.source.errorCode ? { errorCode: prepared.source.errorCode } : {}),
        };
      } catch {
        const canceled = await this.isCancellationRequested();
        const item = coverageLimitation(
          canceled ? "repository-context-source-canceled" : "repository-context-source-unavailable",
          "exact-source",
          canceled ? "unavailable" : "failed",
          canceled ? "CANCELED" : SOURCE_UNAVAILABLE,
          canceled
            ? "Exact source preparation was canceled."
            : "The exact repository source could not be prepared; review will use the labeled diff-only fallback.",
        );
        this.limitations.set(item.id, item);
        return {
          status: "partial",
          source: {
            ...run.sourceSnapshot,
            status: "partial",
            completedAt: this.now(),
            errorCode: item.reasonCode,
          },
          coverage: parserCoverage(run, null, [item], this.now()),
          limitationIds: [item.id],
          errorCode: item.reasonCode,
        };
      }
    });
    if (await this.cancelIfRequested()) return;

    const afterSource = await this.input.runs.get(this.input.runId);
    if (!active(afterSource)) {
      await this.cleanup();
      return;
    }
    await this.input.campaign.runStage(this.input.runId, "index", 1, async (run) => {
      if (!this.checkoutRef) {
        const item = coverageLimitation(
          "repository-context-index-source-unavailable",
          "typescript-parser-index",
          "unavailable",
          SOURCE_UNAVAILABLE,
          "Parser indexing was unavailable because exact source preparation did not complete.",
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: parserCoverage(run, null, all, this.now()),
          limitationIds: all.map((entry) => entry.id),
          errorCode: SOURCE_UNAVAILABLE,
        };
      }
      try {
        this.indexResult = await this.input.analysis.index.update({
          runId: run.id,
          repository: run.repository,
          revision: run.revision,
          checkoutRef: this.checkoutRef,
        }, { isCancellationRequested: () => this.isCancellationRequested() });
        this.indexRef = this.indexResult.receipt.indexRef;
        for (const item of this.indexResult.limitations) this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: this.indexResult.receipt.status === "ready" && all.length === 0
            ? "succeeded"
            : "partial",
          source: {
            ...run.sourceSnapshot,
            status: run.sourceSnapshot.status === "ready" && this.indexResult.receipt.status === "ready"
              ? "ready"
              : "partial",
            indexedFileCount: this.indexResult.receipt.filesIndexed,
            unsupportedFileCount: Math.max(
              run.sourceSnapshot.unsupportedFileCount,
              run.sourceSnapshot.textFileCount - this.indexResult.receipt.filesEligible,
            ),
          },
          coverage: parserCoverage(run, this.indexResult, all, this.now()),
          inputRefs: [this.checkoutRef],
          outputRefs: [this.indexResult.receipt.indexRef, this.indexResult.receipt.id],
          limitationIds: all.map((entry) => entry.id),
          ...(this.indexResult.receipt.errorCode
            ? { errorCode: this.indexResult.receipt.errorCode }
            : {}),
        };
      } catch {
        const canceled = await this.isCancellationRequested();
        const item = coverageLimitation(
          canceled ? "repository-context-index-canceled" : "repository-context-index-unavailable",
          "typescript-parser-index",
          canceled ? "unavailable" : "failed",
          canceled ? "CANCELED" : INDEX_UNAVAILABLE,
          canceled
            ? "Parser indexing was canceled."
            : "Parser indexing was unavailable; review will use the labeled diff-only fallback.",
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: parserCoverage(run, null, all, this.now()),
          inputRefs: [this.checkoutRef],
          limitationIds: all.map((entry) => entry.id),
          errorCode: item.reasonCode,
        };
      }
    });
    if (await this.cancelIfRequested()) return;
    const afterIndex = await this.input.runs.get(this.input.runId);
    if (!active(afterIndex)) await this.cleanup();
  }

  async preparePrompt(changed: AssuranceSourceLocation[]): Promise<RepositoryContextPrompt | null> {
    const run = await this.input.runs.get(this.input.runId);
    if (!active(run)) {
      await this.cleanup();
      return null;
    }
    if (await this.cancelIfRequested()) return null;
    await this.input.campaign.runStage(this.input.runId, "packet_assembly", 1, async (current) => {
      if (changed.some((location) => !isSafeRepositoryRelativePath(location.path))) {
        const item = coverageLimitation(
          "repository-context-invalid-changed-path",
          "impact-packet-assembly",
          "failed",
          "INVALID_CHANGED_SOURCE_PATH",
          "Impact packet assembly rejected an unsafe changed-source path.",
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: this.indexResult
            ? packetCoverage(current, this.indexResult, null, changed, all, this.now())
            : parserCoverage(current, null, all, this.now()),
          limitationIds: all.map((entry) => entry.id),
          errorCode: item.reasonCode,
        };
      }
      if (!changed.length) {
        const item = coverageLimitation(
          "repository-context-no-changed-anchors",
          "impact-packet-assembly",
          "unavailable",
          NO_CHANGED_ANCHORS,
          "The diff did not contain a new-revision source anchor for packet assembly.",
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: this.indexResult
            ? packetCoverage(current, this.indexResult, null, changed, all, this.now())
            : parserCoverage(current, null, all, this.now()),
          limitationIds: all.map((entry) => entry.id),
          errorCode: NO_CHANGED_ANCHORS,
        };
      }
      if (!this.checkoutRef || !this.indexRef || !this.indexResult) {
        const item = coverageLimitation(
          "repository-context-packets-index-unavailable",
          "impact-packet-assembly",
          "unavailable",
          INDEX_UNAVAILABLE,
          "Impact packets were unavailable because the exact parser index did not complete.",
          changed.map((location) => location.path),
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: parserCoverage(current, null, all, this.now()),
          limitationIds: all.map((entry) => entry.id),
          errorCode: INDEX_UNAVAILABLE,
        };
      }
      try {
        this.assembly = await this.input.analysis.impact.assemble({
          runId: current.id,
          repository: current.repository,
          revision: current.revision,
          program: this.input.program,
          checkoutRef: this.checkoutRef,
          indexRef: this.indexRef,
          changed,
          redactionPolicyId: this.input.policy.redactionPolicyId,
          limits: this.input.policy.packetLimits,
        }, { isCancellationRequested: () => this.isCancellationRequested() });
        const validation = validateAssuranceImpactPacketAssembly(
          this.assembly,
          current.revision,
          this.input.policy,
        );
        if (!validation.ok) throw new Error("Impact packet assembly failed validation.");
        for (const item of this.assembly.limitations) this.limitations.set(item.id, item);
        this.artifactRefs = this.assembly.packets.flatMap((packet) => packet.artifactRefs);
        const promptResult = buildRepositoryContextPrompt({
          assembly: this.assembly,
          limitations: [...this.limitations.values()],
          resolveArtifact: (ref) => this.input.analysis.resolveArtifact(ref),
          maxBytes: this.input.analysis.maxModelContextBytes,
        });
        this.prompt = promptResult.prompt;
        if (promptResult.limitation) {
          this.limitations.set(promptResult.limitation.id, promptResult.limitation);
        }
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: all.length ? "partial" : "succeeded",
          coverage: packetCoverage(current, this.indexResult, this.assembly, changed, all, this.now()),
          inputRefs: [this.checkoutRef, this.indexRef],
          outputRefs: [
            ...this.assembly.packets.map((packet) => packet.id),
            ...this.artifactRefs,
          ],
          limitationIds: all.map((entry) => entry.id),
        };
      } catch {
        const canceled = await this.isCancellationRequested();
        const item = coverageLimitation(
          canceled ? "repository-context-packets-canceled" : "repository-context-packets-unavailable",
          "impact-packet-assembly",
          canceled ? "unavailable" : "failed",
          canceled ? "CANCELED" : PACKETS_UNAVAILABLE,
          canceled
            ? "Impact packet assembly was canceled."
            : "Impact packet assembly was unavailable; review will use the labeled diff-only fallback.",
          changed.map((location) => location.path),
        );
        this.limitations.set(item.id, item);
        const all = dedupeCoverageLimitations([...this.limitations.values()]);
        return {
          status: "partial",
          coverage: packetCoverage(current, this.indexResult, null, changed, all, this.now()),
          inputRefs: [this.checkoutRef, this.indexRef],
          limitationIds: all.map((entry) => entry.id),
          errorCode: item.reasonCode,
        };
      }
    });
    if (await this.cancelIfRequested()) return null;
    return this.prompt;
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const inputRefs = [
      ...this.artifactRefs,
      ...(this.indexRef ? [this.indexRef] : []),
      ...(this.checkoutRef ? [this.checkoutRef] : []),
    ];
    const released: string[] = [];
    let failed = false;
    try {
      await this.input.analysis.releaseArtifacts(this.artifactRefs);
      released.push(...this.artifactRefs.map((ref) => `released:${ref}`));
    } catch {
      failed = true;
    }
    if (this.indexRef) {
      try {
        await this.input.analysis.index.release(this.indexRef);
        released.push(`released:${this.indexRef}`);
      } catch {
        failed = true;
      }
    }
    if (this.checkoutRef) {
      try {
        await this.input.analysis.source.release(this.checkoutRef);
        released.push(`released:${this.checkoutRef}`);
      } catch {
        failed = true;
      }
    }

    const run = await this.input.runs.get(this.input.runId);
    if (!active(run)) return;
    await this.input.campaign.runStage(this.input.runId, "cleanup", 1, async (current) => {
      if (!failed) {
        return { status: "succeeded", inputRefs, outputRefs: released };
      }
      const item = coverageLimitation(
        "repository-context-cleanup-failed",
        "repository-context-cleanup",
        "failed",
        CLEANUP_FAILED,
        "One or more retained repository-context handles could not be released.",
      );
      this.limitations.set(item.id, item);
      return {
        status: "partial",
        coverage: {
          ...current.coverage,
          status: "partial",
          limitations: dedupeCoverageLimitations([...current.coverage.limitations, item]),
          calculatedAt: this.now(),
        },
        inputRefs,
        outputRefs: released,
        limitationIds: [item.id],
        errorCode: CLEANUP_FAILED,
      };
    });
  }

  async cancelIfRequested(): Promise<boolean> {
    if (this.canceled) return true;
    if (!await this.isCancellationRequested()) return false;
    this.canceled = true;
    await this.cleanup();
    const run = await this.input.runs.get(this.input.runId);
    if (active(run)) await this.input.campaign.cancel(this.input.runId);
    return true;
  }

  private async isCancellationRequested(): Promise<boolean> {
    return Boolean(await this.input.analysis.isCancellationRequested?.());
  }

}
