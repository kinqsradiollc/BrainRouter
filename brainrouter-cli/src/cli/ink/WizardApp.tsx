import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import fs from 'node:fs';
import path from 'node:path';
import { Frame } from './Frame.js';
import { Picker, type PickerResult, type PickerRow } from './Picker.js';
import { TextField, type TextFieldResult } from './TextField.js';
import {
  PROVIDER_CATALOG,
  type ProviderEntry,
  detectProviderFromEnv,
  validateApiKey,
  maskApiKey,
} from '../wizard/providers.js';
import {
  initWizardState,
  reduceWizard,
  type McpPick,
  type Step,
  type WizardDraft,
  type WizardState,
} from '../wizard/types.js';
import { fetchOpenAiCompatibleModels } from '../wizard/modelsApi.js';
import { McpClientWrapper } from '../../runtime/mcpClient.js';
import type { ThemeMode } from '../theme.js';

/**
 * Ink-based wizard. Replaces the raw-stdout `runWizard` runner
 * (which had compounding redraw bugs no matter how many off-by-one
 * fixes we applied — Ink owns the render loop and diffs the cell
 * grid, so frames never stack or creep).
 *
 * Driver pattern:
 *   - One `<WizardApp>` mounts at the top-level (`render(<WizardApp>)`).
 *   - It picks ONE child to render based on `state.currentStep`.
 *   - Each step is its own component (`<WelcomeStep>`, `<ThemeStep>`,
 *     etc.) that takes a `state` + `onAdvance` / `onBack` /
 *     `onAbort` / `onWarn` callback.
 *   - On terminal step (done / abort), the wizard calls
 *     `useApp().exit()` and `props.onFinish(state)` so the caller
 *     can persist + unmount.
 */

const TOTAL_STEPS = 6;

function progressBadge(step: Step): string | undefined {
  const decisionSteps: Step[] = ['theme', 'provider', 'apiKey', 'model', 'mcp', 'agentMd'];
  const idx = decisionSteps.indexOf(step);
  if (idx < 0) return undefined;
  return `Step ${idx + 1} of ${TOTAL_STEPS}`;
}

const ACCENT: Record<ThemeMode, string> = {
  dark: '#CC9166',
  light: '#A24E1F',
  mono: 'white',
};

export interface WizardAppProps {
  workspaceRoot: string;
  /** Fires once the wizard reaches a terminal state. */
  onFinish: (state: WizardState) => void;
}

export function WizardApp({ workspaceRoot, onFinish }: WizardAppProps) {
  const [state, setState] = useState<WizardState>(() => initWizardState());
  const { exit } = useApp();

  // Use refs for the callbacks so child components receive STABLE
  // references across renders. Otherwise every render gives them a new
  // function identity, which (a) makes their useEffect dependency
  // arrays churn (re-firing preview/probe effects) and (b) prevents
  // React from skipping re-renders. The stable-callback ref pattern is
  // canonical for React 18/19 component composition.
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; });

  // Notify the caller + exit Ink when the wizard reaches terminal.
  // Dep on state.aborted + state.committed only — not on `state` or
  // `onFinish` — so the effect fires exactly ONCE per terminal
  // transition. (Earlier code depended on `state` itself, which fired
  // the effect on every state update; harmless but wasteful.)
  useEffect(() => {
    if (state.aborted || state.committed) {
      onFinishRef.current(state);
      exit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.aborted, state.committed]);

  const theme: ThemeMode = state.draft.theme ?? 'dark';
  const accent = ACCENT[theme];

  const dispatchAdvance = useCallback((patch: Partial<WizardDraft>) =>
    setState((s) => reduceWizard(s, { kind: 'advance', patch })), []);
  const dispatchWarn = useCallback((message: string) =>
    setState((s) => reduceWizard(s, { kind: 'warn', message })), []);
  const dispatchAbort = useCallback(() => setState((s) => reduceWizard(s, { kind: 'abort' })), []);
  const dispatchCommit = useCallback(() => setState((s) => reduceWizard(s, { kind: 'commit' })), []);

  switch (state.currentStep) {
    case 'welcome':
      return <WelcomeStep accent={accent} onAdvance={() => dispatchAdvance({})} onAbort={dispatchAbort} />;
    case 'theme':
      return (
        <ThemeStep
          accent={accent}
          onPick={(mode) => dispatchAdvance({ theme: mode })}
          onAbort={dispatchAbort}
        />
      );
    case 'provider':
      return (
        <ProviderStep
          accent={accent}
          onPick={(provider, customEndpoint) => dispatchAdvance({ provider, customEndpoint })}
          onAbort={dispatchAbort}
        />
      );
    case 'apiKey':
      return (
        <ApiKeyStep
          accent={accent}
          provider={state.draft.provider!}
          onAccept={(apiKey, warning) => {
            if (warning) dispatchWarn(warning);
            dispatchAdvance({ apiKey });
          }}
          onAbort={dispatchAbort}
        />
      );
    case 'model':
      return (
        <ModelStep
          accent={accent}
          provider={state.draft.provider!}
          apiKey={state.draft.apiKey ?? ''}
          customEndpoint={state.draft.customEndpoint}
          onPick={(model) => dispatchAdvance({ model })}
          onAbort={dispatchAbort}
        />
      );
    case 'mcp':
      return (
        <McpStep
          accent={accent}
          draft={state.draft}
          onAccept={(mcp, warning) => {
            if (warning) dispatchWarn(warning);
            dispatchAdvance({ mcp });
          }}
          onAbort={dispatchAbort}
        />
      );
    case 'agentMd':
      return (
        <AgentMdStep
          accent={accent}
          workspaceRoot={workspaceRoot}
          onPick={(writeAgentMd) => dispatchAdvance({ writeAgentMd })}
          onAbort={dispatchAbort}
        />
      );
    case 'done':
      // Commit immediately on mount; render the summary while the caller
      // persists.
      return <DoneStep state={state} accent={accent} onCommit={dispatchCommit} />;
  }
}

// --- Steps -------------------------------------------------------------

function WelcomeStep({ accent, onAdvance, onAbort }: { accent: string; onAdvance: () => void; onAbort: () => void }) {
  const handleResolve = (r: PickerResult) => {
    if (r.kind === 'pick' && r.id === 'start') onAdvance();
    else onAbort();
  };
  return (
    <Picker
      title='🧠  BrainRouter'
      subtitle='A memory-native coding agent that runs in your terminal. This wizard takes ~60 seconds and writes to ~/.config/brainrouter/config.json plus <workspace>/.brainrouter/cli/preferences.json. Press ENTER to start, q to abort.'
      badge='Welcome'
      rows={[
        { id: 'start', label: 'Start setup', description: 'Theme → Provider → API key → Model → MCP → AGENT.md' },
        { id: 'abort', label: 'Abort', description: 'Exit without saving anything' },
      ]}
      accentColor={accent}
      onResolve={handleResolve}
    />
  );
}

function ThemeStep({ accent, onPick, onAbort }: { accent: string; onPick: (mode: ThemeMode) => void; onAbort: () => void }) {
  return (
    <Picker
      title='Theme'
      subtitle='Pick a color palette.'
      badge={progressBadge('theme')}
      rows={[
        { id: 'dark',  label: 'Dark',  description: 'Default · saturated accents on a black terminal' },
        { id: 'light', label: 'Light', description: 'Darker accents for white terminals (solarized-light, GitHub light)' },
        { id: 'mono',  label: 'Mono',  description: 'No color · screenshots, CI logs, pipe-to-less' },
      ]}
      initialCursor={0}
      accentColor={accent}
      onResolve={(r) => {
        if (r.kind !== 'pick') return onAbort();
        onPick(r.id as ThemeMode);
      }}
    />
  );
}

function ProviderStep({ accent, onPick, onAbort }: { accent: string; onPick: (p: ProviderEntry, customEndpoint?: string) => void; onAbort: () => void }) {
  const detected = detectProviderFromEnv();
  const rows: PickerRow[] = PROVIDER_CATALOG.map((p) => {
    const envHit = !!process.env[p.envKey];
    const status = envHit ? 'env detected' : p.local ? 'local · key optional' : 'needs API key';
    return { id: p.id, label: p.label, value: status, description: p.hint };
  });
  const initialCursor = detected
    ? Math.max(0, PROVIDER_CATALOG.findIndex((p) => p.id === detected.id))
    : 0;
  return (
    <Picker
      title='LLM provider'
      subtitle={detected
        ? `Detected ${detected.envKey} in your shell — ${detected.label} is pre-selected. Pick "Other" to enter a custom OpenAI-compatible endpoint.`
        : 'Pick the LLM provider for the chat agent. Pick "Other" to enter a custom OpenAI-compatible endpoint.'}
      badge={progressBadge('provider')}
      rows={rows}
      initialCursor={initialCursor}
      allowOther
      otherLabel='Other endpoint'
      otherDescription='OpenAI-compatible /v1/chat/completions URL'
      accentColor={accent}
      onResolve={(r) => {
        if (r.kind === 'cancelled') return onAbort();
        if (r.kind === 'other') {
          const url = r.text;
          const custom: ProviderEntry = {
            id: 'custom',
            label: 'Custom endpoint',
            hint: url,
            endpoint: url,
            envKey: 'BRAINROUTER_LLM_API_KEY',
            local: /localhost|127\.0\.0\.1|::1|0\.0\.0\.0/.test(url),
            models: [],
            defaultModel: 'gpt-4o-mini',
          };
          onPick(custom, url);
          return;
        }
        const provider = PROVIDER_CATALOG.find((p) => p.id === r.id);
        if (provider) onPick(provider);
      }}
    />
  );
}

function ApiKeyStep({ accent, provider, onAccept, onAbort }: { accent: string; provider: ProviderEntry; onAccept: (key: string, warning?: string) => void; onAbort: () => void }) {
  const envValue = process.env[provider.envKey] ?? '';
  const subtitle = envValue
    ? `${provider.envKey} is set in your shell — press ENTER to accept, or type a different key.`
    : provider.local
      ? `${provider.label} is local — a blank API key is fine (just press ENTER).`
      : `Paste your ${provider.label} API key. Stored at ~/.config/brainrouter/config.json.`;
  return (
    <TextField
      title='API key'
      subtitle={subtitle}
      badge={`${progressBadge('apiKey')} · ${provider.label}`}
      prefilled={envValue}
      placeholder={provider.local ? '(blank OK for local endpoints)' : 'paste your API key here'}
      accentColor={accent}
      validate={(raw) => {
        const v = validateApiKey(raw, provider);
        return v.kind === 'reject' ? v.reason : undefined;
      }}
      onResolve={(r) => {
        if (r.kind !== 'accept') return onAbort();
        const verdict = validateApiKey(r.text, provider);
        const warning = verdict.kind === 'accept' ? verdict.warning : undefined;
        onAccept(r.text, warning);
      }}
    />
  );
}

function ModelStep({ accent, provider, apiKey, customEndpoint, onPick, onAbort }: {
  accent: string;
  provider: ProviderEntry;
  apiKey: string;
  customEndpoint?: string;
  onPick: (model: string) => void;
  onAbort: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [modelsList, setModelsList] = useState<string[]>(provider.models);
  const [subtitleHint, setSubtitleHint] = useState<string>(`Pick the chat model for ${provider.label}.`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchOpenAiCompatibleModels(provider, apiKey, customEndpoint);
      if (cancelled) return;
      if (res.ok) {
        const withDefault = res.models.includes(provider.defaultModel)
          ? [provider.defaultModel, ...res.models.filter((m) => m !== provider.defaultModel)]
          : res.models;
        setModelsList(withDefault);
        setSubtitleHint(`Pick a model — ${res.models.length} returned by ${provider.label}'s /v1/models endpoint. Use "Other" to type any name.`);
      } else {
        setSubtitleHint(`Pick a model. (Live list unavailable — ${res.error}. Showing curated short-list.) Use "Other" to type any name.`);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [provider, apiKey, customEndpoint]);

  if (loading) {
    return (
      <Frame title='Model' subtitle={`Fetching ${provider.label} models…`} badge={progressBadge('model')} accentColor={accent}>
        <Box>
          <Text color="green">{React.createElement(Spinner as any, { type: 'dots' })}</Text>
          <Text color="gray">  loading {provider.label} /v1/models</Text>
        </Box>
      </Frame>
    );
  }
  const rows: PickerRow[] = (modelsList.length > 0 ? modelsList : [provider.defaultModel]).map((m) => ({
    id: m,
    label: m,
    value: m === provider.defaultModel ? 'default' : '',
  }));
  const initialCursor = Math.max(0, modelsList.indexOf(provider.defaultModel));
  return (
    <Picker
      title='Model'
      subtitle={subtitleHint}
      badge={progressBadge('model')}
      rows={rows}
      initialCursor={initialCursor}
      allowOther
      otherLabel='Other model'
      otherDescription='Type any model name supported by this endpoint'
      accentColor={accent}
      onResolve={(r) => {
        if (r.kind === 'cancelled') return onAbort();
        const model = r.kind === 'other' ? r.text.trim() : r.id;
        onPick(model || provider.defaultModel);
      }}
    />
  );
}

function McpStep({ accent, draft, onAccept, onAbort }: {
  accent: string;
  draft: WizardDraft;
  onAccept: (pick: McpPick, warning?: string) => void;
  onAbort: () => void;
}) {
  const [stage, setStage] = useState<'pick' | 'remote-url' | 'probing'>('pick');
  const [pendingPick, setPendingPick] = useState<McpPick | undefined>(undefined);
  const [probeMsg, setProbeMsg] = useState<string>('');

  if (stage === 'probing' && pendingPick) {
    return (
      <Frame title='MCP probe' subtitle={`Probing ${formatMcpForBadge(pendingPick)}…`} badge={progressBadge('mcp')} accentColor={accent}>
        <Box>
          <Text color="green">{React.createElement(Spinner as any, { type: 'dots' })}</Text>
          <Text color="gray">  {probeMsg || 'connecting…'}</Text>
        </Box>
      </Frame>
    );
  }

  if (stage === 'remote-url') {
    return (
      <TextField
        title='Remote MCP URL'
        subtitle='Paste the full URL (e.g. https://brainrouter.example.com/mcp). Press Esc to back out.'
        badge={progressBadge('mcp')}
        prefilled=''
        placeholder='https://...'
        accentColor={accent}
        validate={(raw) => {
          const v = raw.trim();
          if (!v) return 'URL is required';
          try { new URL(v); } catch { return 'not a valid URL'; }
          return undefined;
        }}
        onResolve={(r) => {
          if (r.kind !== 'accept') return setStage('pick');
          const pick: McpPick = { kind: 'remote-http', url: r.text.trim() };
          setPendingPick(pick);
          setStage('probing');
          setProbeMsg('contacting server (5s timeout)');
          (async () => {
            const probe = await probeMcp(pick, draft, (m) => setProbeMsg(m));
            onAccept(pick, probe.warning);
          })();
        }}
      />
    );
  }

  type Row = PickerRow & { pick: McpPick };
  const rows: Row[] = [
    { id: 'local-stdio',  label: 'Local stdio',  value: 'spawn brainrouter-mcp', description: 'No HTTP server needed — the CLI spawns the MCP child', pick: { kind: 'local-stdio' } },
    { id: 'local-http',   label: 'Local HTTP',   value: 'http://localhost:3747', description: 'Connect to a brainrouter-mcp HTTP server running locally', pick: { kind: 'local-http' } },
    { id: 'remote-http',  label: 'Remote HTTP',  value: 'custom URL',            description: 'Connect to a hosted BrainRouter MCP (URL + optional key)', pick: { kind: 'remote-http', url: '' } },
    { id: 'skip',         label: 'Skip',         value: 'no MCP',                description: 'Local tools only · no recall, skills, or capture', pick: { kind: 'skip' } },
  ];
  return (
    <Picker
      title='MCP server'
      subtitle={"BrainRouter's memory + skills live behind an MCP server. Pick how to reach it."}
      badge={progressBadge('mcp')}
      rows={rows}
      initialCursor={0}
      accentColor={accent}
      onResolve={(r) => {
        if (r.kind === 'cancelled') return onAbort();
        if (r.kind !== 'pick') return;
        const picked = rows.find((row) => row.id === r.id)?.pick;
        if (!picked) return;
        if (picked.kind === 'remote-http') {
          setStage('remote-url');
          return;
        }
        if (picked.kind === 'skip') {
          onAccept(picked);
          return;
        }
        setPendingPick(picked);
        setStage('probing');
        setProbeMsg('contacting server (5s timeout)');
        (async () => {
          const probe = await probeMcp(picked, draft, (m) => setProbeMsg(m));
          onAccept(picked, probe.warning);
        })();
      }}
    />
  );
}

function formatMcpForBadge(pick: McpPick): string {
  if (pick.kind === 'local-stdio') return 'local stdio';
  if (pick.kind === 'local-http') return 'http://localhost:3747/mcp';
  if (pick.kind === 'remote-http') return pick.url;
  return 'no MCP';
}

async function probeMcp(pick: McpPick, draft: WizardDraft, onStatus: (s: string) => void): Promise<{ ok: boolean; warning?: string }> {
  if (pick.kind === 'skip') return { ok: true };
  const wrapper = new McpClientWrapper();
  const llmConfig = draft.provider && draft.model
    ? { provider: 'openai' as const, apiKey: draft.apiKey ?? '', model: draft.model, endpoint: draft.customEndpoint ?? draft.provider.endpoint }
    : undefined;
  const serverConfig = mcpPickToServerConfig(pick);
  if (!serverConfig) return { ok: false, warning: 'Could not build MCP server config for this pick.' };
  try {
    onStatus('connecting…');
    await Promise.race([
      wrapper.connect(serverConfig, llmConfig, 'wizard'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('probe timed out after 5s')), 5_000)),
    ]);
    await wrapper.close();
    return { ok: true };
  } catch (err: any) {
    try { await wrapper.close(); } catch { /* ignore */ }
    return {
      ok: false,
      warning: `MCP probe failed (${err?.message ?? err}). Profile saved — start the server and run /mcp reconnect later.`,
    };
  }
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

function AgentMdStep({ accent, workspaceRoot, onPick, onAbort }: {
  accent: string;
  workspaceRoot: string;
  onPick: (write: boolean) => void;
  onAbort: () => void;
}) {
  const agentMdPath = path.join(workspaceRoot, 'AGENT.md');
  const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
  const exists = fs.existsSync(agentMdPath) || fs.existsSync(claudeMdPath);
  const rows: PickerRow[] = exists
    ? [
        { id: 'skip',      label: 'Skip',      value: 'keep existing file', description: 'Leave the current AGENT.md / CLAUDE.md alone' },
        { id: 'overwrite', label: 'Overwrite', value: 'replace contents',   description: 'Drop the starter template over the existing file' },
      ]
    : [
        { id: 'write', label: 'Write AGENT.md', value: 'recommended', description: 'Scaffold a starter template in the workspace root' },
        { id: 'skip',  label: 'Skip',           value: 'no file',     description: 'Write AGENT.md manually later' },
      ];
  return (
    <Picker
      title='AGENT.md'
      subtitle={exists
        ? 'Workspace already has AGENT.md / CLAUDE.md — skipping by default. Pick "Overwrite" only if you really want to replace it.'
        : 'AGENT.md gives every coding agent (Claude Code, Codex, BrainRouter, …) a single hub of repo conventions. Recommended.'}
      badge={progressBadge('agentMd')}
      rows={rows}
      initialCursor={0}
      accentColor={accent}
      onResolve={(r) => {
        if (r.kind === 'cancelled') return onAbort();
        if (r.kind !== 'pick') return;
        onPick(r.id === 'write' || r.id === 'overwrite');
      }}
    />
  );
}

function DoneStep({ state, accent, onCommit }: { state: WizardState; accent: string; onCommit: () => void }) {
  useEffect(() => {
    onCommit();
  }, [onCommit]);
  return (
    <Frame title='✓ Setup complete' badge='Done' accentColor={accent}>
      <Box flexDirection='column'>
        <SummaryRow label='theme'    value={state.draft.theme ?? 'dark'} />
        <SummaryRow label='provider' value={state.draft.provider?.label ?? '(unset)'} />
        <SummaryRow label='model'    value={state.draft.model ?? '(unset)'} />
        <SummaryRow label='api key'  value={maskApiKey(state.draft.apiKey ?? '')} />
        <SummaryRow label='mcp'      value={formatMcpSummary(state.draft.mcp)} />
        <SummaryRow label='agent.md' value={state.draft.writeAgentMd ? 'written' : 'skipped'} />
        <Box marginTop={1}>
          <Text color="gray" dimColor>Config saved to ~/.config/brainrouter/config.json. Re-run any time with /init. Tweak individual knobs with /config.</Text>
        </Box>
        {state.warnings.length > 0 ? (
          <Box flexDirection='column' marginTop={1}>
            <Text color="yellow">Advisories:</Text>
            {state.warnings.map((w, i) => (
              <Box key={i}>
                <Text color="yellow">  ! </Text>
                <Text>{w.message}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    </Frame>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={10}><Text color="gray">{label}</Text></Box>
      <Text>{value}</Text>
    </Box>
  );
}

function formatMcpSummary(pick?: McpPick): string {
  if (!pick) return '(unset)';
  if (pick.kind === 'local-stdio') return 'local stdio (brainrouter-mcp)';
  if (pick.kind === 'local-http') return 'local http (http://localhost:3747/mcp)';
  if (pick.kind === 'remote-http') return `remote · ${pick.url}`;
  return 'skipped (offline-only)';
}
