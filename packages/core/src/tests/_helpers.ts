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
import { _resetCliKnobsCache } from '../config/config.js';

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
 * the CLI-knobs cache, and `BRAINROUTER_HOME` afterwards. `BRAINROUTER_HOME`
 * is pinned to a sibling tmp dir so tests never touch the real
 * `~/.config/brainrouter` on the developer's machine. (It's an installation
 * /test-isolation knob, not a CLI behaviour knob — it stays in env.)
 */
export function withTempWorkspace(fn: (workspace: string) => void) {
  const previousCwd = process.cwd();
  const previousHome = process.env.BRAINROUTER_HOME;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-'));
  // Do NOT reset CLI knobs on entry — tests that compose `setCliKnobOverride`
  // before calling this helper would lose their override otherwise. Resets
  // happen on exit so the next test starts clean.
  try {
    process.env.BRAINROUTER_HOME = home;
    process.chdir(workspace);
    fn(workspace);
  } finally {
    process.chdir(previousCwd);
    _resetCliKnobsCache();
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
  // Do NOT reset CLI knobs on entry — see withTempWorkspace.
  process.env.BRAINROUTER_HOME = home;
  process.chdir(tmp);
  try {
    return await fn(tmp);
  } finally {
    process.chdir(previousCwd);
    _resetCliKnobsCache();
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
