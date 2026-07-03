/**
 * Track service (ADR-008, Wave 2) — a per-workspace port over the Track work-item
 * store (Jira-class project/work-item state). Additive and behaviour-preserving:
 * every method delegates to the existing trackStore functions; `workspaceRoot` is
 * bound at construction. The GitHub-sync / commit-scanner / query / sprint
 * helpers stay importable as-is — this port covers the core store capability.
 */
import type { WorkItem, TrackProject, CodeLink } from "@kinqs/brainrouter-types";
import {
  ensureProject, getProject, createWorkItem, getWorkItem, listWorkItems,
  findWorkItemsByCodeLink, updateWorkItem, transitionWorkItem,
  type EnsureProjectInput, type CreateWorkItemInput, type WorkItemFilter, type UpdateWorkItemPatch,
} from "../trackStore.js";

/** The Track work-item store contract, scoped to one workspace. */
export interface ITrackService {
  ensureProject(input: EnsureProjectInput): TrackProject;
  getProject(): TrackProject | undefined;
  createWorkItem(input: CreateWorkItemInput): WorkItem;
  getWorkItem(idOrKey: string): WorkItem | undefined;
  listWorkItems(filter?: WorkItemFilter): WorkItem[];
  findByCodeLink(link: Pick<CodeLink, "kind" | "ref">): WorkItem[];
  updateWorkItem(idOrKey: string, patch: UpdateWorkItemPatch, actor?: string, skipAutomation?: boolean): WorkItem | undefined;
  transition(idOrKey: string, toStatus: string, actor?: string): WorkItem | undefined;
}

/** {@link ITrackService} backed by the in-process track store — delegates only. */
export class TrackService implements ITrackService {
  constructor(private readonly workspaceRoot: string) {}
  ensureProject(input: EnsureProjectInput): TrackProject {
    return ensureProject(this.workspaceRoot, input);
  }
  getProject(): TrackProject | undefined {
    return getProject(this.workspaceRoot);
  }
  createWorkItem(input: CreateWorkItemInput): WorkItem {
    return createWorkItem(this.workspaceRoot, input);
  }
  getWorkItem(idOrKey: string): WorkItem | undefined {
    return getWorkItem(this.workspaceRoot, idOrKey);
  }
  listWorkItems(filter?: WorkItemFilter): WorkItem[] {
    return listWorkItems(this.workspaceRoot, filter);
  }
  findByCodeLink(link: Pick<CodeLink, "kind" | "ref">): WorkItem[] {
    return findWorkItemsByCodeLink(this.workspaceRoot, link);
  }
  updateWorkItem(idOrKey: string, patch: UpdateWorkItemPatch, actor?: string, skipAutomation?: boolean): WorkItem | undefined {
    return updateWorkItem(this.workspaceRoot, idOrKey, patch, actor, skipAutomation);
  }
  transition(idOrKey: string, toStatus: string, actor?: string): WorkItem | undefined {
    return transitionWorkItem(this.workspaceRoot, idOrKey, toStatus, actor);
  }
}

/** Construct a track service bound to a workspace. */
export function createTrackService(workspaceRoot: string): ITrackService {
  return new TrackService(workspaceRoot);
}
