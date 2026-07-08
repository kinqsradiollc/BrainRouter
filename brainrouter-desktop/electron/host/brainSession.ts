// FED — register + heartbeat an `active_sessions` row for the signed-in user so
// this desktop shows up on the Account page and dashboard "Devices & sessions".
// The brain resolves `userId` server-side from the authenticated apiKey; we only
// supply the client kind + workspace. Registration is idempotent (re-registering
// with the same key preserves `startedAt`), and a 30s heartbeat keeps the row
// out of the 2-minute stale window. Best-effort throughout: a missing/offline
// brain never throws into the caller.
type ToolCaller = { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };

let sessionKey = '';
let heartbeat: ReturnType<typeof setInterval> | null = null;

function extractSessionKey(res: unknown): string {
  try {
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) return '';
    return (JSON.parse(text) as { session?: { sessionKey?: string } }).session?.sessionKey ?? '';
  } catch { return ''; }
}

/** Register (or refresh) this desktop's active session and start heartbeating. Idempotent. */
export async function ensureBrainSession(mcp: ToolCaller, workspaceRoot: string): Promise<void> {
  try {
    const res = await mcp.callTool('session_register', {
      ...(sessionKey ? { sessionKey } : {}),
      clientKind: 'electron-desktop',
      workspaceRoot: workspaceRoot || '',
      metadata: { app: 'brainrouter-desktop' },
    });
    const key = extractSessionKey(res);
    if (key) sessionKey = key;
    if (sessionKey && !heartbeat) {
      heartbeat = setInterval(() => { void Promise.resolve(mcp.callTool('session_heartbeat', { sessionKey })).catch(() => {}); }, 30_000);
      (heartbeat as { unref?: () => void }).unref?.();
    }
  } catch { /* brain offline — registers on the next connect */ }
}

/** Stop heartbeating and remove the session row (clean sign-out / quit). Best-effort. */
export async function endBrainSession(mcp: ToolCaller): Promise<void> {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  const key = sessionKey;
  sessionKey = '';
  if (key) { try { await mcp.callTool('session_unregister', { sessionKey: key }); } catch { /* best effort */ } }
}
