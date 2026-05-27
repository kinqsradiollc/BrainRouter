/**
 * JSON-config loader (0.3.9 follow-up — externalised hardcoded tables).
 *
 * Four tables used to live as inline `Record<string, …>` constants in
 * TypeScript:
 *
 *   - DEFAULT_CONTEXT_WINDOWS   (runtime/contextWindow.ts)
 *   - DEFAULT_PRICING           (runtime/pricing.ts)
 *   - DEFAULT_LADDERS           (runtime/tierLadder.ts)
 *   - PROVIDER_CATALOG + KNOWN_PREFIXES + FOREIGN_PREFIXES (cli/wizard/*, cli/commands/ui.ts)
 *
 * Vendors change pricing, ship new model families, and rename SKUs faster
 * than we re-cut releases. Holding those facts in source code means every
 * vendor update is a patch-release PR. Moving them to ship-with-the-package
 * JSON files lets users edit them in place (or contribute updates via PR
 * without touching TS), and lets `~/.config/brainrouter/*.json` overrides
 * win for anyone with a custom contract.
 *
 * Layout:
 *
 *   brainrouter-cli/config/
 *     ├── models.json           — id → {contextWindow, pricing}, plus
 *     │                           familyFallbacks for versioned variants.
 *     ├── providers.json        — provider id → {endpoint, envKey, models,
 *     │                           defaultModel, hint, label, tierLadder?}.
 *     └── api-key-prefixes.json — {known: [...], foreignModelPrefixes: [...]}.
 *
 * The loader is sync-on-first-read + cached. Missing files throw a clear
 * "corrupted install" error. Malformed JSON logs a warning and yields an
 * empty table for that file — the runtime still boots; lookup just returns
 * undefined for every key until the file is fixed.
 *
 * User-override merge happens in the individual consumer modules
 * (`runtime/contextWindow.ts` etc.) so this loader stays a pure read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `dist/runtime/configLoader.js` → `dist/../../config` (sibling of src and dist).
const CONFIG_DIR = path.resolve(HERE, '..', '..', 'config');

// ---- shapes ------------------------------------------------------------

export interface ModelPricing {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

export interface ModelEntry {
  contextWindow?: number;
  pricing?: ModelPricing;
}

export interface FamilyFallback {
  /** Regex source (string), compiled once on load. Anchored on the caller. */
  match: string;
  /** Model id (already a key in `models`) to fall back to. */
  fallbackTo: string;
}

export interface ModelsConfig {
  models: Record<string, ModelEntry>;
  /** Pre-compiled family-fallback regexes for versioned variants. */
  familyFallbacks: Array<{ pattern: RegExp; fallbackTo: string }>;
}

export interface ProviderTierLadder {
  flash: string;
  standard: string;
  pro: string;
}

export interface ProviderEntry {
  /** When false, the entry is tier-ladder-only and won't appear in the picker. */
  pickerVisible?: boolean;
  label?: string;
  hint?: string;
  endpoint?: string;
  envKey?: string;
  local?: boolean;
  models?: string[];
  defaultModel?: string;
  tierLadder?: ProviderTierLadder;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderEntry>;
}

export interface PrefixEntry {
  prefix: string;
  vendor: string;
}

export interface ApiKeyPrefixesConfig {
  known: PrefixEntry[];
  foreignModelPrefixes: PrefixEntry[];
}

// ---- loaders -----------------------------------------------------------

let cachedModels: ModelsConfig | undefined;
let cachedProviders: ProvidersConfig | undefined;
let cachedPrefixes: ApiKeyPrefixesConfig | undefined;

/**
 * Read + parse a JSON file from `config/`. Throws when the file is missing
 * (corrupted install) so the user sees a clear error instead of empty
 * lookups everywhere. Logs a warning when the JSON is malformed and
 * returns `null` so the caller can fall back to an empty default for that
 * table.
 */
function readJsonFile<T>(filename: string): T {
  const fullPath = path.join(CONFIG_DIR, filename);
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `BrainRouter CLI config file missing: ${fullPath}. ` +
        `This usually means a corrupted install — reinstall with \`npm install -g @kinqs/brainrouter-cli\` ` +
        `or restore the file from the npm package.`,
      );
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`[BrainRouter] config/${filename} is malformed JSON — using empty defaults. (${(err as Error).message})`);
    // Cast through unknown so the caller's typed `T` shape is preserved.
    return {} as unknown as T;
  }
}

export function loadModelsConfig(): ModelsConfig {
  if (cachedModels) return cachedModels;
  type RawShape = {
    models?: Record<string, ModelEntry>;
    familyFallbacks?: FamilyFallback[];
  };
  const raw = readJsonFile<RawShape>('models.json');
  const compiled: ModelsConfig = {
    models: raw.models ?? {},
    familyFallbacks: (raw.familyFallbacks ?? []).flatMap((fb) => {
      try {
        return [{ pattern: new RegExp(fb.match), fallbackTo: fb.fallbackTo }];
      } catch (err) {
        console.error(`[BrainRouter] models.json familyFallbacks regex "${fb.match}" is invalid: ${(err as Error).message}`);
        return [];
      }
    }),
  };
  cachedModels = compiled;
  return cachedModels;
}

export function loadProvidersConfig(): ProvidersConfig {
  if (cachedProviders) return cachedProviders;
  type RawShape = { providers?: Record<string, ProviderEntry> };
  const raw = readJsonFile<RawShape>('providers.json');
  cachedProviders = { providers: raw.providers ?? {} };
  return cachedProviders;
}

export function loadApiKeyPrefixesConfig(): ApiKeyPrefixesConfig {
  if (cachedPrefixes) return cachedPrefixes;
  type RawShape = { known?: PrefixEntry[]; foreignModelPrefixes?: PrefixEntry[] };
  const raw = readJsonFile<RawShape>('api-key-prefixes.json');
  cachedPrefixes = {
    known: raw.known ?? [],
    foreignModelPrefixes: raw.foreignModelPrefixes ?? [],
  };
  return cachedPrefixes;
}

/** Test hook — drop the in-memory cache so a subsequent load re-reads disk. */
export function _resetConfigCache(): void {
  cachedModels = undefined;
  cachedProviders = undefined;
  cachedPrefixes = undefined;
}
