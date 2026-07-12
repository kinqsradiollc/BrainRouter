let sessionKey = '';
let heartbeat = null;
function extractSessionKey(res) {
    try {
        const text = res?.content?.[0]?.text;
        if (!text)
            return '';
        return JSON.parse(text).session?.sessionKey ?? '';
    }
    catch {
        return '';
    }
}
/** Register (or refresh) this desktop's active session and start heartbeating. Idempotent. */
export async function ensureBrainSession(mcp, workspaceRoot) {
    try {
        const res = await mcp.callTool('session_register', {
            ...(sessionKey ? { sessionKey } : {}),
            clientKind: 'electron-desktop',
            workspaceRoot: workspaceRoot || '',
            metadata: { app: 'brainrouter-desktop' },
        });
        const key = extractSessionKey(res);
        if (key)
            sessionKey = key;
        if (sessionKey && !heartbeat) {
            heartbeat = setInterval(() => { void Promise.resolve(mcp.callTool('session_heartbeat', { sessionKey })).catch(() => { }); }, 30_000);
            heartbeat.unref?.();
        }
    }
    catch { /* brain offline — registers on the next connect */ }
}
/** Stop heartbeating and remove the session row (clean sign-out / quit). Best-effort. */
export async function endBrainSession(mcp) {
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
    const key = sessionKey;
    sessionKey = '';
    if (key) {
        try {
            await mcp.callTool('session_unregister', { sessionKey: key });
        }
        catch { /* best effort */ }
    }
}
