import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import fs from 'node:fs';
import path from 'node:path';
import { Frame } from '../prompt/Frame.js';
import { Picker, type PickerResult, type PickerRow } from '../prompt/Picker.js';
import { TextField } from '../prompt/TextField.js';
import {
  PROVIDER_CATALOG,
  type ProviderEntry,
  detectProviderFromEnv,
  validateApiKey,
  maskApiKey,
} from '@kinqs/brainrouter-core/provider';
import {
  type McpPick,
  type WizardDraft,
  type WizardState,
} from '../../wizard/types.js';
import { fetchOpenAiCompatibleModels } from '../../wizard/modelsApi.js';
import type { ThemeMode } from '../../theme/theme.js';
import { progressBadge } from './shared.js';
import { formatMcpForBadge, probeMcp } from './mcpProbe.js';

// --- Steps -------------------------------------------------------------

export function WelcomeStep({ accent, onAdvance, onAbort }: { accent: string; onAdvance: () => void; onAbort: () => void }) {
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

export function ThemeStep({ accent, onPick, onAbort }: { accent: string; onPick: (mode: ThemeMode) => void; onAbort: () => void }) {
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

export function ProviderStep({ accent, onPick, onAbort }: { accent: string; onPick: (p: ProviderEntry, customEndpoint?: string) => void; onAbort: () => void }) {
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

export function ApiKeyStep({ accent, provider, onAccept, onAbort }: { accent: string; provider: ProviderEntry; onAccept: (key: string, warning?: string) => void; onAbort: () => void }) {
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

export function ModelStep({ accent, provider, apiKey, customEndpoint, onPick, onAbort }: {
  accent: string;
  provider: ProviderEntry;
  apiKey: string;
  customEndpoint?: string;
  onPick: (model: string) => void;
  onAbort: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [modelsList, setModelsList] = useState<string[]>(provider.models ?? []);
  const [subtitleHint, setSubtitleHint] = useState<string>(`Pick the chat model for ${provider.label}. Use "Other" to type any supported model.`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchOpenAiCompatibleModels(provider, apiKey, customEndpoint);
      if (cancelled) return;
      if (res.ok) {
        const withDefault = provider.defaultModel && res.models.includes(provider.defaultModel)
          ? [provider.defaultModel, ...res.models.filter((m) => m !== provider.defaultModel)]
          : res.models;
        setModelsList(withDefault);
        setSubtitleHint(`Pick a model — ${res.models.length} returned by ${provider.label}'s /v1/models endpoint. Use "Other" to type any name.`);
      } else {
        setSubtitleHint((provider.models ?? []).length > 0
          ? `Pick a model. (Live list unavailable — ${res.error}. Showing configured fallback list.) Use "Other" to type any name.`
          : `Live model list unavailable — ${res.error}. Type the model id with "Other model".`);
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
  const rows: PickerRow[] = modelsList.map((m) => ({
    id: m,
    label: m,
    value: provider.defaultModel && m === provider.defaultModel ? 'default' : '',
  }));
  const initialCursor = Math.max(0, provider.defaultModel ? modelsList.indexOf(provider.defaultModel) : 0);
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
        if (model) onPick(model);
      }}
    />
  );
}

export function McpStep({ accent, draft, onAccept, onAbort }: {
  accent: string;
  draft: WizardDraft;
  onAccept: (pick: McpPick, warning?: string) => void;
  onAbort: () => void;
}) {
  // Stages:
  //   pick       — top-level transport picker
  //   remote-url — text field for the remote http URL
  //   mcp-apikey — BrainRouter API key prompt (for local-http + remote-http)
  //   probing    — spinner while the probe is in flight
  const [stage, setStage] = useState<'pick' | 'remote-url' | 'mcp-apikey' | 'probing'>('pick');
  const [pendingPick, setPendingPick] = useState<McpPick | undefined>(undefined);
  const [probeMsg, setProbeMsg] = useState<string>('');

  // 0.3.7 — kick the probe once we have the final pick (with apiKey
  // already set). Shared between the post-url and post-key transitions
  // so we don't have two copies of the same Promise+setStage dance.
  function startProbe(pick: McpPick) {
    setPendingPick(pick);
    setStage('probing');
    setProbeMsg('contacting server (5s timeout)');
    (async () => {
      const probe = await probeMcp(pick, draft, (m) => setProbeMsg(m));
      onAccept(pick, probe.warning);
    })();
  }

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
          // Carry the URL into the api-key stage; the BrainRouter MCP
          // server's HTTP transport requires a Bearer token whenever
          // auth is enabled, so we always offer the input (blank OK
          // for servers without auth).
          setPendingPick({ kind: 'remote-http', url: r.text.trim() });
          setStage('mcp-apikey');
        }}
      />
    );
  }

  if (stage === 'mcp-apikey' && pendingPick) {
    // 0.3.7 — added so users can input the BRAINROUTER_API_KEY during
    // onboarding. Pre-fills from the env var; blank submission is
    // valid (local servers without auth, dev mode).
    const envValue = process.env.BRAINROUTER_API_KEY ?? '';
    const isLocal = pendingPick.kind === 'local-http';
    return (
      <TextField
        title='BrainRouter API key'
        subtitle={
          envValue
            ? `BRAINROUTER_API_KEY is set — press ENTER to accept, type to override, or leave blank if the server is unauthenticated.`
            : isLocal
              ? `Optional — leave blank if your local brainrouter-mcp HTTP server runs without auth. Required when BRAINROUTER_API_KEY is set on the server side.`
              : `Optional — leave blank if the hosted MCP doesn't require auth. Use the key issued by the BrainRouter dashboard (Users → Profile).`
        }
        badge={progressBadge('mcp')}
        prefilled={envValue}
        placeholder='(blank OK)'
        accentColor={accent}
        onResolve={(r) => {
          // Esc cancels the whole step back to the picker so the user
          // can choose a different transport.
          if (r.kind !== 'accept') return setStage('pick');
          const apiKey = r.text.trim() || undefined;
          const next: McpPick = pendingPick.kind === 'local-http'
            ? { kind: 'local-http', apiKey }
            : pendingPick.kind === 'remote-http'
              ? { kind: 'remote-http', url: pendingPick.url, apiKey }
              : pendingPick;
          startProbe(next);
        }}
      />
    );
  }

  type Row = PickerRow & { pick: McpPick };
  const rows: Row[] = [
    { id: 'local-stdio',  label: 'Local stdio',  value: 'spawn brainrouter-mcp', description: 'No HTTP server needed — the CLI spawns the MCP child', pick: { kind: 'local-stdio' } },
    { id: 'local-http',   label: 'Local HTTP',   value: 'http://localhost:3747', description: 'Connect to a brainrouter-mcp HTTP server running locally', pick: { kind: 'local-http' } },
    { id: 'remote-http',  label: 'Remote HTTP',  value: 'custom URL',            description: 'Connect to a hosted BrainRouter MCP (URL + API key)', pick: { kind: 'remote-http', url: '' } },
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
          // URL first → then api-key stage → then probe.
          setStage('remote-url');
          return;
        }
        if (picked.kind === 'local-http') {
          // Skip the URL prompt (fixed at http://localhost:3747/mcp)
          // and go straight to the api-key stage.
          setPendingPick(picked);
          setStage('mcp-apikey');
          return;
        }
        if (picked.kind === 'skip') {
          onAccept(picked);
          return;
        }
        // local-stdio — no api key needed (process-local auth).
        startProbe(picked);
      }}
    />
  );
}

export function AgentMdStep({ accent, workspaceRoot, onPick, onAbort }: {
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

export function DoneStep({ state, accent, onCommit }: { state: WizardState; accent: string; onCommit: () => void }) {
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
  if (pick.kind === 'local-http') {
    return pick.apiKey
      ? `local http (http://localhost:3747/mcp) · key ${maskApiKey(pick.apiKey)}`
      : 'local http (http://localhost:3747/mcp) · no key';
  }
  if (pick.kind === 'remote-http') {
    return pick.apiKey
      ? `remote · ${pick.url} · key ${maskApiKey(pick.apiKey)}`
      : `remote · ${pick.url} · no key`;
  }
  return 'skipped (offline-only)';
}
