/**
 * Backend assurance-finding port tenant and run binding fixtures.
 *
 * The Core verifier receives a minimal port that cannot select another
 * organization's finding or silently move a finding between assurance runs.
 */

import { describe, expect, it, vi } from "vitest";
import type { AssuranceFinding } from "@kinqs/brainrouter-types/review";
import {
  createBackendAssuranceFindingPort,
  type RepositoryAssuranceFindingPersistenceStore,
} from "./assuranceFindingPort.js";

function finding(): AssuranceFinding {
  return {
    id: "finding-1",
    fingerprint: "fingerprint-1",
    program: "security_review",
    revisionSha: "head-1",
    state: "candidate",
    severity: "high",
    confidence: 0.9,
    title: "Candidate finding",
    mechanism: "A sensitive operation may receive untrusted input.",
    location: { path: "src/example.ts", line: 10 },
    evidence: [],
    provenance: [],
    coverageLimitations: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

describe("backend assurance finding port", () => {
  it("pins every read and write to the worker organization and run", async () => {
    const persisted = finding();
    const store = {
      getRepositoryAssuranceFinding: vi.fn(async () => persisted),
      saveRepositoryAssuranceFinding: vi.fn(async () => persisted),
    } satisfies RepositoryAssuranceFindingPersistenceStore;
    const port = createBackendAssuranceFindingPort(store, {
      organizationId: "org-1",
      runId: "run-1",
    });

    await expect(port.get("finding-1")).resolves.toEqual(persisted);
    expect(store.getRepositoryAssuranceFinding).toHaveBeenCalledWith(
      "org-1",
      "run-1",
      "finding-1",
    );
    await expect(port.save(persisted)).resolves.toEqual(persisted);
    expect(store.saveRepositoryAssuranceFinding).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      finding: persisted,
    });
  });

  it("rejects empty tenant or run bindings before touching persistence", () => {
    const store = {
      getRepositoryAssuranceFinding: vi.fn(async () => null),
      saveRepositoryAssuranceFinding: vi.fn(async (input) => input.finding),
    } satisfies RepositoryAssuranceFindingPersistenceStore;
    expect(() => createBackendAssuranceFindingPort(store, {
      organizationId: "",
      runId: "run-1",
    })).toThrow(/organization id must be non-empty/);
    expect(() => createBackendAssuranceFindingPort(store, {
      organizationId: "org-1",
      runId: "",
    })).toThrow(/run id must be non-empty/);
    expect(store.getRepositoryAssuranceFinding).not.toHaveBeenCalled();
    expect(store.saveRepositoryAssuranceFinding).not.toHaveBeenCalled();
  });
});
