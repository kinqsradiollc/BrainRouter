/**
 * Scheduler adapter for the maintained PR-review executors.
 *
 * It binds organization-scoped credentials and model policy, preserves the
 * existing forge publication path, and projects the result into one durable
 * exact-revision assurance campaign.
 */

import type { MemoryJobProgressEvent } from "@kinqs/brainrouter-types";
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
    repo: String(value?.repo ?? ""),
    prNumber: Number(value?.prNumber),
    headSha: String(value?.headSha ?? ""),
  };
}

async function reviewDependencies(
  ctx: JobExecContext,
  lens: ScheduledReviewLens,
  orgId: string | undefined,
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
    isCancellationRequested(): boolean | Promise<boolean>;
  },
): Promise<PrReviewDeps> {
  const engine = requireReviewEngine(ctx);
  const assignment = await engine.reviewAssignment?.(lens, orgId);
  const reviewRunner = await engine.reviewRunner?.(lens, orgId);
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
    isCancellationRequested: observe.isCancellationRequested,
  };
}

export async function runScheduledPrReview(
  rawInput: unknown,
  ctx: JobExecContext,
  lens: ScheduledReviewLens,
): Promise<unknown> {
  const input = normalizeReviewInput(rawInput);
  let changedFiles = 0;
  const assurance: { current: DiffReviewAssuranceSession | null } = { current: null };
  const isCancellationRequested = async (): Promise<boolean> => {
    if (!ctx.jobId) return false;
    const job = await ctx.store.getMemoryJob(ctx.jobId);
    return String(job?.status ?? "") === "cancelled";
  };
  const deps = await reviewDependencies(ctx, lens, input.orgId, {
    assuranceReady: async ({ policy, headSha, checkout }) => {
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
        }),
      });
    },
    prepareRepositoryContext: ({ changed }) =>
      assurance.current?.prepareContext(changed) ?? Promise.resolve(null),
    candidatesReady: ({
      headSha,
      currentHeadSha,
      findings,
      coverage,
      changedFiles,
    }) =>
      assurance.current?.recordCandidates(
        headSha,
        findings,
        coverage,
        changedFiles,
        currentHeadSha,
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
