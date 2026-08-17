import type { ProviderDefinition } from './definition.js';

/** A one-shot handle that removes a runtime registration (ADR-041 D1). */
export interface ProviderRegistryHandle {
  dispose(): void;
}

/**
 * ADR-041 D1 — the live provider registry.
 *
 * Replaces the former `PROVIDER_REGISTRY: ReadonlyMap` with a class that keeps the
 * exact same read surface the routing/catalog code already uses (`get` / `has`),
 * so nothing at the read sites changes, PLUS a runtime mutation surface:
 * `register(def)` returns a disposable handle, `replace(def)` swaps a definition.
 * Compiled-in builtins seed the registry and are authoritative — `hasBuiltin`
 * lets the catalog keep "a built-in id wins" without conflating it with a runtime
 * registration.
 *
 * Definitions are immutable snapshots: a caller that already read a definition
 * keeps using it, so `replace`/`dispose` never mutate an in-flight turn's copy —
 * a subsequent `get` simply returns the new one.
 *
 * Scope note: this lands the registry class + its `register`/`replace`/`dispose`
 * API (the seam ADR-043's `ProviderDialer` and the extension host will plug into).
 * Unifying the existing extension-provider path (`registerExtensionProvider`) onto
 * `register()` — with its reload-lifecycle dispose semantics — is the remaining
 * half of D1 and is deliberately left as a follow-up so this slice ships with zero
 * behaviour change.
 */
export class ProviderRegistry {
  readonly #builtins: Map<string, ProviderDefinition>;
  readonly #dynamic = new Map<string, ProviderDefinition>();

  constructor(builtins: readonly ProviderDefinition[]) {
    this.#builtins = new Map(builtins.map((p) => [p.id, p]));
  }

  /** Runtime registrations win over a builtin of the same id (the swap case). */
  get(id: string): ProviderDefinition | undefined {
    return this.#dynamic.get(id) ?? this.#builtins.get(id);
  }

  has(id: string): boolean {
    return this.#dynamic.has(id) || this.#builtins.has(id);
  }

  /** True only for a compiled-in builtin — NOT a runtime registration. */
  hasBuiltin(id: string): boolean {
    return this.#builtins.has(id);
  }

  /** All definitions, runtime registrations shadowing builtins of the same id. */
  entries(): IterableIterator<[string, ProviderDefinition]> {
    return this.#merged().entries();
  }

  values(): IterableIterator<ProviderDefinition> {
    return this.#merged().values();
  }

  /**
   * Register a provider at runtime. The returned handle removes it again,
   * restoring any prior registration of the same id (never a builtin — builtins
   * are never deleted). Idempotent dispose.
   */
  register(def: ProviderDefinition): ProviderRegistryHandle {
    const prior = this.#dynamic.get(def.id);
    this.#dynamic.set(def.id, def);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Only unwind if we are still the active registration for this id.
        if (this.#dynamic.get(def.id) !== def) return;
        if (prior) this.#dynamic.set(def.id, prior);
        else this.#dynamic.delete(def.id);
      },
    };
  }

  /** Atomically swap a definition (immutable snapshot; in-flight reads keep theirs). */
  replace(def: ProviderDefinition): void {
    this.#dynamic.set(def.id, def);
  }

  #merged(): Map<string, ProviderDefinition> {
    const out = new Map(this.#builtins);
    for (const [id, def] of this.#dynamic) out.set(id, def);
    return out;
  }
}
