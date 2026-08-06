/**
 * Purpose: Build and project the provider/model registry used for routing.
 */
import type { LLMConfig } from '../../config/config.js';
import {
  findProviderByEndpoint,
  PROVIDER_REGISTRY,
  type ProviderDefinition,
} from '../providers/index.js';
import type {
  BuildModelRegistryOptions,
  CatalogModel,
  CatalogPrefixMode,
  ModelRegistry,
  ModelRegistryEntry,
  RouterStrategy,
} from './types.js';

function cleanStringList(input: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input ?? []) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function cleanAliases(input: Record<string, string> | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [rawKey, rawTarget] of Object.entries(input ?? {})) {
    const key = rawKey.trim();
    const target = rawTarget.trim();
    if (!key || !target || key.includes('/')) continue;
    aliases.set(key, target);
  }
  return aliases;
}

function allowedModel(slug: string, model: string, opts: BuildModelRegistryOptions): boolean {
  if (!opts.enforceAvailableModels) return true;
  const allowed = new Set(cleanStringList(opts.availableModels));
  if (allowed.size === 0) return false;
  return allowed.has(slug) || allowed.has(model);
}

function providerDefFor(name: string, llm: LLMConfig): ProviderDefinition | undefined {
  return findProviderByEndpoint(llm.endpoint) ?? PROVIDER_REGISTRY.get((llm.provider || name).toLowerCase());
}

/**
 * Every model this provider can be asked for.
 *
 * `cachedModels` is what the provider's `/models` endpoint advertised.
 * `models` is what the PERSON configured. The two used to be INTERSECTED, so a
 * model you added by hand and the endpoint did not list was silently dropped —
 * which is every fine-tune, every self-hosted deployment, every model newer
 * than the last catalog fetch, and anything behind a gateway that does not
 * enumerate. The symptom was "only models added on the backend work".
 *
 * A discovery list is not an allowlist. If you typed a model name into your own
 * config, you are asserting it exists, and we are not better placed to know
 * than you are — a wrong name fails at the provider with a clear error, which
 * is a far better outcome than the model quietly not being there.
 *
 * So: union, with the configured names first, because they were chosen
 * deliberately and the discovered ones merely exist.
 */
function modelListFor(llm: LLMConfig, passThrough: boolean): string[] {
  const curated = cleanStringList(llm.models);
  const cached = cleanStringList(llm.cachedModels);
  if (passThrough && cached.length > 0) {
    const seen = new Set(curated);
    return [...curated, ...cached.filter((model) => !seen.has(model))];
  }
  if (curated.length > 0) return curated;
  return cleanStringList([llm.model]);
}

function normalizeStrategy(value: RouterStrategy | undefined): RouterStrategy {
  return value === 'round-robin' || value === 'free-first' ? value : 'priority';
}

export function buildModelRegistry(
  providers: Record<string, LLMConfig> | undefined,
  opts: BuildModelRegistryOptions = {},
): ModelRegistry {
  const configured = providers ?? {};
  const order = cleanStringList(opts.order);
  const providerOrder = [
    ...order.filter((name) => configured[name]),
    ...Object.keys(configured).filter((name) => !order.includes(name)),
  ];
  const entries: ModelRegistryEntry[] = [];
  const bySlug = new Map<string, ModelRegistryEntry>();
  const modelToProviders = new Map<string, string[]>();
  const passThrough = opts.passThrough !== false;

  for (const provider of providerOrder) {
    const llm = configured[provider];
    if (!llm) continue;
    const def = providerDefFor(provider, llm);
    for (const model of modelListFor(llm, passThrough)) {
      const slug = `${provider}/${model}`;
      if (!allowedModel(slug, model, opts)) continue;
      const entry: ModelRegistryEntry = {
        slug,
        provider,
        model,
        label: `${model} — ${provider}`,
        endpoint: llm.endpoint || def?.endpoint,
        cachedAt: llm.cachedAt,
        llm: { ...llm, model },
        providerDef: def,
      };
      delete entry.llm.models;
      delete entry.llm.cachedModels;
      bySlug.set(slug, entry);
      entries.push(entry);
      const owners = modelToProviders.get(model) ?? [];
      owners.push(provider);
      modelToProviders.set(model, owners);
    }
  }

  const passthroughProviders = providerOrder.filter((name) => configured[name]?.passthroughUnknown === true);
  return {
    entries,
    bySlug,
    modelToProviders,
    providerOrder,
    aliases: cleanAliases(opts.aliases),
    chain: cleanStringList(opts.chain),
    strategy: normalizeStrategy(opts.strategy),
    passthroughProviders,
  };
}

export function aggregateCatalog(
  registry: ModelRegistry,
  opts: { prefix?: CatalogPrefixMode; query?: string } = {},
): CatalogModel[] {
  const prefix = opts.prefix ?? 'canonical';
  const query = (opts.query ?? '').trim().toLowerCase();
  const matches = (item: CatalogModel) => {
    if (!query) return true;
    return [item.id, item.model, item.slug, item.alias, item.target, item.provider, ...item.providers]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  };
  const out: CatalogModel[] = [];

  if (prefix === 'alias') {
    for (const [alias, target] of registry.aliases) {
      const targetRoutes = registry.bySlug.get(target)
        ? [registry.bySlug.get(target)!]
        : registry.entries.filter((entry) => entry.model === target);
      const providers = [...new Set(targetRoutes.map((route) => route.provider))];
      const item: CatalogModel = { id: alias, alias, target, model: alias, providers };
      if (matches(item)) out.push(item);
    }
    return out;
  }

  if (prefix === 'bare') {
    for (const [model, providers] of registry.modelToProviders) {
      const first = registry.entries.find((entry) => entry.model === model);
      const item: CatalogModel = {
        id: model,
        model,
        providers: [...providers],
        endpoint: first?.endpoint,
        cachedAt: first?.cachedAt,
      };
      if (matches(item)) out.push(item);
    }
    return out;
  }

  for (const entry of registry.entries) {
    const item: CatalogModel = {
      id: entry.slug,
      slug: entry.slug,
      model: entry.model,
      provider: entry.provider,
      providers: [entry.provider],
      endpoint: entry.endpoint,
      cachedAt: entry.cachedAt,
    };
    if (matches(item)) out.push(item);
  }
  return out;
}
