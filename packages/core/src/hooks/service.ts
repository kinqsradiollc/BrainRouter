/**
 * Hooks service (ADR-008, Wave 2) — a per-workspace port over the user-hooks
 * store (event → shell command). Additive and behaviour-preserving: every method
 * delegates to the existing hooksStore functions; `workspaceRoot` is bound at
 * construction. `parseDecision` is the one pure helper folded in. The hookify
 * rule engine (hookifyStore.ts) stays importable as its own module. No logic
 * moved or removed.
 */
import {
  readHooks, addHook, removeHook, setHookEnabled, runHooks, parseHookDecision,
  type Hook, type HookEvent, type HookRunResult, type HookDecision,
} from "./hooksStore.js";

/** Input accepted by {@link IHooksService.add} — the store's exact shape. */
export type AddHookInput = Parameters<typeof addHook>[1];
/** Run context accepted by {@link IHooksService.run} — the store's exact shape. */
export type HookRunContext = Parameters<typeof runHooks>[2];

/** The user-hooks store contract, scoped to one workspace. */
export interface IHooksService {
  read(): Hook[];
  add(input: AddHookInput): Hook;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
  run(event: HookEvent, context?: HookRunContext, timeoutMs?: number): HookRunResult[];
  parseDecision(stdout: string): HookDecision | null;
}

/** {@link IHooksService} backed by the in-process hooks store — delegates only. */
export class HooksService implements IHooksService {
  constructor(private readonly workspaceRoot: string) {}
  read(): Hook[] {
    return readHooks(this.workspaceRoot);
  }
  add(input: AddHookInput): Hook {
    return addHook(this.workspaceRoot, input);
  }
  remove(id: string): boolean {
    return removeHook(this.workspaceRoot, id);
  }
  setEnabled(id: string, enabled: boolean): boolean {
    return setHookEnabled(this.workspaceRoot, id, enabled);
  }
  run(event: HookEvent, context?: HookRunContext, timeoutMs?: number): HookRunResult[] {
    if (context === undefined) return runHooks(this.workspaceRoot, event);
    if (timeoutMs === undefined) return runHooks(this.workspaceRoot, event, context);
    return runHooks(this.workspaceRoot, event, context, timeoutMs);
  }
  parseDecision(stdout: string): HookDecision | null {
    return parseHookDecision(stdout);
  }
}

/** Construct a hooks service bound to a workspace. */
export function createHooksService(workspaceRoot: string): IHooksService {
  return new HooksService(workspaceRoot);
}
