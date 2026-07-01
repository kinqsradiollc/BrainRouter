/**
 * Model gateway (ADR-008, Wave 1) — a cohesive service facade over the provider
 * module's existing model-resolution / registry / fallback logic.
 *
 * Additive and behaviour-preserving: every method delegates to the existing pure
 * functions in this module. It exists to give the "which model/provider + when to
 * fall back" capability a single typed PORT (`IModelGateway`) so it can be swapped
 * in tests, and later deployed behind ADR-005's embed-or-remote transport, without
 * touching callers. The port lives here (not in `@kinqs/brainrouter-types`) because
 * its `Config`/`LLMConfig` types live in core's config — putting it in types would
 * invert the package dependency.
 */
import type { Config, LLMConfig } from "../config/config.js";
import { listProviderNames, getProvider, resolveAgentLlm } from "./agentModels.js";
import { isModelNotFoundError, shouldFallbackModel } from "./modelFallback.js";

/** Config slice the gateway reads (providers registry + per-role assignments). */
export type ModelGatewayConfig = Pick<Config, "providers" | "agentModels">;

/** The model-resolution + provider-registry + fallback-policy service contract. */
export interface IModelGateway {
  /** Configured provider names, sorted. */
  listProviders(): string[];
  /** A named provider's LLM config, or undefined if not configured. */
  getProvider(name: string): LLMConfig | undefined;
  /** Resolve the LLM a sub-agent of `role` should use, given the parent's base LLM. */
  resolveForRole(baseLlm: LLMConfig, role: string): LLMConfig;
  /** Whether an error message indicates the model was not found. */
  isModelNotFound(message: string): boolean;
  /** Whether to fall back from `currentModel` to `fallbackModel` this turn. */
  shouldFallback(currentModel: string, fallbackModel: string | null | undefined, alreadyTried: boolean): boolean;
}

/** {@link IModelGateway} backed by the in-process provider module — delegates only. */
export class ModelGateway implements IModelGateway {
  constructor(private readonly config: ModelGatewayConfig) {}

  listProviders(): string[] {
    return listProviderNames(this.config);
  }
  getProvider(name: string): LLMConfig | undefined {
    return getProvider(this.config, name);
  }
  resolveForRole(baseLlm: LLMConfig, role: string): LLMConfig {
    return resolveAgentLlm(this.config, baseLlm, role);
  }
  isModelNotFound(message: string): boolean {
    return isModelNotFoundError(message);
  }
  shouldFallback(currentModel: string, fallbackModel: string | null | undefined, alreadyTried: boolean): boolean {
    return shouldFallbackModel(currentModel, fallbackModel, alreadyTried);
  }
}

/** Construct the default in-process model gateway. */
export function createModelGateway(config: ModelGatewayConfig): IModelGateway {
  return new ModelGateway(config);
}
