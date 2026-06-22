/**
 * Exec service (ADR-008, Wave 1) — a cohesive port over the execution-policy /
 * command-safety logic in this module.
 *
 * Additive and behaviour-preserving: every method delegates to the existing pure
 * functions (`decideExecutionPolicy`, `evaluateCommandPolicy`, `isDangerousCommand`,
 * `resolveRunCommandApproval`, `evaluateDestructiveCommand`). It gives "is this
 * command allowed, dangerous, destructive, and does it need approval?" a single
 * typed port (`IExecService`) so it can be isolated/sandboxed (ADR-006 driver D1)
 * or deployed behind ADR-005's transport later — without touching callers. No
 * logic moved or removed. The port lives here because its result types live here.
 */
import { decideExecutionPolicy, type AccessMode, type ActionKind, type PolicyResult } from "./execPolicy.js";
import { evaluateCommandPolicy, type CommandPolicy } from "./commandPolicy.js";
import { isDangerousCommand, resolveRunCommandApproval, type RunCommandApproval } from "./dangerousCommand.js";
import { evaluateDestructiveCommand, type DestructiveContext, type DestructiveVerdict } from "./destructiveCommandGuard.js";

/** The execution-policy + command-safety service contract. */
export interface IExecService {
  /** Allow/ask/deny for an action kind under an access mode. */
  policyFor(action: ActionKind, mode: AccessMode): PolicyResult;
  /** Classify a shell command's segments against the allowlist. */
  classifyCommand(command: string, allowlist?: string[]): CommandPolicy;
  /** Whether a command is in the dangerous set. */
  isDangerous(command: string): boolean;
  /** What should happen when the agent runs `command` (auto-approve / ask / deny-silent). */
  resolveApproval(
    prefs: { executionMode: "planning" | "fast" },
    command: string,
    opts: { silent: boolean; goalActive?: boolean; allowlist?: string[] },
  ): RunCommandApproval;
  /** Whether a command is destructive (discard work / amend foreign / iac destroy). */
  checkDestructive(command: string, ctx?: DestructiveContext): DestructiveVerdict;
}

/** {@link IExecService} backed by the in-process exec module — delegates only. */
export class ExecService implements IExecService {
  policyFor(action: ActionKind, mode: AccessMode): PolicyResult {
    return decideExecutionPolicy(action, mode);
  }
  classifyCommand(command: string, allowlist: string[] = []): CommandPolicy {
    return evaluateCommandPolicy(command, allowlist);
  }
  isDangerous(command: string): boolean {
    return isDangerousCommand(command);
  }
  resolveApproval(
    prefs: { executionMode: "planning" | "fast" },
    command: string,
    opts: { silent: boolean; goalActive?: boolean; allowlist?: string[] },
  ): RunCommandApproval {
    return resolveRunCommandApproval(prefs, command, opts);
  }
  checkDestructive(command: string, ctx: DestructiveContext = {}): DestructiveVerdict {
    return evaluateDestructiveCommand(command, ctx);
  }
}

/** Construct the default in-process exec service. */
export function createExecService(): IExecService {
  return new ExecService();
}
