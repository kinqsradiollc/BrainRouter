export interface GithubDeviceStart {
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export type GithubDevicePoll = {
  status: "pending" | "connected" | "expired" | "error";
  login?: string;
  error?: string;
};

export type GithubDeviceFlowState =
  | { status: "idle" }
  | { status: "pending"; userCode: string; verificationUri: string; intervalMs: number; expiresAtMs: number }
  | { status: "connected"; login?: string }
  | { status: "error"; error: string };

type GithubDeviceStartState = Extract<GithubDeviceFlowState, { status: "pending" | "error" }>;
type GithubDevicePollState = Extract<GithubDeviceFlowState, { status: "pending" | "connected" | "error" }>;

export function shouldUseGithubDeviceFallback(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && Number((error as { status?: unknown }).status) === 409;
}

export function beginGithubDeviceFlow(input: GithubDeviceStart, nowMs = Date.now()): GithubDeviceStartState {
  const userCode = input.userCode.trim();
  const verificationUri = input.verificationUri.trim();
  if (!userCode || !/^https:\/\/github\.com\//i.test(verificationUri)) {
    return { status: "error", error: "GitHub returned an invalid device authorization response." };
  }
  const intervalSec = Number.isFinite(input.interval) ? Math.min(30, Math.max(1, input.interval)) : 5;
  const expiresSec = Number.isFinite(input.expiresIn) ? Math.min(1_800, Math.max(60, input.expiresIn)) : 900;
  return {
    status: "pending",
    userCode,
    verificationUri,
    intervalMs: intervalSec * 1_000,
    expiresAtMs: nowMs + expiresSec * 1_000,
  };
}

export function applyGithubDevicePoll(
  current: Extract<GithubDeviceFlowState, { status: "pending" }>,
  poll: GithubDevicePoll,
  nowMs = Date.now(),
): GithubDevicePollState {
  if (nowMs >= current.expiresAtMs || poll.status === "expired") {
    return { status: "error", error: "GitHub authorization expired. Click Connect to try again." };
  }
  if (poll.status === "connected") return { status: "connected", ...(poll.login?.trim() ? { login: poll.login.trim() } : {}) };
  if (poll.status === "pending") return current;
  return { status: "error", error: poll.error?.trim() || "GitHub could not complete device authorization." };
}
