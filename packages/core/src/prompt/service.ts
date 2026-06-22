/**
 * Prompt service (ADR-008, Wave 2) — a stateless port over the system-prompt
 * builder. Additive and behaviour-preserving: every method delegates to the
 * existing systemPrompt functions. The compaction / steering / next-action
 * helpers stay importable as module utilities. No logic moved or removed.
 */
import {
  buildSystemPrompt, loadWorkspaceInstructionSummary, type SystemPromptContext,
} from "./systemPrompt.js";

/** The system-prompt building contract. */
export interface IPromptService {
  build(context: SystemPromptContext): string;
  loadWorkspaceInstructionSummary(workspaceRoot: string): string | undefined;
}

/** {@link IPromptService} backed by the in-process system-prompt builder — delegates only. */
export class PromptService implements IPromptService {
  build(context: SystemPromptContext): string {
    return buildSystemPrompt(context);
  }
  loadWorkspaceInstructionSummary(workspaceRoot: string): string | undefined {
    return loadWorkspaceInstructionSummary(workspaceRoot);
  }
}

/** Construct a prompt service. */
export function createPromptService(): IPromptService {
  return new PromptService();
}
