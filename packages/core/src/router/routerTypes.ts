import type { LLMConfig } from '../config/config.js';
import type { ProviderDefinition } from '../provider/providers/index.js';
import type { ProviderRecoveryFailureKind } from '@kinqs/brainrouter-types';

export type ModelRequest = string;
export type RouterStrategy = 'priority' | 'round-robin' | 'free-first';
export type CatalogPrefixMode = 'alias' | 'canonical' | 'bare';

export interface RouterRoute {
  slug: string;
  provider: string;
  model: string;
  llm: LLMConfig;
  providerDef?: ProviderDefinition;
}

export interface ModelRegistryEntry extends RouterRoute {
  label: string;
  endpoint?: string;
  cachedAt?: string;
}

export interface ModelRegistry {
  entries: ModelRegistryEntry[];
  bySlug: Map<string, ModelRegistryEntry>;
  modelToProviders: Map<string, string[]>;
  providerOrder: string[];
  aliases: Map<string, string>;
  chain: string[];
  strategy: RouterStrategy;
  passthroughProviders: string[];
}

export interface BuildModelRegistryOptions {
  aliases?: Record<string, string>;
  chain?: readonly string[];
  order?: readonly string[];
  strategy?: RouterStrategy;
  passThrough?: boolean;
  availableModels?: readonly string[];
  enforceAvailableModels?: boolean;
}

export interface CatalogModel {
  id: string;
  model: string;
  slug?: string;
  alias?: string;
  target?: string;
  providers: string[];
  provider?: string;
  endpoint?: string;
  cachedAt?: string;
}

export interface ResolveRoutesOptions {
  withFallbacks?: boolean;
  requireTools?: boolean;
  minContext?: number;
  role?: string;
  sessionKey?: string;
}

/** Compatibility alias; the shared receipt contract owns the canonical states. */
export type RouterFailureKind = ProviderRecoveryFailureKind;

export interface RouterFailure {
  kind: RouterFailureKind;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  message: string;
}
