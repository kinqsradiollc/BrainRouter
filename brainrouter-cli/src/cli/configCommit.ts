/**
 * Publish a complete config projection only after its durable write succeeds.
 * The long-lived REPL object keeps its identity, while observers can never see
 * a candidate that has not crossed the persistence boundary.
 */
import {
  saveConfigOrThrow,
  type Config,
} from '@kinqs/brainrouter-core/config';

const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function replaceConfigContents(target: Config, committed: Config): void {
  const mutable = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    if (!Object.prototype.hasOwnProperty.call(committed, key) || UNSAFE_CONFIG_KEYS.has(key)) {
      delete mutable[key];
    }
  }

  Object.setPrototypeOf(mutable, Object.prototype);
  const cloned = structuredClone(committed) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(cloned)) {
    if (UNSAFE_CONFIG_KEYS.has(key)) continue;
    Object.defineProperty(mutable, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

export function commitConfigProjection(
  config: Config,
  project: (candidate: Config) => void,
  persist: (candidate: Config) => void = saveConfigOrThrow,
): Config {
  const candidate = structuredClone(config);
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  for (const key of UNSAFE_CONFIG_KEYS) delete candidateRecord[key];
  project(candidate);
  persist(candidate);
  replaceConfigContents(config, candidate);
  return candidate;
}
