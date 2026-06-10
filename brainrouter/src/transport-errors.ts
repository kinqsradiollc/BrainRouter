/**
 * Classify a transport error that means "the reply had nowhere to go" — the
 * client already closed the request stream (cancelled, timed out, navigated
 * away, or the HTTP/SSE connection dropped) before the server finished and tried
 * to send the response.
 *
 * These surface from inside the MCP SDK's transports (e.g.
 * `StreamableHTTPServerTransport`) and bubble up to `server.onerror` as
 * `Failed to send response: ... No connection established for request ID: N`.
 * The request handler ran fine — there is simply no live connection to deliver
 * the result on — so this is NOT a server fault and shouldn't be logged as a
 * scary `[MCP Error]` with a stack. Callers downgrade it to a quiet warning.
 */
export function isClientDisconnectError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("no connection established for request id") ||
    msg.includes("failed to send response") ||
    msg.includes("not connected") ||
    msg.includes("connection closed") ||
    msg.includes("epipe") ||
    msg.includes("err_stream_destroyed") ||
    msg.includes("err_stream_write_after_end")
  );
}
