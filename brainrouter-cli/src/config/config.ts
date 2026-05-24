import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  apiKey?: string;
}

export interface LLMConfig {
  provider: 'openai';
  apiKey: string;
  model: string;
  endpoint?: string;
}

export interface Config {
  activeServer: string;
  servers: Record<string, ServerConfig>;
  llm?: LLMConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'brainrouter');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Read the existing config.json or exit with a clear error. The CLI owns
 * READS of this file — writes are the user's job (via `brainrouter login`,
 * `brainrouter config`, or direct edit). Auto-fabricating a default config
 * was a holdover from the monorepo dev story; it only ever produced a
 * broken stdio profile pointing at a sibling `brainrouter/` package that
 * doesn't exist outside the monorepo, so npm-installed users got a config
 * file they had to fix anyway.
 *
 * Setup commands (login / config) that need to BUILD a fresh config from
 * scratch should call `loadOrInitConfig` instead — it returns an empty
 * skeleton when no file exists rather than exiting.
 */
export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`No BrainRouter config found at ${CONFIG_FILE}.`);
    console.error(`Run \`brainrouter login\` to connect to a hosted MCP server, or \`brainrouter config\` to set one up.`);
    process.exit(1);
  }
  let parsed: Config;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    parsed = JSON.parse(raw) as Config;
  } catch (error) {
    console.error(`Error: Failed to parse config file at ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Fix the file by hand, or delete it and run \`brainrouter config\` to recreate.`);
    process.exit(1);
  }
  if (!parsed.servers) parsed.servers = {};
  if (!parsed.activeServer) parsed.activeServer = '';

  // The default config writes `llm.apiKey: ''` so it never appears as a
  // secret in the committed file. Backfill from the standard env vars at
  // load time so every downstream consumer (callOpenAI, mcpClient env
  // propagation, the cognitive extractor LLM runner) sees a real value
  // instead of the empty string.
  if (parsed.llm && !parsed.llm.apiKey.trim()) {
    const envKey = process.env.OPENAI_API_KEY || process.env.BRAINROUTER_LLM_API_KEY;
    if (envKey) parsed.llm.apiKey = envKey;
  }

  return parsed;
}

/**
 * Setup-wizard variant of `loadConfig`. Returns the existing config when
 * one is on disk, or an empty skeleton when none exists yet. Used by
 * `brainrouter login` and `brainrouter config` so a first-run user can
 * BUILD their config interactively without hitting the strict
 * "no config — run setup" error from `loadConfig`.
 */
export function loadOrInitConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { activeServer: '', servers: {} };
  }
  return loadConfig();
}

export function saveConfig(config: Config): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error: Failed to save config to ${CONFIG_FILE}:`, error instanceof Error ? error.message : error);
  }
}



