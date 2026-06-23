/**
 * Workspace service (ADR-008, Wave 2) — a stateless port over workspace-root
 * resolution and the workspace trust store. Operates on roots passed in, so no
 * binding. Additive and behaviour-preserving: every method delegates to the
 * existing workspace / workspaceTrust functions. No logic moved or removed.
 */
import { findWorkspaceRoot, applyWorkspaceRoot, type WorkspaceInfo } from "./workspace.js";
import {
  isWorkspaceTrusted, listTrustedWorkspaces, trustWorkspace, untrustWorkspace,
} from "./workspaceTrust.js";

/** The workspace-resolution + trust contract. */
export interface IWorkspaceService {
  findRoot(startDir?: string): WorkspaceInfo;
  applyRoot(workspaceRoot: string): void;
  isTrusted(root: string): boolean;
  listTrusted(): string[];
  trust(root: string): void;
  untrust(root: string): void;
}

/** {@link IWorkspaceService} backed by the in-process workspace helpers — delegates only. */
export class WorkspaceService implements IWorkspaceService {
  findRoot(startDir?: string): WorkspaceInfo {
    return startDir === undefined ? findWorkspaceRoot() : findWorkspaceRoot(startDir);
  }
  applyRoot(workspaceRoot: string): void {
    return applyWorkspaceRoot(workspaceRoot);
  }
  isTrusted(root: string): boolean {
    return isWorkspaceTrusted(root);
  }
  listTrusted(): string[] {
    return listTrustedWorkspaces();
  }
  trust(root: string): void {
    return trustWorkspace(root);
  }
  untrust(root: string): void {
    return untrustWorkspace(root);
  }
}

/** Construct a workspace service. */
export function createWorkspaceService(): IWorkspaceService {
  return new WorkspaceService();
}
