/**
 * Context service (ADR-008, Wave 2) — a stateless port over context-window
 * sizing. Additive and behaviour-preserving: every method delegates to the
 * existing contextWindow functions. The prefix-stability primitives in
 * contextRegions.ts are already classes (their own boundary) and stay importable.
 * No logic moved or removed.
 */
import {
  contextWindowFor, formatContextWindow, _resetContextWindowCache,
} from "./contextWindow.js";

/** The context-window sizing contract. */
export interface IContextService {
  windowFor(modelId: string | undefined | null): number | undefined;
  format(modelId: string | undefined | null): string;
  resetCache(): void;
}

/** {@link IContextService} backed by the in-process context-window table — delegates only. */
export class ContextService implements IContextService {
  windowFor(modelId: string | undefined | null): number | undefined {
    return contextWindowFor(modelId);
  }
  format(modelId: string | undefined | null): string {
    return formatContextWindow(modelId);
  }
  resetCache(): void {
    return _resetContextWindowCache();
  }
}

/** Construct a context service. */
export function createContextService(): IContextService {
  return new ContextService();
}
