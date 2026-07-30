/**
 * Backend assurance-run port mapping fixtures.
 *
 * The adapter binds job/tenant ancestry once and forwards Core operations
 * without leaking host-specific fields back into the domain service.
 */

import { describe, expect, it, vi } from "vitest";
import type { RepositoryAssuranceRun } from "@kinqs/brainrouter-types/review";
import {
  createBackendAssuranceRunPort,
  type RepositoryAssurancePersistenceStore,
} from "./assuranceRunPort.js";

function run(id = "run-1", organizationId = "org-1"): RepositoryAssuranceRun {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    id,
    repository: { forge: "github", slug: "owner/repository" },
    revision: { headSha: "head" },
    program: "security_review",
    policySnapshot: {
      id: "policy-1",
      policyHash: "policy-hash",
      organizationId,
      program: "security_review",
      analyzers: [],
      packetLimits: { maxPackets: 1, maxPacketBytes: 1, maxFilesPerPacket: 1 },
      budgets: { maxModelCalls: 1, maxToolCalls: 1, maxDurationMs: 1 },
      redactionPolicyId: "redaction-1",
      publicationPolicyId: "publication-1",
      inlineFindingsEnabled: false,
      blockingEnabled: true,
      createdAt: now,
    },
    sourceSnapshot: {
      id: "source-1",
      revision: { headSha: "head" },
      status: "pending",
      fileCount: 0,
      textFileCount: 0,
      indexedFileCount: 0,
      unsupportedFileCount: 0,
      createdAt: now,
    },
    coverage: {
      status: "unavailable",
      filesTotal: 0,
      filesEligible: 0,
      filesAnalyzed: 0,
      changedFilesTotal: 0,
      changedFilesAnalyzed: 0,
      analyzers: [],
      limitations: [],
      calculatedAt: now,
    },
    stages: [],
    findings: [],
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
}

function fakeStore(existingId?: string) {
  const persisted = run(existingId ?? "run-1");
  const store = {
    createRepositoryAssuranceRun: vi.fn(async () => persisted),
    getRepositoryAssuranceRun: vi.fn(async () => persisted),
    transitionRepositoryAssuranceRun: vi.fn(async () => persisted),
    updateRepositorySourceSnapshot: vi.fn(async (_org, _id, source) => source),
    updateRepositoryAssuranceCoverage: vi.fn(async (_org, _id, coverage) => coverage),
    recordRepositoryAssuranceStage: vi.fn(async (_org, _id, stage) => stage),
  } satisfies RepositoryAssurancePersistenceStore;
  return { store, spies: store };
}

describe("backend assurance run port", () => {
  it("binds the worker job and organization to every persistence call", async () => {
    const { store, spies } = fakeStore();
    const port = createBackendAssuranceRunPort(store, {
      organizationId: "org-1",
      jobId: "job-1",
    });
    const created = await port.create(run());
    expect(created.created).toBe(true);
    expect(spies.createRepositoryAssuranceRun).toHaveBeenCalledWith({
      jobId: "job-1",
      run: run(),
    });
    await port.get("run-1");
    expect(spies.getRepositoryAssuranceRun).toHaveBeenCalledWith("org-1", "run-1");
    await port.transition({
      runId: "run-1",
      status: "running",
      updatedAt: "2026-07-29T00:01:00.000Z",
    });
    expect(spies.transitionRepositoryAssuranceRun).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      status: "running",
      updatedAt: "2026-07-29T00:01:00.000Z",
    });
  });

  it("reports semantic idempotency when persistence returns another run id", async () => {
    const { store } = fakeStore("existing-run");
    const port = createBackendAssuranceRunPort(store, {
      organizationId: "org-1",
      jobId: "job-2",
    });
    const created = await port.create(run("proposed-run"));
    expect(created.created).toBe(false);
    expect(created.run.id).toBe("existing-run");
  });

  it("rejects a run whose policy attempts to cross the bound tenant", async () => {
    const { store, spies } = fakeStore();
    const port = createBackendAssuranceRunPort(store, {
      organizationId: "org-1",
      jobId: "job-1",
    });
    await expect(port.create(run("run-1", "other-org"))).rejects.toThrow(
      /does not match the bound worker tenant/,
    );
    expect(spies.createRepositoryAssuranceRun).not.toHaveBeenCalled();
  });
});
