import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LLMConfig, ServerConfig } from './config.js';

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
      if (llmConfig) {
        if (llmConfig.apiKey && !mergedEnv.BRAINROUTER_LLM_API_KEY) {
          mergedEnv.BRAINROUTER_LLM_API_KEY = llmConfig.apiKey;
        }
        if (llmConfig.endpoint && !mergedEnv.BRAINROUTER_LLM_ENDPOINT) {
          const ep = llmConfig.endpoint.replace(/\/$/, '');
          mergedEnv.BRAINROUTER_LLM_ENDPOINT = ep.endsWith('/chat/completions')
            ? ep
            : `${ep}/chat/completions`;
        }
        if (llmConfig.model && !mergedEnv.BRAINROUTER_LLM_MODEL) {
          mergedEnv.BRAINROUTER_LLM_MODEL = llmConfig.model;
        }
      }

      this.transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        env: mergedEnv,
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
    return this.client.callTool({
      name,
      arguments: args,
    });
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
