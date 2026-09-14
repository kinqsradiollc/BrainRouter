/**
 * Purpose: Resolve explicit, aliased, and policy-ordered model route requests.
 */
import type { ModelRegistry, ModelRegistryEntry, ResolveRoutesOptions } from './types.js';

function uniqueRoutes(routes: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const out: ModelRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.slug)) continue;
    seen.add(route.slug);
    out.push(route);
  }
  return out;
}

function canUseRoute(route: ModelRegistryEntry, opts: ResolveRoutesOptions): boolean {
  if (opts.requireTools && (route.providerDef as any)?.supportsTools === false) return false;
  const context = (route.providerDef as any)?.contextWindow;
  if (typeof opts.minContext === 'number' && typeof context === 'number' && context < opts.minContext) {
    return false;
  }
  return true;
}

function orderBareModelRoutes(registry: ModelRegistry, routes: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const rank = new Map(registry.providerOrder.map((provider, index) => [provider, index]));
  const ordered = [...routes].sort((a, b) => (rank.get(a.provider) ?? 9999) - (rank.get(b.provider) ?? 9999));
  if (registry.strategy !== 'free-first') return ordered;
  return ordered.sort((a, b) => {
    const af = a.llm.free === true || a.providerDef?.local === true ? 0 : 1;
    const bf = b.llm.free === true || b.providerDef?.local === true ? 0 : 1;
    return af - bf || (rank.get(a.provider) ?? 9999) - (rank.get(b.provider) ?? 9999);
  });
}

function resolveOne(
  registry: ModelRegistry,
  request: string,
  opts: ResolveRoutesOptions,
  seenAliases = new Set<string>(),
): ModelRegistryEntry[] {
  const value = request.trim();
  if (!value || value === 'auto') return resolvePrimaryChain(registry, opts);

  const slash = value.indexOf('/');
  if (slash > 0) {
    const maybeProvider = value.slice(0, slash);
    if (registry.providerOrder.includes(maybeProvider)) {
      const exact = registry.bySlug.get(value);
      return exact && canUseRoute(exact, opts) ? [exact] : [];
    }
  }

  const aliasTarget = registry.aliases.get(value);
  if (aliasTarget && !seenAliases.has(value)) {
    seenAliases.add(value);
    return resolveOne(registry, aliasTarget, opts, seenAliases);
  }

  const providers = registry.modelToProviders.get(value) ?? [];
  if (providers.length > 0) {
    const routes = providers
      .map((provider) => registry.bySlug.get(`${provider}/${value}`))
      .filter((route): route is ModelRegistryEntry => !!route && canUseRoute(route, opts));
    return orderBareModelRoutes(registry, routes);
  }

  if (registry.passthroughProviders.length >= 1) {
    // The model is in no catalog. Offer it to the passthrough provider(s) first,
    // then — when fallbacks are allowed (the gateway path uses withFallbacks) — to
    // the other configured UPSTREAM providers, so a capacity / not-found failure on
    // one provider falls through instead of dead-ending on a single passthrough
    // route (the "no matter what model, it fails" case). The local router gateway
    // (provider kind 'brainrouter') is never a passthrough fallback target — routing
    // an unknown model back into the gateway would loop.
    const providerKind = (name: string): string | undefined =>
      registry.entries.find((entry) => entry.provider === name)?.llm.provider;
    const fallbackProviders = opts.withFallbacks
      ? registry.providerOrder.filter(
        (name) => !registry.passthroughProviders.includes(name) && providerKind(name) !== 'brainrouter',
      )
      : [];
    const routes: ModelRegistryEntry[] = [];
    for (const provider of [...registry.passthroughProviders, ...fallbackProviders]) {
      const template = registry.entries.find((entry) => entry.provider === provider);
      if (!template) continue;
      routes.push({
        ...template,
        slug: `${provider}/${value}`,
        model: value,
        label: `${value} — ${provider}`,
        llm: { ...template.llm, model: value },
      });
    }
    return routes;
  }

  return [];
}

function resolvePrimaryChain(registry: ModelRegistry, opts: ResolveRoutesOptions): ModelRegistryEntry[] {
  const routes: ModelRegistryEntry[] = [];
  for (const request of registry.chain) {
    routes.push(...resolveOne(registry, request, { ...opts, withFallbacks: false }));
  }
  return uniqueRoutes(routes);
}

export function resolveRoutes(
  registry: ModelRegistry,
  request: string | undefined | null,
  opts: ResolveRoutesOptions = {},
): ModelRegistryEntry[] {
  const routes = resolveOne(registry, request ?? '', opts);
  if (!opts.withFallbacks || !request || request.trim() === '' || request.trim() === 'auto') {
    return uniqueRoutes(routes);
  }
  return uniqueRoutes([...routes, ...resolvePrimaryChain(registry, opts)]);
}
