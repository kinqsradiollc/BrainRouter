import React from 'react';
import { render } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WizardApp } from './WizardApp.js';
import type { WizardState, WizardDraft } from '../wizard/types.js';
import type { McpPick } from '../wizard/types.js';
import { writePreferences } from '../../state/preferencesStore.js';
import { loadOrInitConfig, saveConfig, type Config } from '../../config/config.js';
import { initAgentMd } from '../../prompt/initAgentMd.js';
import { NoTTYError } from '../cliPrompt.js';
import { resetStdinForReadline } from './stdinHandoff.js';

const ONBOARDED_MARKER = path.join(os.homedir(), '.config', 'brainrouter', '.onboarded');

export function isOnboarded(): boolean {
  try { return fs.existsSync(ONBOARDED_MARKER); } catch { return false; }
}

export function markOnboarded(): void {
  try {
    fs.mkdirSync(path.dirname(ONBOARDED_MARKER), { recursive: true });
    fs.writeFileSync(ONBOARDED_MARKER, '', 'utf8');
  } catch {
    /* non-fatal */
  }
}

export interface WizardRunOptions {
  workspaceRoot: string;
}

export interface WizardRunResult {
  state: WizardState;
  config?: Config;
}

/**
 * Mount the Ink wizard and wait for it to finish. Returns the final
 * `WizardState` (which includes `committed` / `aborted` flags) and,
 * when committed, the freshly-saved Config.
 *
 * Why Ink instead of the previous raw-stdout runner? Ink owns the
 * render loop and diffs the cell grid between frames, so we don't
 * track cursor positions ourselves. Every redraw bug the previous
 * approach had (creep, stacking, off-by-one) is eliminated by design.
 */
export async function runWizard(opts: WizardRunOptions): Promise<WizardRunResult> {
  if (!process.stdin.isTTY) {
    throw new NoTTYError(
      'BrainRouter has no config and stdin is not a TTY — run `brainrouter` in an interactive terminal at least once to complete the setup wizard.',
    );
  }

  const finalState = await new Promise<WizardState>((resolve) => {
    let captured: WizardState | undefined;
    const instance = render(
      <WizardApp workspaceRoot={opts.workspaceRoot} onFinish={(s) => {
        // Capture but DON'T resolve yet — we want to wait for Ink's
        // own unmount to complete (next tick) before handing stdin
        // back to readline. Resolving prematurely would let our
        // caller try to read stdin while Ink is still tearing down,
        // which breaks the next readline.createInterface.
        captured = s;
      }} />,
      {
        // Don't put Ink's output into the alt-screen buffer — we want
        // the final frame (Done summary) to stay in scrollback after
        // unmount. Ink's default is `exitOnCtrlC: true` which is fine
        // for our Ctrl+C abort path.
        exitOnCtrlC: true,
      },
    );
    instance.waitUntilExit().then(() => {
      // Hand stdin back to the caller in a state where readline (or
      // anything else) can take it. Ink leaves stdin unref'd, in raw
      // mode false, with its 'readable' listener removed; without
      // this reset the post-wizard REPL would print its banner and
      // then immediately exit because nothing kept the event loop
      // alive. See cli/ink/stdinHandoff.ts for the full rationale.
      resetStdinForReadline();
      resolve(captured ?? { aborted: true, committed: false, currentStep: 'welcome', draft: {}, warnings: [] } as WizardState);
    }).catch(() => {
      resetStdinForReadline();
      resolve(captured ?? { aborted: true, committed: false, currentStep: 'welcome', draft: {}, warnings: [] } as WizardState);
    });
  });

  let savedConfig: Config | undefined;
  if (finalState.committed) {
    savedConfig = commitWizardDraft(finalState.draft, opts.workspaceRoot);
    markOnboarded();
  }
  return { state: finalState, config: savedConfig };
}

function commitWizardDraft(draft: WizardDraft, workspaceRoot: string): Config {
  const config = loadOrInitConfig();
  if (draft.provider) {
    config.llm = {
      provider: 'openai',
      apiKey: draft.apiKey ?? '',
      model: draft.model ?? draft.provider.defaultModel,
      endpoint: draft.customEndpoint ?? draft.provider.endpoint,
    };
  }
  if (draft.mcp && draft.mcp.kind !== 'skip') {
    const profileName = draft.mcp.kind === 'remote-http' ? 'remote' : draft.mcp.kind === 'local-http' ? 'local-http' : 'local-stdio';
    const serverConfig = mcpPickToServerConfig(draft.mcp);
    if (serverConfig) {
      config.servers[profileName] = serverConfig;
      config.activeServer = profileName;
    }
  } else if (draft.mcp?.kind === 'skip' && !config.activeServer) {
    config.activeServer = '';
  }
  saveConfig(config);
  if (draft.theme) {
    try { writePreferences(workspaceRoot, { theme: draft.theme }); } catch { /* non-fatal */ }
  }
  if (draft.writeAgentMd) {
    try { initAgentMd(workspaceRoot); } catch { /* non-fatal */ }
  }
  return config;
}

function mcpPickToServerConfig(pick: McpPick) {
  if (pick.kind === 'local-stdio') {
    return { type: 'stdio' as const, command: 'brainrouter-mcp', args: [], identity: 'brainrouter' as const };
  }
  if (pick.kind === 'local-http') {
    return { type: 'http' as const, url: 'http://localhost:3747/mcp', identity: 'brainrouter' as const };
  }
  if (pick.kind === 'remote-http') {
    return { type: 'http' as const, url: pick.url, apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  return undefined;
}
