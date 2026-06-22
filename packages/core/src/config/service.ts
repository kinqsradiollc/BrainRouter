/**
 * Config service (ADR-008, Wave 2) — a stateless port over the app config
 * (config.json) lifecycle. Additive and behaviour-preserving: every method
 * delegates to the existing config functions. The models/pricing loaders in
 * configLoader.ts are a separate concern and stay importable. No logic moved or
 * removed.
 */
import {
  getConfigPath, loadConfig, loadOrInitConfig, saveConfig, backfillApiKeyFromEnv,
  type Config,
} from "./config.js";

/** The app-config lifecycle contract. */
export interface IConfigService {
  getPath(): string;
  load(): Config;
  loadOrInit(): Config;
  save(config: Config): void;
  backfillApiKeyFromEnv(endpoint: string | undefined): string | undefined;
}

/** {@link IConfigService} backed by the on-disk config — delegates only. */
export class ConfigService implements IConfigService {
  getPath(): string {
    return getConfigPath();
  }
  load(): Config {
    return loadConfig();
  }
  loadOrInit(): Config {
    return loadOrInitConfig();
  }
  save(config: Config): void {
    return saveConfig(config);
  }
  backfillApiKeyFromEnv(endpoint: string | undefined): string | undefined {
    return backfillApiKeyFromEnv(endpoint);
  }
}

/** Construct a config service. */
export function createConfigService(): IConfigService {
  return new ConfigService();
}
