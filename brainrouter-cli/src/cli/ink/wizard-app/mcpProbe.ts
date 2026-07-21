import {
  type McpPick,
  type WizardDraft,
} from '../../wizard/types.js';
import { McpClientWrapper } from '@kinqs/brainrouter-core/mcp';
import { redactMcpHttpUrl, redactMcpHttpUrlsInText } from '../../mcpUrl.js';

export function formatMcpForBadge(pick: McpPick): string {
  if (pick.kind === 'local-stdio') return 'local stdio';
  if (pick.kind === 'local-http') return 'http://localhost:3747/mcp';
  if (pick.kind === 'remote-http') return redactMcpHttpUrl(pick.url);
  return 'no MCP';
}

export async function probeMcp(pick: McpPick, draft: WizardDraft, onStatus: (s: string) => void): Promise<{ ok: boolean; warning?: string }> {
  if (pick.kind === 'skip') return { ok: true };
  const wrapper = new McpClientWrapper();
  const llmConfig = draft.provider && draft.model
    ? { provider: 'openai' as const, apiKey: draft.apiKey ?? '', model: draft.model, endpoint: draft.customEndpoint ?? draft.provider.endpoint }
    : undefined;
  const serverConfig = mcpPickToServerConfig(pick);
  if (!serverConfig) return { ok: false, warning: 'Could not build MCP server config for this pick.' };
  try {
    onStatus('connecting…');
    await Promise.race([
      wrapper.connect(serverConfig, llmConfig, 'wizard'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('probe timed out after 5s')), 5_000)),
    ]);
    await wrapper.close();
    return { ok: true };
  } catch (err: any) {
    try { await wrapper.close(); } catch { /* ignore */ }
    return {
      ok: false,
      warning: `MCP probe failed (${redactMcpHttpUrlsInText(String(err?.message ?? err))}). Profile saved — start the server and run /mcp reconnect later.`,
    };
  }
}

export function mcpPickToServerConfig(pick: McpPick) {
  if (pick.kind === 'local-stdio') {
    return { type: 'stdio' as const, command: 'brainrouter-mcp', args: [], identity: 'brainrouter' as const };
  }
  if (pick.kind === 'local-http') {
    return { type: 'http' as const, url: 'http://localhost:3747/mcp', apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  if (pick.kind === 'remote-http') {
    return { type: 'http' as const, url: pick.url, apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  return undefined;
}
