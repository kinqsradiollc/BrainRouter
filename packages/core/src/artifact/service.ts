/**
 * Artifact service (ADR-008, Wave 2) — a per-workspace port over the artifact
 * store (with version history). Additive and behaviour-preserving: every method
 * delegates to the existing artifactStore functions; `workspaceRoot` is bound at
 * construction. No logic moved or removed.
 */
import type { ArtifactRecord, ArtifactVersion } from "@kinqs/brainrouter-types";
import {
  readArtifactsAll, getArtifact, createArtifact, updateArtifact,
  listArtifactVersions, getArtifactVersion, revertArtifact,
  listArtifacts, linkArtifact, deleteArtifact,
  type CreateArtifactInput, type ArtifactPatch, type ArtifactFilter, type ArtifactVersionOpts,
} from "./artifactStore.js";

/** The artifact store contract (with version history), scoped to one workspace. */
export interface IArtifactService {
  readAll(): Record<string, ArtifactRecord>;
  get(id: string): ArtifactRecord | undefined;
  create(input: CreateArtifactInput): ArtifactRecord;
  update(id: string, patch: ArtifactPatch, opts?: ArtifactVersionOpts): ArtifactRecord | undefined;
  listVersions(id: string): ArtifactVersion[];
  getVersion(id: string, v: number): ArtifactVersion | undefined;
  revert(id: string, targetVersion: number, opts?: ArtifactVersionOpts): ArtifactRecord | undefined;
  list(filter?: ArtifactFilter): ArtifactRecord[];
  link(id: string, link: { memoryId?: string }): ArtifactRecord | undefined;
  delete(id: string): boolean;
}

/** {@link IArtifactService} backed by the in-process artifact store — delegates only. */
export class ArtifactService implements IArtifactService {
  constructor(private readonly workspaceRoot: string) {}
  readAll(): Record<string, ArtifactRecord> {
    return readArtifactsAll(this.workspaceRoot);
  }
  get(id: string): ArtifactRecord | undefined {
    return getArtifact(this.workspaceRoot, id);
  }
  create(input: CreateArtifactInput): ArtifactRecord {
    return createArtifact(this.workspaceRoot, input);
  }
  update(id: string, patch: ArtifactPatch, opts?: ArtifactVersionOpts): ArtifactRecord | undefined {
    return updateArtifact(this.workspaceRoot, id, patch, opts);
  }
  listVersions(id: string): ArtifactVersion[] {
    return listArtifactVersions(this.workspaceRoot, id);
  }
  getVersion(id: string, v: number): ArtifactVersion | undefined {
    return getArtifactVersion(this.workspaceRoot, id, v);
  }
  revert(id: string, targetVersion: number, opts?: ArtifactVersionOpts): ArtifactRecord | undefined {
    return revertArtifact(this.workspaceRoot, id, targetVersion, opts);
  }
  list(filter?: ArtifactFilter): ArtifactRecord[] {
    return listArtifacts(this.workspaceRoot, filter);
  }
  link(id: string, link: { memoryId?: string }): ArtifactRecord | undefined {
    return linkArtifact(this.workspaceRoot, id, link);
  }
  delete(id: string): boolean {
    return deleteArtifact(this.workspaceRoot, id);
  }
}

/** Construct an artifact service bound to a workspace. */
export function createArtifactService(workspaceRoot: string): IArtifactService {
  return new ArtifactService(workspaceRoot);
}
