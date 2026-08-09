/**
 * Durable projection for the maintained diff-only PR review fallback.
 *
 * This adapter deliberately records partial repository coverage: a unified diff
 * can cover changed text, but it cannot prove unchanged callers, configuration,
 * generated sources, or unsupported binary content were inspected.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  calculateAssuranceGate,
  createRepositoryAssuranceCampaignService,
  parseDeepReviewPolicy,
  type RepositoryAssuranceRunPort,
} from "@kinqs/brainrouter-core/review";
import type { LLMRunner } from "@kinqs/brainrouter-types";
import type {
  AssuranceCoverage,
  AssuranceCoverageLimitation,
  AssurancePolicySnapshot,
  AssuranceSourceLocation,
  DeepReviewActivationSource,
  DeepReviewPolicy,
  RepositoryAssuranceProgram,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import type { ReviewPolicy } from "../integrations/githubWebhook.js";
import type {
  PrReviewCandidateDetail,
  PrReviewCoverage,
  PrReviewInput,
  PrReviewPublicationGate,
  PrReviewResult,
} from "../integrations/prSecurityReview.js";
import {
  createBackendAssuranceFindingPort,
  type RepositoryAssuranceFindingPersistenceStore,
} from "./assuranceFindingPort.js";
import {
  createBackendAssuranceRunPort,
  type RepositoryAssurancePersistenceStore,
} from "./assuranceRunPort.js";
import {
  assertRepositoryModelContextLimit,
  RepositoryContextAssuranceSession,
  type RepositoryContextAnalysisPorts,
  type RepositoryContextPrompt,
} from "./repositoryContextAssurance.js";
import {
  mergeAssuranceCandidates,
  normalizeDeterministicCandidates,
  normalizeReviewCandidates,
} from "./reviewCandidateNormalization.js";
import { createBoundedCandidateVerifier } from "./candidateVerifier.js";
import { createReviewFileAccess, type ReviewFileAccess } from "./reviewFileAccess.js";

const DIFF_ONLY_LIMITATION_ID = "diff-only-repository-context";

export interface RepositoryAssuranceSupersessionStore
  extends RepositoryAssurancePersistenceStore,
    RepositoryAssuranceFindingPersistenceStore {
  listReplaceableRepositoryAssuranceRunIds(input: {
    orgId: string;
    forge: RepositoryAssuranceRun["repository"]["forge"];
    repository: string;
    prNumber: number;
    program: RepositoryAssuranceProgram;
    replacementRunId: string;
  }): Promise<string[]>;
}

export interface StartDiffReviewAssuranceInput {
  store: RepositoryAssuranceSupersessionStore;
  jobId: string;
  review: PrReviewInput;
  program: RepositoryAssuranceProgram;
  policy: ReviewPolicy;
  maxDiffChars: number;
  timeoutMs: number;
  repositoryContext?: RepositoryContextAnalysisPorts;
  deepReview?: {
    policy: DeepReviewPolicy;
    source: Exclude<DeepReviewActivationSource, "diff_review">;
  };
  llmRunner?: LLMRunner;
  now?: () => string;
  nextId?: (kind: "run" | "source" | "stage") => string;
}

export interface RecordDiffReviewAssuranceInput extends StartDiffReviewAssuranceInput {
  result: PrReviewResult;
  changedFiles: number;
}

export interface DiffReviewAssuranceSession {
  readonly runId: string;
  prepareContext(changed: AssuranceSourceLocation[]): Promise<RepositoryContextPrompt | null>;
  /**
   * ADR-033 D3 — the read-only window over the retained checkout, or null when
   * this run has no checkout to read from (the diff-only fallback).
   */
  fileAccess(): ReviewFileAccess | null;
  /**
   * ADR-033 D2 — related-file edges among the changed paths, from the
   * exact-revision code graph. Empty until `prepareContext` has built the
   * index, and empty for a run that never got a checkout.
   */
  relatedChangedPaths(changedPaths: readonly string[]): Array<[string, string]>;
  recordCandidates(
    headSha: string,
    findings: PrReviewCandidateDetail[],
    coverage: PrReviewCoverage,
    changedFiles: number,
    currentHeadSha?: string,
  ): Promise<PrReviewPublicationGate>;
  complete(
    result: PrReviewResult,
    changedFiles: number,
  ): Promise<RepositoryAssuranceRun>;
  fail(): Promise<RepositoryAssuranceRun>;
}

function policySnapshot(
  input: StartDiffReviewAssuranceInput,
  createdAt: string,
  deepReviewPolicy: DeepReviewPolicy | null,
): AssurancePolicySnapshot {
  if (deepReviewPolicy) {
    return {
      id: `deep-review-v1:${deepReviewPolicy.policyHash}`,
      policyHash: deepReviewPolicy.policyHash,
      organizationId: deepReviewPolicy.organizationId,
      program: deepReviewPolicy.program,
      analyzers: [
        { id: "typescript-parser-index", enabled: true, required: true },
        { id: "deterministic-impact-packets", enabled: true, required: true },
        { id: "llm-deep-review", enabled: true, required: true },
        { id: "independent-candidate-verifier", enabled: true, required: false },
      ],
      packetLimits: { ...deepReviewPolicy.packetLimits },
      budgets: { ...deepReviewPolicy.budgets },
      redactionPolicyId: "pr-review-default",
      publicationPolicyId: input.policy.blockOnFindings
        ? "pr-review-blocking"
        : "pr-review-advisory",
      inlineFindingsEnabled: true,
      blockingEnabled:
        input.program !== "code_review" && input.policy.blockOnFindings,
      createdAt,
    };
  }
  const analyzers = [
    { id: "typescript-parser-index", enabled: Boolean(input.repositoryContext), required: false },
    { id: "deterministic-impact-packets", enabled: Boolean(input.repositoryContext), required: false },
    { id: "llm-diff-review", enabled: true, required: true },
    {
      id: "independent-candidate-verifier",
      enabled: Boolean(input.repositoryContext && input.llmRunner),
      required: false,
    },
  ];
  const packetLimits = {
    maxPackets: 20,
    maxPacketBytes: Math.max(1_024, Math.min(16_000, input.maxDiffChars)),
    maxFilesPerPacket: 12,
  };
  const value = {
    version: 1,
    program: input.program,
    reviewPolicy: input.policy,
    maxDiffChars: input.maxDiffChars,
    timeoutMs: input.timeoutMs,
    analyzers,
    packetLimits,
  };
  const policyHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    id: `diff-review-v1:${policyHash}`,
    policyHash,
    organizationId: String(input.review.orgId),
    program: input.program,
    analyzers,
    packetLimits,
    budgets: {
      maxModelCalls: 40,
      maxToolCalls: 0,
      maxDurationMs: input.timeoutMs * 40,
    },
    redactionPolicyId: "pr-review-default",
    publicationPolicyId: input.policy.blockOnFindings
      ? "pr-review-blocking"
      : "pr-review-advisory",
    inlineFindingsEnabled: true,
    blockingEnabled: input.program !== "code_review" && input.policy.blockOnFindings,
    createdAt,
  };
}

function uniqueLimitations(
  limitations: AssuranceCoverageLimitation[],
): AssuranceCoverageLimitation[] {
  return [...new Map(limitations.map((item) => [item.id, item])).values()];
}

function diffOnlyCoverage(
  result: PrReviewResult,
  changedFiles: number,
  calculatedAt: string,
  prior?: AssuranceCoverage,
): AssuranceCoverage {
  const files = Math.max(0, Math.trunc(changedFiles));
  const analyzerFailed = !result.ok;
  const analyzedFiles = !analyzerFailed && result.coverage?.complete ? files : 0;
  const limitation: AssuranceCoverageLimitation = {
    id: DIFF_ONLY_LIMITATION_ID,
    component: "repository_context",
    state: "unavailable",
    reasonCode: "DIFF_ONLY_FALLBACK",
    summary: "Only changed diff text was available; unchanged repository context was not analyzed.",
  };
  const previousAnalyzers = prior?.analyzers.filter(
    (analyzer) => analyzer.analyzerId !== "llm-diff-review",
  ) ?? [];
  return {
    status: "partial",
    filesTotal: Math.max(files, prior?.filesTotal ?? 0),
    filesEligible: Math.max(files, prior?.filesEligible ?? 0),
    filesAnalyzed: Math.max(analyzedFiles, prior?.filesAnalyzed ?? 0),
    changedFilesTotal: files,
    changedFilesAnalyzed: analyzedFiles,
    analyzers: [
      ...previousAnalyzers,
      {
        analyzerId: "llm-diff-review",
        state: analyzerFailed ? "failed" : "partial",
        supportedLanguages: [],
        filesEligible: files,
        filesAnalyzed: analyzedFiles,
        diagnosticsProduced: Math.max(0, Math.trunc(result.findings)),
        limitationIds: [DIFF_ONLY_LIMITATION_ID],
      },
    ],
    limitations: uniqueLimitations([...(prior?.limitations ?? []), limitation]),
    calculatedAt,
  };
}

function repositoryContextCoverage(
  prior: AssuranceCoverage,
  result: PrReviewResult,
  changedFiles: number,
  calculatedAt: string,
  deepReview = false,
): AssuranceCoverage {
  const files = Math.max(0, Math.trunc(changedFiles));
  const analyzerFailed = !result.ok;
  const modelComplete = !analyzerFailed && Boolean(result.coverage?.complete);
  const analyzers = [
    ...prior.analyzers.filter((analyzer) =>
      analyzer.analyzerId !== "llm-diff-review"
      && analyzer.analyzerId !== "llm-deep-review"),
    {
      analyzerId: deepReview ? "llm-deep-review" : "llm-diff-review",
      state: analyzerFailed ? "failed" as const : modelComplete ? "covered" as const : "partial" as const,
      supportedLanguages: [],
      filesEligible: files,
      filesAnalyzed: modelComplete ? files : 0,
      diagnosticsProduced: Math.max(0, Math.trunc(result.findings)),
      limitationIds: [],
    },
  ];
  return {
    ...prior,
    status: prior.status === "complete" && modelComplete ? "complete" : "partial",
    changedFilesTotal: files,
    changedFilesAnalyzed: modelComplete
      ? Math.min(files, prior.changedFilesAnalyzed)
      : 0,
    analyzers,
    calculatedAt,
  };
}

function diffOnlySource(
  input: StartDiffReviewAssuranceInput,
  headSha: string,
  sourceId: string,
  createdAt: string,
  changedFiles: number,
): SourceSnapshot {
  const files = Math.max(0, Math.trunc(changedFiles));
  return {
    id: sourceId,
    revision: { headSha },
    status: "partial",
    inventoryRef: `${input.review.forge ?? "github"}:${input.review.repo}#${input.review.prNumber}:diff`,
    fileCount: files,
    textFileCount: files,
    indexedFileCount: 0,
    unsupportedFileCount: 0,
    createdAt,
    completedAt: createdAt,
    errorCode: "DIFF_ONLY_FALLBACK",
  };
}

function active(run: RepositoryAssuranceRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function terminalStage(
  run: RepositoryAssuranceRun,
  stage: RepositoryAssuranceRun["stages"][number]["stage"],
  attempt = 1,
): boolean {
  return run.stages.some((receipt) =>
    receipt.stage === stage
    && receipt.attempt === attempt
    && receipt.status !== "running",
  );
}

async function supersedePriorRuns(
  input: StartDiffReviewAssuranceInput,
  replacement: RepositoryAssuranceRun,
  port: RepositoryAssuranceRunPort,
  campaign: ReturnType<typeof createRepositoryAssuranceCampaignService>,
): Promise<void> {
  const ids = await input.store.listReplaceableRepositoryAssuranceRunIds({
    orgId: replacement.policySnapshot.organizationId,
    forge: replacement.repository.forge,
    repository: replacement.repository.slug,
    prNumber: input.review.prNumber,
    program: replacement.program,
    replacementRunId: replacement.id,
  });
  for (const runId of ids) {
    const current = await port.get(runId);
    if (!current || !active(current)) continue;
    try {
      await campaign.supersede(runId, replacement.id);
    } catch (error) {
      const raced = await port.get(runId);
      if (raced && !active(raced)) continue;
      throw error;
    }
  }
}

export async function startDiffReviewAssurance(
  input: StartDiffReviewAssuranceInput,
): Promise<DiffReviewAssuranceSession | null> {
  const organizationId = String(input.review.orgId ?? "").trim();
  const headSha = String(input.review.headSha ?? "").trim();
  if (!organizationId || !headSha || !input.jobId.trim()) return null;
  if (input.repositoryContext) {
    assertRepositoryModelContextLimit(input.repositoryContext.maxModelContextBytes);
  }
  const deepReviewPolicy = input.deepReview
    ? parseDeepReviewPolicy(input.deepReview.policy)
    : null;
  if (deepReviewPolicy && (
    !input.repositoryContext
    || deepReviewPolicy.organizationId !== organizationId
    || deepReviewPolicy.repository.forge !== (input.review.forge === "gitlab" ? "gitlab" : "github")
    || deepReviewPolicy.repository.slug !== input.review.repo.trim().toLowerCase()
    || deepReviewPolicy.program !== input.program
    || deepReviewPolicy.activation.requestedBy !== input.review.requestedBy
  )) {
    throw new Error("Deep-review policy does not match the manual review authority.");
  }

  const now = input.now ?? (() => new Date().toISOString());
  const nextId = input.nextId ?? ((kind) => `${kind}-${randomUUID()}`);
  const createdAt = now();
  const port: RepositoryAssuranceRunPort = createBackendAssuranceRunPort(input.store, {
    organizationId,
    jobId: input.jobId,
  });
  const campaign = createRepositoryAssuranceCampaignService({ runs: port, now, nextId });
  const started = await campaign.start({
    repository: {
      forge: input.review.forge === "gitlab" ? "gitlab" : "github",
      slug: input.review.repo,
    },
    revision: { headSha },
    program: input.program,
    policySnapshot: policySnapshot(input, createdAt, deepReviewPolicy),
  });
  if (active(started)) {
    await supersedePriorRuns(input, started, port, campaign);
  }
  const repositoryContext = input.repositoryContext && active(started)
    ? new RepositoryContextAssuranceSession({
        runId: started.id,
        runs: port,
        campaign,
        program: input.program,
        policy: started.policySnapshot,
        analysis: input.repositoryContext,
        now,
      })
    : null;
  const findingPort = createBackendAssuranceFindingPort(input.store, {
    organizationId,
    runId: started.id,
  });
  const verifier = input.llmRunner && repositoryContext
    ? createBoundedCandidateVerifier({
        llmRunner: input.llmRunner,
        contextFor: () => repositoryContext.verificationContext,
        now,
        timeoutMs: input.timeoutMs,
      })
    : null;
  const verificationCampaign = verifier
    ? createRepositoryAssuranceCampaignService({
        runs: port,
        findings: findingPort,
        verifier,
        now,
        nextId,
      })
    : null;
  let candidateIds: string[] = [];

  const calculatePublicationGate = async (
    run: RepositoryAssuranceRun,
    currentHeadSha: string | undefined,
  ): Promise<PrReviewPublicationGate> => {
    const findings = (await Promise.all(
      run.findings.map((reference) => findingPort.get(reference.id)),
    )).filter((finding): finding is NonNullable<typeof finding> => finding !== null);
    const calculatedAt = now();
    const gateRun: RepositoryAssuranceRun = active(run)
      ? {
          ...run,
          status: run.sourceSnapshot.status === "ready" && run.coverage.status === "complete"
            ? "completed"
            : "partial",
          updatedAt: calculatedAt,
          completedAt: calculatedAt,
        }
      : run;
    return calculateAssuranceGate({
      run: gateRun,
      findings,
      currentHeadSha: currentHeadSha ?? "",
    });
  };

  try {
    await repositoryContext?.prepareSourceAndIndex();
    if (deepReviewPolicy && repositoryContext && input.deepReview) {
      await repositoryContext.enforceDeepReviewPreflight({
        policy: deepReviewPolicy,
        organizationId,
        source: input.deepReview.source,
        estimatedModelCalls: deepReviewPolicy.budgets.maxModelCalls,
        estimatedToolCalls: 3,
        estimatedDurationMs: deepReviewPolicy.budgets.maxDurationMs,
        estimatedUsd: deepReviewPolicy.budgets.maxUsd,
      });
    }
  } catch (error) {
    try {
      await repositoryContext?.cleanup();
    } catch {
      // Preserve the preparation failure; cleanup records its own limitation
      // whenever the durable run remains writable.
    }
    throw error;
  }

  const recordCandidates = async (
    candidateHeadSha: string,
    findings: PrReviewCandidateDetail[],
    coverage: PrReviewCoverage,
    changedFiles: number,
    currentHeadSha?: string,
  ): Promise<PrReviewPublicationGate> => {
    if (candidateHeadSha !== headSha) {
      throw new Error("Review candidates must match the assurance run exact revision.");
    }
    let run = (await port.get(started.id)) ?? started;
    if (!active(run)) return calculatePublicationGate(run, currentHeadSha);
    const calculatedAt = now();
    const contextReady = Boolean(repositoryContext?.hasPromptContext);
    const candidateResult: PrReviewResult = {
      ok: true,
      findings: findings.length,
      posted: false,
      headSha,
      coverage,
    };
    if (!contextReady) {
      const attempt = repositoryContext ? 2 : 1;
      if (!terminalStage(run, "checkout_inventory", attempt)) {
        const source = diffOnlySource(
          input,
          headSha,
          run.sourceSnapshot.id,
          run.sourceSnapshot.createdAt,
          changedFiles,
        );
        const diffCoverage = diffOnlyCoverage(
          candidateResult,
          changedFiles,
          calculatedAt,
          run.coverage,
        );
        run = await campaign.runStage(run.id, "checkout_inventory", attempt, async () => ({
          status: "partial",
          source,
          coverage: diffCoverage,
          outputRefs: [source.inventoryRef!],
          limitationIds: diffCoverage.limitations.map((item) => item.id),
          errorCode: "DIFF_ONLY_FALLBACK",
        }));
      }
    }
    const candidateRun = contextReady
      ? {
          ...run,
          coverage: repositoryContextCoverage(
            run.coverage,
            candidateResult,
            changedFiles,
            calculatedAt,
            Boolean(deepReviewPolicy),
          ),
        }
      : run;
    const modelCandidates = normalizeReviewCandidates({
      run: candidateRun,
      findings,
      now: calculatedAt,
    });
    const deterministicAnalysis = repositoryContext?.deterministicAnalysis;
    const deterministicCandidates = deterministicAnalysis
      ? normalizeDeterministicCandidates({
          run: candidateRun,
          assembly: deterministicAnalysis,
          now: calculatedAt,
        })
      : [];
    const candidates = mergeAssuranceCandidates([
      ...modelCandidates,
      ...deterministicCandidates,
    ]);
    const persisted = [];
    for (const finding of candidates) persisted.push(await findingPort.save(finding));
    candidateIds = persisted.map((finding) => finding.id);
    run = (await port.get(run.id)) ?? run;
    if (!terminalStage(run, "candidate_discovery")) {
      run = await campaign.runStage(run.id, "candidate_discovery", 1, async () => ({
        status: contextReady && candidateRun.coverage.status === "complete"
          ? "succeeded"
          : "partial",
        coverage: candidateRun.coverage,
        inputRefs: contextReady
          ? repositoryContext?.contextInputRefs ?? []
          : [run.sourceSnapshot.inventoryRef!],
        outputRefs: [...candidateIds, `memory-job:${input.jobId}`],
        limitationIds: contextReady
          ? repositoryContext?.limitationIds ?? []
          : candidateRun.coverage.limitations.map((item) => item.id),
        ...(!contextReady ? { errorCode: "DIFF_ONLY_FALLBACK" } : {}),
      }));
    }
    if (verificationCampaign && !terminalStage(run, "candidate_verification")) {
      const remainingModelCalls = Math.max(
        0,
        run.policySnapshot.budgets.maxModelCalls - coverage.totalParts,
      );
      const eligible = persisted.filter((finding) => finding.evidence.length > 0);
      const selected = eligible.slice(0, remainingModelCalls);
      run = await verificationCampaign.runStage(
        run.id,
        "candidate_verification",
        1,
        async () => {
          const dispositions = [];
          for (const finding of selected) {
            dispositions.push(
              await verificationCampaign.verifyCandidate(run.id, finding.id),
            );
          }
          const unresolved = persisted.length - dispositions.filter((finding) =>
            finding.state === "verified"
            || finding.state === "validated"
            || finding.state === "disputed",
          ).length;
          return {
            status: unresolved === 0 ? "succeeded" : "partial",
            inputRefs: candidateIds,
            outputRefs: dispositions.map((finding) => finding.id),
            ...(unresolved > 0 ? { errorCode: "CANDIDATES_UNRESOLVED" } : {}),
          };
        },
      );
    }
    run = (await port.get(run.id)) ?? run;
    if (!active(run)) return calculatePublicationGate(run, currentHeadSha);
    const gate = await calculatePublicationGate(run, currentHeadSha);
    if (!terminalStage(run, "lifecycle_gate")) {
      await campaign.runStage(run.id, "lifecycle_gate", 1, async () => ({
        status: "succeeded",
        inputRefs: run.findings.map((finding) => finding.id),
        outputRefs: [`gate:${gate.status}`],
        limitationIds: run.coverage.limitations.map((limitation) => limitation.id),
      }));
    }
    return gate;
  };

  const complete = async (
    result: PrReviewResult,
    changedFiles: number,
  ): Promise<RepositoryAssuranceRun> => {
    try {
      let run = (await port.get(started.id)) ?? started;
      if (!active(run)) {
        await repositoryContext?.cleanup();
        return run;
      }
      const contextReady = Boolean(repositoryContext?.hasPromptContext);
      const fallbackAttempt = repositoryContext ? 2 : 1;
      if (!contextReady && !terminalStage(run, "checkout_inventory", fallbackAttempt)) {
        const source = diffOnlySource(
          input,
          headSha,
          run.sourceSnapshot.id,
          run.sourceSnapshot.createdAt,
          changedFiles,
        );
        const coverage = diffOnlyCoverage(result, changedFiles, now(), run.coverage);
        run = await campaign.runStage(
          run.id,
          "checkout_inventory",
          fallbackAttempt,
          async () => ({
            status: "partial",
            source,
            coverage,
            outputRefs: [source.inventoryRef!],
            limitationIds: coverage.limitations.map((item) => item.id),
            errorCode: "DIFF_ONLY_FALLBACK",
          }),
        );
      }

      if (!result.ok) {
        await repositoryContext?.cleanup();
        try {
          await campaign.runStage(run.id, "candidate_discovery", 1, async () => {
            throw new Error("DIFF_REVIEW_FAILED");
          });
        } catch {
          return (await port.get(run.id)) ?? run;
        }
      }

      if (!terminalStage(run, "candidate_discovery")) {
        const contextRefs = repositoryContext?.contextInputRefs ?? [];
        run = await campaign.runStage(run.id, "candidate_discovery", 1, async () => ({
          status: contextReady && run.coverage.status === "complete" ? "succeeded" : "partial",
          coverage: contextReady
            ? repositoryContextCoverage(
                run.coverage,
                result,
                changedFiles,
                now(),
                Boolean(deepReviewPolicy),
              )
            : run.coverage,
          inputRefs: contextReady ? contextRefs : [run.sourceSnapshot.inventoryRef!],
          outputRefs: [...candidateIds, `memory-job:${input.jobId}`],
          limitationIds: contextReady
            ? repositoryContext?.limitationIds ?? []
            : run.coverage.limitations.map((item) => item.id),
          ...(!contextReady ? { errorCode: "DIFF_ONLY_FALLBACK" } : {}),
        }));
      }

      if (!terminalStage(run, "publication")) {
        const outputRefs = [
          ...(result.posted ? ["forge:summary"] : []),
          ...(result.reviewPosted ? ["forge:review"] : []),
          ...(result.inlinePosted ? [`forge:inline:${result.inlinePosted}`] : []),
          ...(result.checkPosted ? ["forge:check"] : []),
          ...(result.approved ? ["forge:approval"] : []),
        ];
        const gate = result.assuranceGate;
        run = await campaign.runStage(run.id, "publication", 1, async () => ({
          status: gate && outputRefs.length > 0 ? "succeeded" : "partial",
          inputRefs: [
            ...candidateIds,
            ...(gate ? [`gate:${gate.status}`] : ["gate:unavailable"]),
          ],
          outputRefs,
          limitationIds: run.coverage.limitations.map((limitation) => limitation.id),
          ...(!gate
            ? { errorCode: "ASSURANCE_GATE_UNAVAILABLE" }
            : outputRefs.length === 0
              ? { errorCode: "FORGE_PUBLICATION_UNAVAILABLE" }
              : {}),
        }));
      }
      await repositoryContext?.cleanup();
      run = (await port.get(run.id)) ?? run;
      if (!active(run)) return run;
      if (result.assuranceGate?.status === "stale") {
        const completedAt = now();
        return port.transition({
          runId: run.id,
          status: "stale",
          staleReason: result.assuranceGate.reason,
          updatedAt: completedAt,
          completedAt,
        });
      }
      const publicationComplete = terminalStage(run, "publication")
        && run.stages.some((receipt) =>
          receipt.stage === "publication"
          && receipt.attempt === 1
          && receipt.status === "succeeded",
        );
      const authoritativeGate = result.assuranceGate?.status === "clean"
        || result.assuranceGate?.status === "advisory"
        || result.assuranceGate?.status === "blocked";
      return campaign.finish(
        run.id,
        run.sourceSnapshot.status === "ready"
          && run.coverage.status === "complete"
          && publicationComplete
          && authoritativeGate
          ? "completed"
          : "partial",
      );
    } catch (error) {
      try {
        await repositoryContext?.cleanup();
      } catch {
        // Preserve the execution failure. A cleanup-stage persistence failure
        // must not erase the earlier root cause.
      }
      throw error;
    }
  };

  // One access window per run, so its budget is the review's budget rather
  // than a fresh allowance per bundle (ADR-033 D3/D9).
  let fileAccess: ReviewFileAccess | null = null;

  return {
    runId: started.id,
    fileAccess: () => {
      if (!repositoryContext?.canReadSource) return null;
      fileAccess ??= createReviewFileAccess({
        readSourceFile: (path, maxBytes) => repositoryContext.readSourceFile(path, maxBytes),
      });
      return fileAccess;
    },
    relatedChangedPaths: (changedPaths) =>
      repositoryContext?.relatedChangedPaths(changedPaths) ?? [],
    prepareContext: (changed) =>
      deepReviewPolicy
        ? repositoryContext?.prepareDeepPrompt(deepReviewPolicy.packetLimits.maxPackets)
          ?? Promise.resolve(null)
        : repositoryContext?.preparePrompt(changed) ?? Promise.resolve(null),
    recordCandidates,
    complete,
    fail: () => complete({
      ok: false,
      findings: 0,
      posted: false,
      headSha,
      error: "review execution failed",
    }, 0),
  };
}

export async function recordDiffReviewAssurance(
  input: RecordDiffReviewAssuranceInput,
): Promise<RepositoryAssuranceRun | null> {
  const session = await startDiffReviewAssurance({
    store: input.store,
    jobId: input.jobId,
    review: {
      ...input.review,
      headSha: input.result.headSha ?? input.review.headSha,
    },
    program: input.program,
    policy: input.policy,
    maxDiffChars: input.maxDiffChars,
    timeoutMs: input.timeoutMs,
    ...(input.now ? { now: input.now } : {}),
    ...(input.nextId ? { nextId: input.nextId } : {}),
    ...(input.llmRunner ? { llmRunner: input.llmRunner } : {}),
  });
  return session?.complete(input.result, input.changedFiles) ?? null;
}
