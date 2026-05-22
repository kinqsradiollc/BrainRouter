import type { McpClientWrapper } from './mcpClient.js';

/**
 * Centralized helpers for talking to the BrainRouter MCP server.
 *
 * Every MCP `callTool` response shares the same wire shape — an `isError`
 * boolean plus a `content` array of `{ type, text }` entries — and most
 * callers do the same three things with it: join the text, optionally
 * `JSON.parse`, and tolerate failures. Centralizing those mechanics here
 * avoids ~5 nearly-identical extractors scattered across the codebase and
 * gives us one place to fix bugs (e.g., result shape changes upstream).
 */

/** Join the `text` parts of an MCP tool result into a single string. Tolerates non-content payloads. */
export function extractToolText(result: any): string {
  if (Array.isArray(result?.content)) {
    return result.content.map((entry: any) => entry?.text || '').join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '');
}

/** JSON.parse that never throws. Returns `undefined` (or the provided fallback) on failure. */
export function safeJsonParse<T = any>(text: string, fallback?: T): T | undefined {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface McpCallResult<T = any> {
  isError: boolean;
  text: string;
  /** Parsed JSON when the tool returned JSON; undefined otherwise. */
  parsed: T | undefined;
  /** The raw response object, in case a caller needs metadata we didn't normalize. */
  raw: any;
}

/**
 * Call an MCP tool and normalize the response into `{ isError, text, parsed }`.
 *
 * Network and protocol errors are converted to `{ isError: true, text: errorMessage }`
 * so callers can branch on a single shape instead of mixing try/catch with isError checks.
 */
export async function callMcpTool<T = any>(
  client: McpClientWrapper,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult<T>> {
  try {
    const raw: any = await client.callTool(name, args);
    const text = extractToolText(raw);
    return {
      isError: Boolean(raw?.isError),
      text,
      parsed: safeJsonParse<T>(text),
      raw,
    };
  } catch (err: any) {
    return {
      isError: true,
      text: err?.message ?? String(err),
      parsed: undefined,
      raw: undefined,
    };
  }
}

/**
 * Canonical convention for naming a child agent's session key relative to its
 * parent: `<parent>:child:<id>`. Centralized so a future change (e.g. switching
 * to UUIDs or namespacing per-role) is a one-file edit, not a sweep.
 */
export function childSessionKey(parentSessionKey: string, childId: string): string {
  return `${parentSessionKey}:child:${childId}`;
}
