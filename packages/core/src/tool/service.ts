/**
 * Tool service (ADR-008, Wave 2) — a stateless port over the local tool registry.
 * Additive and behaviour-preserving: every method delegates to the existing
 * registry functions. Stateless (no workspace binding), like the exec service.
 * No logic moved or removed.
 */
import type { AccessMode } from "../exec/execPolicy.js";
import {
  effectiveToolRegistry, registryAllowedTools, registryParallelSafeLocal,
  hideWorkerToolsFor, registryEntry, type LocalToolEntry,
} from "./registry.js";

/** The local tool-registry contract. */
export interface IToolService {
  effectiveRegistry(): LocalToolEntry[];
  allowedTools(mode: AccessMode): Set<string>;
  parallelSafeLocal(): Set<string>;
  hideWorkerTools(depth: number, tier?: string): boolean;
  entry(name: string): LocalToolEntry | undefined;
}

/** {@link IToolService} backed by the in-process tool registry — delegates only. */
export class ToolService implements IToolService {
  effectiveRegistry(): LocalToolEntry[] {
    return effectiveToolRegistry();
  }
  allowedTools(mode: AccessMode): Set<string> {
    return registryAllowedTools(mode);
  }
  parallelSafeLocal(): Set<string> {
    return registryParallelSafeLocal();
  }
  hideWorkerTools(depth: number, tier?: string): boolean {
    return hideWorkerToolsFor(depth, tier);
  }
  entry(name: string): LocalToolEntry | undefined {
    return registryEntry(name);
  }
}

/** Construct a tool registry service. */
export function createToolService(): IToolService {
  return new ToolService();
}
