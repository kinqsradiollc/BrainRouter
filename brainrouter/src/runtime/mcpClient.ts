import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LLMConfig, ServerConfig } from '../config/config.js';

export class McpClientWrapper {
  public client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;

  constructor() {
    this.client = new Client(
      { name: 'brainrouter-cli', version: '0.2.0' },
      { capabilities: {} }
    );
  }

  async connect(serverConfig: ServerConfig, llmConfig?: LLMConfig): Promise<void> {
    if (serverConfig.type === 'stdio') {
      if (!serverConfig.command) {
        throw new Error('Stdio server configuration missing "command".');
      }

      // Merge environment variables safely
      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }
      if (serverConfig.env) {
        for (const [k, v] of Object.entries(serverConfig.env)) {
          if (v !== undefined) {
            // If the shell process environment has a valid key, do not overwrite it with the default config placeholder.
            if (k === 'BRAINROUTER_API_KEY' && process.env.BRAINROUTER_API_KEY && v === 'br_admin_key_placeholder') {
              continue;
            }
            mergedEnv[k] = v;
          }
        }
      }

      // Auto-propagate the CLI's configured LLM settings to the MCP child so
      // server-side memory extraction can share the same credentials/endpoint/model.
      // Existing env vars always win — explicit shell config beats CLI defaults.
      //
      // Critical: when only `OPENAI_API_KEY` is set in the user's shell (which
      // the CLI itself accepts as a fallback in callOpenAI), the MCP child
      // inherits nothing — its cognitive extractor then silently disables,
      // sensory rows pile up, the cognitive table stays empty, and every
      // future recall returns 0 records. The fallback chain below makes the
      // MCP child see whatever credential the CLI itself would have used.
      // API-key resolution must use truthy checks, not `??`. The config file
      // ships with `llm.apiKey: ''` by default — an empty string — and `??`
      // only falls back on null/undefined. The earlier `??` form let the
      // empty config string beat the OPENAI_API_KEY env fallback, leaving
      // the MCP child with no credential, which silently disabled cognitive
      // extraction. Sensory captures still landed, so the CLI happily
      // emitted "💾 Captured turn" while 79 extractions failed in the
      // background. (Verified against scheduler_state.extraction_errors.)
      if (!mergedEnv.BRAINROUTER_LLM_API_KEY) {
        const apiKey =
          (llmConfig?.apiKey && llmConfig.apiKey.trim()) ||
          process.env.OPENAI_API_KEY ||
          process.env.BRAINROUTER_LLM_API_KEY;
        if (apiKey) {
          mergedEnv.BRAINROUTER_LLM_API_KEY = apiKey;
        }
      }
      if (llmConfig?.endpoint && !mergedEnv.BRAINROUTER_LLM_ENDPOINT) {
        const ep = llmConfig.endpoint.replace(/\/$/, '');
        mergedEnv.BRAINROUTER_LLM_ENDPOINT = ep.endsWith('/chat/completions')
          ? ep
          : `${ep}/chat/completions`;
      }
      if (llmConfig?.model && !mergedEnv.BRAINROUTER_LLM_MODEL) {
        mergedEnv.BRAINROUTER_LLM_MODEL = llmConfig.model;
      }
      // Loud diagnostic: if NO LLM key reached the child, server-side
      // memory extraction is dead — every sensory capture will pile up
      // un-extracted. Print a yellow banner so the user knows BEFORE they
      // see "0 records" in every briefing.
      if (!mergedEnv.BRAINROUTER_LLM_API_KEY) {
        console.warn(
          '\n⚠️  No LLM API key reached the MCP child. Sensory turns will be ' +
          'captured but cognitive extraction (the thing that makes them ' +
          'searchable) will fail silently. Set OPENAI_API_KEY or ' +
          'BRAINROUTER_LLM_API_KEY before starting brainrouter.\n',
        );
      }

      // Spawn the MCP child with cwd set to the MCP package directory if we
      // can find it from the first arg (typically `node /path/to/mcp/dist/index.js`).
      // The child uses `import "dotenv/config"` which resolves `.env`
      // relative to `process.cwd()` — defaulting to the user's launch dir
      // meant `mcp/.env` was never read. With cwd hinted, dotenv finds the
      // canonical config without the user having to copy/symlink files.
      const firstArg = serverConfig.args?.[0];
      let childCwd: string | undefined;
      if (firstArg && firstArg.endsWith('.js')) {
        try {
          // mcp/dist/index.js → mcp/
          const distDir = path.dirname(firstArg);
          const pkgRoot = path.resolve(distDir, '..');
          // Sanity: only set if the directory contains a `.env` or `package.json`
          // (avoid pointing the child at /usr/local/lib by accident).
          if (
            fs.existsSync(path.join(pkgRoot, '.env')) ||
            fs.existsSync(path.join(pkgRoot, 'package.json'))
          ) {
            childCwd = pkgRoot;
          }
        } catch {
          // Best-effort; if path resolution fails we just don't set cwd.
        }
      }

      this.transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        env: mergedEnv,
        cwd: childCwd,
      });

      await this.client.connect(this.transport);
    } else if (serverConfig.type === 'http') {
      if (!serverConfig.url) {
        throw new Error('HTTP server configuration missing "url".');
      }

      const url = new URL(serverConfig.url);
      const transportOpts: any = {};

      if (serverConfig.apiKey) {
        transportOpts.requestInit = {
          headers: {
            'Authorization': `Bearer ${serverConfig.apiKey}`,
          },
        };
      }

      const httpTransport = new StreamableHTTPClientTransport(url, transportOpts);
      this.transport = httpTransport;

      await this.client.connect(httpTransport);
    } else {
      throw new Error(`Unsupported connection type: ${(serverConfig as any).type}`);
    }
  }

  async listTools() {
    return this.client.listTools({});
  }

  async callTool(name: string, args: Record<string, any>) {
    // A hung MCP server used to hang the entire runTurn forever — there was
    // no per-tool timeout, and the LLM call timeout only fired between tool
    // rounds. Race the tool call against a configurable timeout so a flaky
    // child server can't lock up the whole CLI.
    const timeoutMs = Number(process.env.BRAINROUTER_MCP_TIMEOUT_MS) || 60_000;
    return Promise.race([
      this.client.callTool({ name, arguments: args }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP tool "${name}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  async close(): Promise<void> {
    if (this.transport) {
      if (this.transport instanceof StreamableHTTPClientTransport) {
        try {
          await this.transport.terminateSession();
        } catch {
          // ignore session termination errors
        }
      }
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
    }
    try {
      await this.client.close();
    } catch {
      // ignore
    }
    this.transport = null;
  }
}
