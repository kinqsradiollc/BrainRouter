import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { isForeignAbsolutePath, resolveRegistryConfig } from "../../resolver.js";
import { appendWorkingStep, compressStepLog, readWorkingSteps, type WorkingStep } from "./step-log.js";
import { buildAnnotatedCanvas, readWorkingCanvas, writeWorkingCanvas } from "./canvas.js";

export type TokenPressureLevel = "none" | "mild" | "aggressive";

export interface WorkingMemoryState {
  sessionKey: string;
  workDir: string;
  pressureLevel: TokenPressureLevel;
  contextWindowTokens: number;
  estimatedTokens: number;
  injectedState: {
    currentNode?: WorkingStep;
    recentSteps: WorkingStep[];
    refs: Array<{ nodeId: string; refPath?: string; title: string }>;
    rawPayloadsIncluded: false;
  };
  updatedAt: string;
}

export interface WorkingContextResult {
  sessionKey: string;
  workDir: string;
  canvas: string;
  annotatedCanvas?: string;
  state: WorkingMemoryState;
  steps: WorkingStep[];
  ref?: {
    nodeId: string;
    path: string;
    content: string;
  };
}

export interface WorkingOffloadInput {
  workspacePath?: string;
  userId: string;
  sessionKey: string;
  payload: string;
  title?: string;
  summary?: string;
  kind?: string;
  contextWindowTokens?: number;
  estimatedTokens?: number;
  forceAggressive?: boolean;
}

export interface WorkingOffloadResult {
  nodeId: string;
  refPath: string;
  pressureLevel: TokenPressureLevel;
  canvas: string;
  state: WorkingMemoryState;
}

function defaultWorkspacePath(): string {
  return resolveRegistryConfig().localRoot ?? process.cwd();
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function pathSegment(value: string): string {
  return encodeURIComponent(value.trim() || "default");
}

export function detectTokenPressure(estimatedTokens: number, contextWindowTokens: number): TokenPressureLevel {
  if (contextWindowTokens <= 0) return "none";
  const fillRatio = estimatedTokens / contextWindowTokens;
  if (fillRatio > 0.85) return "aggressive";
  if (fillRatio > 0.5) return "mild";
  return "none";
}

function getWorkspaceId(workspacePath: string | undefined): string {
  if (!workspacePath) return "global";
  if (isWorkspaceId(workspacePath)) {
    return workspacePath;
  }
  if (isForeignAbsolutePath(workspacePath)) {
    return createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
  }
  try {
    const resolved = path.resolve(workspacePath);
    return createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  } catch {
    return createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
  }
}

function isWorkspaceId(value: string): boolean {
  return value === "global" || /^[a-f0-9]{12}$/i.test(value);
}

export function getWorkingMemoryDir(workspacePath: string | undefined, userId: string, sessionKey: string): string {
  // Working memory is per-session ephemeral state. It lives ENTIRELY under
  // the user home — never inside the project tree — so the workspace stays
  // clean and so two clones of the same repo don't share state.
  //
  // Why not write to `<workspace>/.brainrouter/work/`? Two reasons:
  //   1. Pollution: the brainrouter CLI's migration archives anything that
  //      isn't `<workspace>/.brainrouter/workflows/` into
  //      `<workspace>/.brainrouter.migrated/` on each launch — so the
  //      MCP would re-create the dir, the CLI would re-archive it, and the
  //      user would see both folders reappear on every session.
  //   2. Misuse: a non-absolute `workspacePath` like "global" (a skill
  //      scope token) would resolve relative to the MCP process cwd and
  //      build a phantom `<cwd>/global/.brainrouter/work/` that has
  //      nothing to do with any real workspace.
  //
  // Layout: ~/.brainrouter/work/<userId>/<workspaceId>/<sessionKey>/
  const root = path.join(os.homedir(), ".brainrouter");
  const workspaceId = getWorkspaceId(workspacePath);
  const targetDir = path.join(root, "work", pathSegment(userId), workspaceId);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    // Best-effort. If the home dir is unwritable the next write call will
    // surface the error with a useful path.
  }
  return path.join(targetDir, pathSegment(sessionKey));
}

function refPathFor(workDir: string, nodeId: string): string {
  return path.join(workDir, "refs", `${nodeId}.md`);
}

function writeState(workDir: string, state: WorkingMemoryState): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

function buildState(
  sessionKey: string,
  workDir: string,
  steps: WorkingStep[],
  pressureLevel: TokenPressureLevel,
  contextWindowTokens: number,
  estimatedTokens: number
): WorkingMemoryState {
  const recentSteps = pressureLevel === "none" ? steps.slice(-10) : steps.slice(-5);
  const currentNode = recentSteps.at(-1);
  return {
    sessionKey,
    workDir,
    pressureLevel,
    contextWindowTokens,
    estimatedTokens,
    injectedState: {
      currentNode,
      recentSteps,
      refs: recentSteps
        .filter((step) => step.refPath)
        .map((step) => ({ nodeId: step.nodeId, refPath: step.refPath, title: step.title })),
      rawPayloadsIncluded: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function offloadWorkingPayload(input: WorkingOffloadInput): WorkingOffloadResult {
  const workDir = getWorkingMemoryDir(input.workspacePath, input.userId, input.sessionKey);
  const refsDir = path.join(workDir, "refs");
  fs.mkdirSync(refsDir, { recursive: true });

  const nodeId = `w${Date.now()}-${randomUUID().slice(0, 8)}`;
  const absoluteRefPath = refPathFor(workDir, nodeId);
  // Stored as a display-friendly path relative to the user home (where
  // workDir now always lives). We don't reconstruct the workspace prefix
  // here because the working-memory tree no longer touches the workspace.
  const relativeRefPath = path.relative(os.homedir(), absoluteRefPath);
  const observedAt = new Date().toISOString();
  const tokenEstimate = estimateTokens(input.payload);
  const estimatedTokens = input.estimatedTokens ?? tokenEstimate;
  const contextWindowTokens = input.contextWindowTokens ?? 128_000;
  const pressureLevel = input.forceAggressive
    ? "aggressive"
    : detectTokenPressure(estimatedTokens, contextWindowTokens);

  fs.writeFileSync(
    absoluteRefPath,
    [
      `# ${input.title ?? "Working Memory Ref"}`,
      "",
      `- nodeId: ${nodeId}`,
      `- kind: ${input.kind ?? "tool_output"}`,
      `- observedAt: ${observedAt}`,
      "",
      input.payload,
    ].join("\n"),
    "utf8"
  );

  appendWorkingStep(workDir, {
    nodeId,
    title: input.title ?? "Working payload offloaded",
    summary: input.summary ?? input.payload.slice(0, 240),
    kind: input.kind ?? "tool_output",
    createdAt: observedAt,
    refPath: relativeRefPath,
    tokenEstimate,
  });

  const steps = pressureLevel === "none"
    ? readWorkingSteps(workDir)
    : compressStepLog(workDir, 5).steps;
  const canvas = writeWorkingCanvas(workDir, steps);
  const state = buildState(input.sessionKey, workDir, steps, pressureLevel, contextWindowTokens, estimatedTokens);
  writeState(workDir, state);

  return { nodeId, refPath: absoluteRefPath, pressureLevel, canvas, state };
}

export function getWorkingContext(
  workspacePath: string | undefined,
  userId: string,
  sessionKey: string,
  options?: { nodeId?: string; activeNodeId?: string; contextWindowTokens?: number; estimatedTokens?: number }
): WorkingContextResult {
  const workDir = getWorkingMemoryDir(workspacePath, userId, sessionKey);
  fs.mkdirSync(path.join(workDir, "refs"), { recursive: true });

  const estimatedTokens = options?.estimatedTokens ?? 0;
  const contextWindowTokens = options?.contextWindowTokens ?? 128_000;
  const pressureLevel = detectTokenPressure(estimatedTokens, contextWindowTokens);
  const steps = pressureLevel === "none"
    ? readWorkingSteps(workDir)
    : compressStepLog(workDir, 5).steps;
  const canvas = steps.length > 0 ? writeWorkingCanvas(workDir, steps) : readWorkingCanvas(workDir);
  const annotatedCanvas = options?.activeNodeId ? buildAnnotatedCanvas(steps, options.activeNodeId) : undefined;
  const state = buildState(sessionKey, workDir, steps, pressureLevel, contextWindowTokens, estimatedTokens);
  writeState(workDir, state);

  const refPath = options?.nodeId ? refPathFor(workDir, options.nodeId) : undefined;
  const ref = refPath && fs.existsSync(refPath)
    ? { nodeId: options!.nodeId!, path: refPath, content: fs.readFileSync(refPath, "utf8") }
    : undefined;

  return { sessionKey, workDir, canvas: annotatedCanvas ?? canvas, annotatedCanvas, state, steps, ref };
}

export function resetWorkingMemory(workspacePath: string | undefined, userId: string, sessionKey: string): { deleted: boolean; workDir: string } {
  const workDir = getWorkingMemoryDir(workspacePath, userId, sessionKey);
  const deleted = fs.existsSync(workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
  return { deleted, workDir };
}

export interface ActiveSessionInfo {
  sessionKey: string;
  workspaceId: string;
  updatedAt: string;
}

export function listActiveSessions(userId: string): ActiveSessionInfo[] {
  const root = path.join(os.homedir(), ".brainrouter", "work", pathSegment(userId));
  if (!fs.existsSync(root)) return [];

  const results: ActiveSessionInfo[] = [];
  try {
    const workspaceIds = fs.readdirSync(root);
    for (const workspaceId of workspaceIds) {
      const workspacePath = path.join(root, workspaceId);
      if (!fs.statSync(workspacePath).isDirectory()) continue;

      const sessionKeys = fs.readdirSync(workspacePath);
      for (const sessionKey of sessionKeys) {
        const sessionPath = path.join(workspacePath, sessionKey);
        if (!fs.statSync(sessionPath).isDirectory()) continue;

        let updatedAt = new Date(fs.statSync(sessionPath).mtime).toISOString();
        try {
          const stateFile = path.join(sessionPath, "state.json");
          if (fs.existsSync(stateFile)) {
            const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            if (state.updatedAt) updatedAt = state.updatedAt;
          }
        } catch {
          // Ignore
        }

        results.push({
          sessionKey: decodeURIComponent(sessionKey),
          workspaceId,
          updatedAt,
        });
      }
    }
  } catch {
    // Ignore
  }

  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
