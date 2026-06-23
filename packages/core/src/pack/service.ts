/**
 * Pack service (ADR-008, Wave 2) — a per-workspace port over the pack-enablement
 * store. Additive and behaviour-preserving: every method delegates to the
 * existing packStore functions; `workspaceRoot` is bound at construction. The
 * pure `isEnabled` predicate matches the store (it tests an explicit list). No
 * logic moved or removed.
 */
import {
  readPackState, isPackEnabled, enablePack, disablePack, type PackState,
} from "./packStore.js";

/** The pack-enablement store contract, scoped to one workspace. */
export interface IPackService {
  readState(): PackState;
  isEnabled(enabled: string[], name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
}

/** {@link IPackService} backed by the in-process pack store — delegates only. */
export class PackService implements IPackService {
  constructor(private readonly workspaceRoot: string) {}
  readState(): PackState {
    return readPackState(this.workspaceRoot);
  }
  isEnabled(enabled: string[], name: string): boolean {
    return isPackEnabled(enabled, name);
  }
  enable(name: string): void {
    return enablePack(this.workspaceRoot, name);
  }
  disable(name: string): void {
    return disablePack(this.workspaceRoot, name);
  }
}

/** Construct a pack service bound to a workspace. */
export function createPackService(workspaceRoot: string): IPackService {
  return new PackService(workspaceRoot);
}
