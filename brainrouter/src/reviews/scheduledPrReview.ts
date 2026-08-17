/**
 * Scheduler adapter for the maintained PR-review executors.
 *
 * It binds organization-scoped credentials and model policy, preserves the
 * existing forge publication path, and projects the result into one durable
 * exact-revision assurance campaign.
 */

import type { MemoryJobProgressEvent } from "@kinqs/brainrouter-types";
import {
  assertAuthorizedAssessmentTarget,
  parseDeepReviewPolicy,
  parseAuthorizedAssessmentPolicy,
} from "@kinqs/brainrouter-core/review";
import type {
  AuthorizedAssessmentPolicy,
  DeepReviewPolicy,
  DeepReviewProgram,
} from "@kinqs/brainrouter-types/review";
import {
  runPrCodeReview,
  runPrPentest,
  runPrSecurityReview,
  type PrReviewDeps,
  type PrReviewInput,
  type PrReviewPublicationGate,
} from "../integrations/prSecurityReview.js";
import {
  buildVulnerabilityReviewContext,
  type VulnerabilityReviewContextStore,
} from "../vulnerability/context.js";
import type { JobExecContext } from "../memory/scheduler/executors.js";
import {
  startDiffReviewAssurance,
  type DiffReviewAssuranceSession,
  type RepositoryAssuranceSupersessionStore,
} from "./diffReviewAssurance.js";
import { createRepositoryContextAnalysisPorts } from "./repositoryContextComposition.js";

export type ScheduledReviewLens = "security" | "code" | "pentest";

function requireReviewEngine(ctx: JobExecContext): NonNullable<JobExecContext["engine"]> {
  if (!ctx.engine) throw new Error("PR-review executor requires an engine in the job context");
  return ctx.engine;
}

function normalizeReviewInput(input: unknown): PrReviewInput {
  const value = input as Record<string, unknown> | null;
  const forge = value?.forge === "gitlab" ? "gitlab" : "github";
  return {
    orgId: typeof value?.orgId === "string" ? value.orgId : undefined,
    installationId: String(value?.installationId ?? ""),
    forge,
    credentialSource: forge === "gitlab"
      ? "gitlab_account"
      : value?.credentialSource === "github_account"
        ? "github_account"
        : "github_app",
    requestedBy: typeof value?.requestedBy === "string" ? value.requestedBy : undefined,
    reviewMode: value?.reviewMode === "deep" ? "deep" : "diff",
    repo: String(value?.repo ?? ""),
    prNumber: Number(value?.prNumber),
    headSha: String(value?.headSha ?? ""),
  };
}

function validateDeepReviewRequest(
  rawInput: unknown,
  lens: ScheduledReviewLens,
): DeepReviewPolicy | null {
  const input = rawInput as Record<string, unknown> | null;
  const reviewMode = input?.reviewMode === "deep" ? "deep" : "diff";
  if (reviewMode === "diff") {
    if (input?.deepReviewPolicy !== undefined) {
      throw new Error("A deep-review policy cannot activate an ordinary diff review.");
    }
    return null;
  }
  if (lens === "pentest" || input?.requestSource !== "manual_api") {
    throw new Error("Deep review requires an explicit manual code or security request.");
  }
  const policy = parseDeepReviewPolicy(input?.deepReviewPolicy);
  const program: DeepReviewProgram = lens === "code"
    ? "code_review"
    : "security_review";
  const forge = input?.forge === "gitlab" ? "gitlab" : "github";
  const repository = String(input?.repo ?? "").trim().toLowerCase();
  const organizationId = String(input?.orgId ?? "").trim();
  const requestedBy = String(input?.requestedBy ?? "").trim();
  if (
    policy.program !== program
    || policy.repository.forge !== forge
    || policy.repository.slug !== repository
    || policy.organizationId !== organizationId
    || policy.activation.requestedBy !== requestedBy
  ) {
    throw new Error("Deep-review policy does not match the queued manual request.");
  }
  return policy;
}

async function validatePentestAuthorization(
  rawInput: unknown,
  ctx: JobExecContext,
): Promise<AuthorizedAssessmentPolicy> {
  const input = rawInput as Record<string, unknown> | null;
  const policy = parseAuthorizedAssessmentPolicy(input?.assessmentPolicy);
  if (policy.target.kind !== "repository" || policy.scanMode !== "code-review") {
    throw new Error("PR pentests require a source-only authorized repository policy.");
  }
  if (
    String(input?.repo ?? "").trim().toLowerCase() !== policy.target.normalizedValue
    || String(input?.orgId ?? "").trim() !== policy.organizationId
  ) {
    throw new Error("PR pentest request does not match its authorized target policy.");
  }
  assertAuthorizedAssessmentTarget(
    policy,
    await ctx.store.getPentestTarget(policy.target.targetId),
  );
  return policy;
}

async function reviewDependencies(
  ctx: JobExecContext,
  lens: ScheduledReviewLens,
  orgId: string | undefined,
  deepReviewPolicy: DeepReviewPolicy | null,
  observe: {
    progress(event: Omit<MemoryJobProgressEvent, "ts">): void;
    assuranceReady(input: Parameters<
      NonNullable<PrReviewDeps["onAssuranceReady"]>
    >[0]): void | Promise<void>;
    prepareRepositoryContext(input: Parameters<
      NonNullable<PrReviewDeps["prepareRepositoryContext"]>
    >[0]): ReturnType<NonNullable<PrReviewDeps["prepareRepositoryContext"]>>;
    candidatesReady(input: Parameters<
      NonNullable<PrReviewDeps["onCandidatesReady"]>
    >[0]): PrReviewPublicationGate | void | Promise<PrReviewPublicationGate | void>;
    serveRepositoryFiles(paths: string[], bundleId: string): ReturnType<
      NonNullable<PrReviewDeps["serveRepositoryFiles"]>
    >;
    readRepositoryFileForPosition(path: string): Promise<string | null>;
    relatedPaths(changedPaths: string[]): Array<[string, string]>;
    isCancellationRequested(): boolean | Promise<boolean>;
  },
): Promise<PrReviewDeps> {
  const engine = requireReviewEngine(ctx);
  const assignment = await engine.reviewAssignment?.(lens, orgId);
  const reviewRunner = await engine.reviewRunner?.(lens, orgId);
  const perCallTimeoutMs = assignment?.timeoutMs ?? 120_000;
  return {
    llmRunner: reviewRunner ?? ctx.llmRunner,
    fetchImpl: fetch,
    nowSec: () => Math.floor(Date.now() / 1000),
    getIntegration: (installationId) => engine.findGithubAppByInstallation(installationId),
    getUserAuthorization: (userId) =>
      engine.findGithubAccountAuthorization?.(userId) ?? Promise.resolve(null),
    getGitlabAuthorization: (userId, requestedOrgId) =>
      engine.findGitlabAccountAuthorization?.(userId, requestedOrgId)
      ?? Promise.resolve(null),
    getVulnerabilityContext: (input) => buildVulnerabilityReviewContext({
      store: ctx.store as unknown as VulnerabilityReviewContextStore,
      orgId: input.orgId,
      repo: input.repo,
      diff: input.diff,
    }),
    maxDiffChars: assignment?.maxDiffChars,
    timeoutMs: assignment?.timeoutMs,
    onProgress: (event) => {
      observe.progress(event);
      if (!ctx.jobId) return;
      void ctx.store.appendJobProgress(ctx.jobId, {
        ts: new Date().toISOString(),
        ...event,
      }).catch(() => {});
    },
    onAssuranceReady: observe.assuranceReady,
    prepareRepositoryContext: observe.prepareRepositoryContext,
    onCandidatesReady: observe.candidatesReady,
    // ADR-033 D3 — the reviewer can ask for a file; the assurance session owns
    // the checkout it is served from and the budget it is served under.
    serveRepositoryFiles: observe.serveRepositoryFiles,
    readRepositoryFileForPosition: observe.readRepositoryFileForPosition,
    // ADR-033 D2 — the units are grouped from the exact-revision code graph the
    // assurance session already built for the impact packets.
    relatedPaths: observe.relatedPaths,
    // ADR-033 D2 — bundles are independent, so they run together. Four is the
    // per-review burst we are willing to spend against a tenant's model budget.
    reviewConcurrency: 4,
    isCancellationRequested: observe.isCancellationRequested,
    executionBudget: deepReviewPolicy
      ? {
          maxModelCalls: deepReviewPolicy.budgets.maxModelCalls,
          maxDurationMs: deepReviewPolicy.budgets.maxDurationMs,
        }
      : {
          maxModelCalls: 40,
          maxDurationMs: perCallTimeoutMs * 40,
        },
  };
}

export async function runScheduledPrReview(
  rawInput: unknown,
  ctx: JobExecContext,
  lens: ScheduledReviewLens,
): Promise<unknown> {
  const assessmentPolicy = lens === "pentest"
    ? await validatePentestAuthorization(rawInput, ctx)
    : null;
  const deepReviewPolicy = validateDeepReviewRequest(rawInput, lens);
  const input = normalizeReviewInput(rawInput);
  let changedFiles = 0;
  const assurance: { current: DiffReviewAssuranceSession | null } = { current: null };
  const isCancellationRequested = async (): Promise<boolean> => {
    if (!ctx.jobId) return false;
    const job = await ctx.store.getMemoryJob(ctx.jobId);
    if (String(job?.status ?? "") === "cancelled") return true;
    if (!assessmentPolicy) return false;
    try {
      assertAuthorizedAssessmentTarget(
        assessmentPolicy,
        await ctx.store.getPentestTarget(assessmentPolicy.target.targetId),
      );
      return false;
    } catch {
      return true;
    }
  };
  const deps = await reviewDependencies(ctx, lens, input.orgId, deepReviewPolicy, {
    assuranceReady: async ({ policy, headSha, checkout, codeqlPaths }) => {
      if (!ctx.jobId) return;
      const maxDiffChars = deps.maxDiffChars ?? 60_000;
      assurance.current = await startDiffReviewAssurance({
        store: ctx.store as unknown as RepositoryAssuranceSupersessionStore,
        jobId: ctx.jobId,
        review: { ...input, headSha },
        program: lens === "security"
          ? "security_review"
          : lens === "code"
            ? "code_review"
            : "authorized_pentest",
        policy,
        maxDiffChars,
        timeoutMs: deps.timeoutMs ?? 120_000,
        llmRunner: ctx.llmRunner,
        repositoryContext: createRepositoryContextAnalysisPorts({
          checkout,
          maxDiffChars,
          isCancellationRequested,
          // ADR-039 S2 — thread the CodeQL taint-path provider (GitHub PRs) so
          // its source→sink paths augment the impact assembler's candidates.
          ...(codeqlPaths ? { codeqlPaths } : {}),
        }),
        ...(deepReviewPolicy ? {
          deepReview: {
            policy: deepReviewPolicy,
            source: "manual_api",
          },
        } : {}),
      });
    },
    prepareRepositoryContext: async ({ changed }) => {
      const prepared = await (assurance.current?.prepareContext(changed)
        ?? Promise.resolve(null));
      if (!prepared) return null;
      return {
        ...prepared,
        ...(deepReviewPolicy
          ? { coverageLabel: deepReviewPolicy.coverage.label }
          : {
              contextForPaths: (paths: readonly string[]) =>
                assurance.current?.contextForPaths(paths)?.text ?? "",
            }),
      };
    },
    serveRepositoryFiles: async (paths, bundleId) => {
      const access = assurance.current?.fileAccess();
      if (!access) {
        return paths.map((path) => ({
          path,
          unavailableReason: "no exact-revision checkout is retained for this review",
        }));
      }
      return access.serve(paths, bundleId);
    },
    readRepositoryFileForPosition: async (path) =>
      assurance.current?.fileAccess()?.readForPosition(path) ?? null,
    relatedPaths: (changedPaths) => assurance.current?.relatedChangedPaths(changedPaths) ?? [],
    candidatesReady: ({
      headSha,
      currentHeadSha,
      findings,
      coverage,
      changedFiles,
      execution,
    }) =>
      assurance.current?.recordCandidates(
        headSha,
        findings,
        coverage,
        changedFiles,
        currentHeadSha,
        execution,
      ) ?? Promise.resolve(),
    isCancellationRequested,
    progress: (event) => {
      if (event.kind === "diff-fetched") {
        const files = event.data?.files;
        if (typeof files === "number" && Number.isFinite(files)) changedFiles = files;
      }
    },
  });
  const execute = lens === "security"
    ? runPrSecurityReview
    : lens === "code"
      ? runPrCodeReview
    : runPrPentest;
  try {
    const result = await execute(input, deps);
    await assurance.current?.complete(result, changedFiles);
    return result;
  } catch (error) {
    try {
      await assurance.current?.fail();
    } catch {
      // Keep the executor failure as the job's root cause. The assurance
      // session already attempts retained-handle cleanup before it can fail.
    }
    throw error;
  }
}
