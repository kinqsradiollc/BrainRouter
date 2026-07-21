import React from 'react';
import { WizardApp } from '../WizardApp.js';
import type { WizardState, WizardDraft } from '../../wizard/types.js';
import type { McpPick } from '../../wizard/types.js';
import { writePreferences } from '@kinqs/brainrouter-core/session';
import type { Config } from '@kinqs/brainrouter-core/config';
import { NoTTYError } from '../../prompt/cliPrompt.js';
import { getAmbientChat } from '../chat/ambientChat.js';
import { resetStdinForReadline } from '../terminal/stdinHandoff.js';
import { renderWithResizeClear } from '../terminal/renderWithResizeClear.js';
import {
  updateGlobalSetupConfigOrThrow,
} from '../../wizard/globalPersistence.js';
import { resolveWizardMcpProfileName } from '../../wizard/mcpProfile.js';

export { isOnboarded, markOnboarded } from '../../wizard/globalPersistence.js';

export interface WizardRunOptions {
  workspaceRoot: string;
}

export interface WizardRunResult {
  state: WizardState;
  config?: Config;
  /** Ephemeral choice for the caller; never persisted over saved MCP profiles. */
  skipMcpForLaunch: boolean;
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
  const ambient = getAmbientChat();
  if (!ambient && !process.stdin.isTTY) {
    throw new NoTTYError(
      'BrainRouter has no config and stdin is not a TTY — run `brainrouter` in an interactive terminal at least once to complete the setup wizard.',
    );
  }

  const finalState = ambient
    ? await collectFromChatOverlay(ambient)
    : await collectFromStandaloneInk();

  let savedConfig: Config | undefined;
  if (finalState.committed) {
    savedConfig = commitWizardDraft(finalState.draft, opts.workspaceRoot);
  }
  return {
    state: finalState,
    config: savedConfig,
    skipMcpForLaunch: wizardSkipsMcpForLaunch(finalState),
  };
}

export function wizardSkipsMcpForLaunch(state: WizardState): boolean {
  return state.committed && state.draft.mcp?.kind === 'skip';
}

function abortedWizardState(): WizardState {
  return { aborted: true, committed: false, currentStep: 'welcome', draft: {}, warnings: [] };
}

async function collectFromChatOverlay(
  ambient: NonNullable<ReturnType<typeof getAmbientChat>>,
): Promise<WizardState> {
  return new Promise<WizardState>((resolve) => {
    let resolved = false;
    const finish = (state: WizardState) => {
      if (resolved) return;
      resolved = true;
      ambient.clearOverlay();
      resolve(state);
    };
    ambient.showOverlay(
      <WizardApp exitOnFinish={false} onFinish={finish} />,
    ).catch(() => finish(abortedWizardState()));
  });
}

async function collectFromStandaloneInk(): Promise<WizardState> {
  return new Promise<WizardState>((resolve) => {
    let captured: WizardState | undefined;
    const { instance, cleanupResizeClear } = renderWithResizeClear(
      <WizardApp onFinish={(state) => { captured = state; }} />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => {
      cleanupResizeClear();
      resetStdinForReadline();
      resolve(captured ?? abortedWizardState());
    }).catch(() => {
      cleanupResizeClear();
      resetStdinForReadline();
      resolve(captured ?? abortedWizardState());
    });
  });
}

function commitWizardDraft(draft: WizardDraft, workspaceRoot: string): Config {
  const config = updateGlobalSetupConfigOrThrow((current) =>
    applyWizardDraftToConfig(current, draft),
  );
  if (draft.theme) {
    try { writePreferences(workspaceRoot, { theme: draft.theme }); } catch { /* non-fatal */ }
  }
  return config;
}

/**
 * Apply the durable portion of a wizard draft. MCP Skip is deliberately absent
 * from that durable portion: it means local-only for the current launch, while
 * any saved profiles remain available the next time BrainRouter starts.
 */
export function applyWizardDraftToConfig(current: Config, draft: WizardDraft): Config {
  const config: Config = {
    ...current,
    servers: { ...current.servers },
    ...(current.llm ? { llm: { ...current.llm } } : {}),
  };
  if (draft.provider) {
    config.llm = {
      provider: draft.provider.id,
      apiKey: draft.apiKey ?? '',
      model: draft.model ?? '',
      endpoint: draft.customEndpoint ?? draft.provider.endpoint,
    };
  }
  if (draft.mcp && draft.mcp.kind !== 'skip') {
    const profileName = resolveWizardMcpProfileName(config.servers, draft.mcp);
    const serverConfig = mcpPickToServerConfig(draft.mcp);
    if (serverConfig) {
      config.servers[profileName] = serverConfig;
      config.activeServer = profileName;
      config.activeBrainrouterServer = profileName;
    }
  }
  return config;
}

function mcpPickToServerConfig(pick: McpPick) {
  if (pick.kind === 'local-stdio') {
    return { type: 'stdio' as const, command: 'brainrouter-mcp', args: [], identity: 'brainrouter' as const };
  }
  if (pick.kind === 'local-http') {
    return { type: 'http' as const, url: 'http://localhost:3747/mcp', apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  if (pick.kind === 'remote-http') {
    return { type: 'http' as const, url: pick.url, apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  return undefined;
}
