// FED — register + heartbeat an `active_sessions` row for the signed-in user so
// this desktop shows up on the Account page and dashboard "Devices & sessions".
// The brain resolves `userId` server-side from the authenticated apiKey; we only
// supply the client kind + workspace. Registration is idempotent (re-registering
// with the same key preserves `startedAt`), and a 30s heartbeat keeps the row
// out of the 2-minute stale window. Best-effort throughout: a missing/offline
// brain never throws into the caller.
type ToolCaller = { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };

export interface BrainSessionRegistration {
  sessionKey: string;
  deviceId: string;
  state: 'idle' | 'working' | 'waiting';
  title?: string;
  titleSource?: 'derived' | 'agent' | 'hook' | 'human';
}

let sessionKey = '';
let heartbeat: ReturnType<typeof setInterval> | null = null;
let relayInfo: { endpoints: string[]; publicKey: string } | null = null;
let currentRegistration: BrainSessionRegistration | undefined;
let currentMcp: ToolCaller | undefined;
let currentWorkspaceRoot = '';
let lifecycleGeneration = 0;
let lifecycleTail: Promise<void> = Promise.resolve();

/** This desktop's active-session key (empty until registered). The mobile relay
 * uses it to prove a would-be remote peer is on the SAME account: a same-account
 * token's GET /api/sessions returns this key; another account's never will. */
export function getBrainSessionKey(): string { return sessionKey; }

/** Publish (or clear) the running mobile relay's connect info so a same-account
 * device can DISCOVER this desktop via GET /api/sessions — no manual QR. Re-runs
 * ensureBrainSession-style metadata on the next heartbeat/registration. */
export function setBrainSessionRelay(info: { endpoints: string[]; publicKey: string } | null): void {
  relayInfo = info;
}

function extractSessionKey(res: unknown): string {
  try {
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) return '';
    return (JSON.parse(text) as { session?: { sessionKey?: string } }).session?.sessionKey ?? '';
  } catch { return ''; }
}

function toolPayload(res: unknown): Record<string, unknown> {
  const result = res as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = result?.content?.[0]?.text ?? '';
  if (result?.isError) throw new Error(text || 'Brain session tool call failed.');
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Brain session tool returned an invalid payload.');
  }
  return parsed as Record<string, unknown>;
}

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const run = lifecycleTail.then(operation, operation);
  lifecycleTail = run.then(() => undefined, () => undefined);
  return run;
}

function startHeartbeatTimer(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    void heartbeatBrainSessionNow();
  }, 30_000);
  (heartbeat as { unref?: () => void }).unref?.();
}

/** Run the same serialized lease check used by the timer (also useful on reconnect). */
export function heartbeatBrainSessionNow(): Promise<boolean> {
  const expectedGeneration = lifecycleGeneration;
  const mcp = currentMcp;
  const workspaceRoot = currentWorkspaceRoot;
  const registration = currentRegistration ? { ...currentRegistration } : undefined;
  if (!mcp || !registration || !sessionKey) return Promise.resolve(false);
  return serializeLifecycle(() => heartbeatOnce(
    mcp,
    workspaceRoot,
    registration,
    expectedGeneration,
  ));
}

async function registerOnce(
  mcp: ToolCaller,
  workspaceRoot: string,
  effective: BrainSessionRegistration | undefined,
  expectedGeneration: number,
): Promise<boolean> {
  if (expectedGeneration !== lifecycleGeneration) return false;
  const requestedKey = effective?.sessionKey.trim();
  if (requestedKey && sessionKey && requestedKey !== sessionKey) {
    const previousKey = sessionKey;
    try { await mcp.callTool('session_unregister', { sessionKey: previousKey }); } catch { /* stale row expires */ }
    if (expectedGeneration !== lifecycleGeneration) return false;
    sessionKey = requestedKey;
  } else if (requestedKey) {
    sessionKey = requestedKey;
  }
  const res = await mcp.callTool('session_register', {
    ...(sessionKey ? { sessionKey } : {}),
    clientKind: 'electron-desktop',
    workspaceRoot: workspaceRoot || '',
    ...(effective ? {
      deviceId: effective.deviceId,
      state: effective.state,
      ...(effective.title ? { title: effective.title } : {}),
      ...(effective.titleSource ? { titleSource: effective.titleSource } : {}),
      messageWakeVersion: 1,
    } : {}),
    metadata: { app: 'brainrouter-desktop', ...(relayInfo ? { remoteRelay: relayInfo } : {}) },
  });
  const payload = toolPayload(res);
  if (expectedGeneration !== lifecycleGeneration) return false;
  const key = typeof (payload.session as { sessionKey?: unknown } | undefined)?.sessionKey === 'string'
    ? (payload.session as { sessionKey: string }).sessionKey
    : extractSessionKey(res);
  if (!key) return false;
  sessionKey = key;
  startHeartbeatTimer();
  return true;
}

async function heartbeatOnce(
  mcp: ToolCaller,
  workspaceRoot: string,
  registration: BrainSessionRegistration,
  expectedGeneration: number,
): Promise<boolean> {
  if (expectedGeneration !== lifecycleGeneration || !sessionKey) return false;
  try {
    const res = await mcp.callTool('session_heartbeat', { sessionKey });
    const payload = toolPayload(res);
    if (expectedGeneration !== lifecycleGeneration) return false;
    if (payload.updated === true) return true;
  } catch {
    if (expectedGeneration !== lifecycleGeneration) return false;
  }
  // A swept row, restarted Brain, or lost authenticated ownership all require
  // the same exact-key claim to be re-established with current metadata.
  try {
    return await registerOnce(mcp, workspaceRoot, registration, expectedGeneration);
  } catch {
    return false;
  }
}

/** Register (or refresh) this desktop's active session and start heartbeating. Idempotent. */
export async function ensureBrainSession(
  mcp: ToolCaller,
  workspaceRoot: string,
  registration?: BrainSessionRegistration,
): Promise<boolean> {
  if (registration) currentRegistration = { ...registration };
  currentMcp = mcp;
  currentWorkspaceRoot = workspaceRoot;
  const effective = currentRegistration ? { ...currentRegistration } : undefined;
  const expectedGeneration = ++lifecycleGeneration;
  return serializeLifecycle(async () => {
    try {
      return await registerOnce(mcp, workspaceRoot, effective, expectedGeneration);
    } catch {
      return false; // brain offline — registers on the next connect/heartbeat
    }
  });
}

/** Stop heartbeating and remove the session row (clean sign-out / quit). Best-effort. */
export async function endBrainSession(mcp: ToolCaller): Promise<void> {
  const expectedGeneration = ++lifecycleGeneration;
  const key = sessionKey;
  currentRegistration = undefined;
  currentMcp = undefined;
  currentWorkspaceRoot = '';
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  await serializeLifecycle(async () => {
    if (expectedGeneration !== lifecycleGeneration) return;
    sessionKey = '';
    if (key) {
      try { await mcp.callTool('session_unregister', { sessionKey: key }); } catch { /* best effort */ }
    }
  });
}
