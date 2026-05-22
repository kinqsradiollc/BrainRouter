import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

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

export function loadConfig(): Config {
  let config: Config;
  if (!fs.existsSync(CONFIG_FILE)) {
    config = createDefaultConfig();
  } else {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Config;
      // Backfill standard properties if missing
      if (!parsed.servers) parsed.servers = {};
      if (!parsed.activeServer) parsed.activeServer = 'default';
      config = parsed;
    } catch (error) {
      console.error(`Warning: Failed to parse config file at ${CONFIG_FILE}. Using default config.`);
      config = createDefaultConfig();
    }
  }

  // Auto-resolve placeholder API keys if possible
  resolveDefaultApiKey(config);
  // The default config writes `llm.apiKey: ''` so it never appears as a
  // secret in the committed file. Backfill from the standard env vars at
  // load time so every downstream consumer (callOpenAI, mcpClient env
  // propagation, the cognitive extractor LLM runner) sees a real value
  // instead of the empty string.
  if (config.llm && !config.llm.apiKey.trim()) {
    const envKey = process.env.OPENAI_API_KEY || process.env.BRAINROUTER_LLM_API_KEY;
    if (envKey) config.llm.apiKey = envKey;
  }

  return config;
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

function createDefaultConfig(): Config {
  // Derive path to default local mcp dist relative to this module
  const defaultMcpPath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'mcp',
    'dist',
    'index.js'
  );

  const config: Config = {
    activeServer: 'default',
    servers: {
      default: {
        type: 'stdio',
        command: 'node',
        args: [defaultMcpPath, '--root', './'],
        env: {
          BRAINROUTER_API_KEY: 'br_admin_key_placeholder'
        }
      }
    },
    llm: {
      provider: 'openai',
      apiKey: '',
      model: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1'
    }
  };

  saveConfig(config);
  return config;
}

function resolveDefaultApiKey(config: Config): void {
  const defaultServer = config.servers.default;
  if (
    defaultServer &&
    defaultServer.type === 'stdio' &&
    defaultServer.env &&
    defaultServer.env.BRAINROUTER_API_KEY === 'br_admin_key_placeholder'
  ) {
    const dbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), '.brainrouter', 'memory.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath);
        const row = db.prepare("SELECT api_key FROM users WHERE is_admin = 1 LIMIT 1").get() as { api_key: string } | undefined;
        if (row && row.api_key) {
          defaultServer.env.BRAINROUTER_API_KEY = row.api_key;
          saveConfig(config);
        }
      } catch (error) {
        // ignore errors
      }
    }
  }
}

