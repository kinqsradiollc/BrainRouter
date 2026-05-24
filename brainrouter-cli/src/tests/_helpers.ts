/**
 * Shared fixtures + harness for the split-up CLI test suites.
 *
 * Lives under `src/tests/` alongside the actual `*.test.ts` files. The
 * leading underscore is convention only — the test runner picks up files by
 * the `*.test.js` glob, so a non-test filename is enough to keep node:test
 * from trying to execute this module as a suite.
 *
 * Everything here was lifted verbatim out of the original `src/agent.test.ts`
 * during the split. Don't add new fixtures unless they're used by ≥2 files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../agent/agent.js';

/**
 * Construct an Agent without touching MCP or the LLM. Only safe for tests
 * that exercise pure state-machine extensions (model, accessMode, history,
 * fork, refreshSystemPrompt) — anything that triggers `bootstrapSession`
 * will hit the stub MCP and either no-op or surface a misleading error.
 */
export function makeAgent(workspace: string): Agent {
  const stubMcp: any = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
  const llm = { provider: 'openai' as const, apiKey: 'k', model: 'test-model' };
  return new Agent(stubMcp, llm, {
    workspaceRoot: workspace,
    launchCwd: workspace,
    sessionKey: 'session:test',
    silent: true, // skip bootstrap + briefing so we don't touch MCP at all
  });
}

/**
 * Run a synchronous test body inside a fresh temp workspace. Restores cwd,
 * BRAINROUTER_WORKSPACE, and BRAINROUTER_HOME afterwards. BRAINROUTER_HOME
 * is also pinned to a sibling tmp dir so tests never touch the real
 * `~/.brainrouter` on the developer's machine.
 */
export function withTempWorkspace(fn: (workspace: string) => void) {
  const previousCwd = process.cwd();
  const previousWorkspace = process.env.BRAINROUTER_WORKSPACE;
  const previousHome = process.env.BRAINROUTER_HOME;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-'));
  try {
    delete process.env.BRAINROUTER_WORKSPACE;
    process.env.BRAINROUTER_HOME = home;
    process.chdir(workspace);
    fn(workspace);
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) delete process.env.BRAINROUTER_WORKSPACE;
    else process.env.BRAINROUTER_WORKSPACE = previousWorkspace;
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Async sibling of `withTempWorkspace`. Same restore semantics; awaits the
 * body so promise rejections still tear the workspace down.
 */
export async function withTempWorkspaceAsync<T>(fn: (workspace: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  process.chdir(tmp);
  try {
    return await fn(tmp);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
