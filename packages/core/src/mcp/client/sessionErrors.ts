/**
 * Streamable HTTP session-expiry error matching.
 *
 * When the brain restarts (or a session ages out) mid-run, the MCP SDK surfaces
 * the server's "Session not found" payload verbatim. Callers use this to trigger
 * a one-shot reconnect + retry instead of failing the turn.
 */

/**
 * Match the Streamable HTTP session-expiry error so `callTool` can
 * trigger a one-shot reconnect + retry. The MCP SDK surfaces the
 * server's payload verbatim, so we string-sniff the canonical
 * error message; broader than a JSON parse to also catch the
 * "Streamable HTTP error: Error POSTing to endpoint" prefix that
 * wraps it.
 */
export function isSessionNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /Session not found/i.test(message) || /mcp-session-id/i.test(message);
}
