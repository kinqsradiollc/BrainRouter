// The interactive /config settings home panel: builds the row list (each row
// knows how to render its current value + which editor to open) and runs the
// picker loop. Editors live in ./editors.ts and ./mcpProfiles.ts; the raw dump
// in ./rawConfig.ts.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { listProviderNames, describeAgentModel, SUBAGENT_ROLES } from '@kinqs/brainrouter-core/provider';
import { readPreferences, resolveEffort } from '@kinqs/brainrouter-core/session';
import { buildTheme } from '../../theme/theme.js';
import type { PickerRow } from '../../ink/prompt/runPicker.js';
import { pickFromList, findDefaultProviderName } from './shared.js';
import {
  editDefaultProvider, editProviders, editWebSearch, editAgentModels, editTheme,
  editStatusline, editEffort, editExecutionMode, editReviewPolicy, editPersonality,
  editEditorMode, toggleQuiet, editWireFormat,
} from './editors.js';
import { editMcp } from './mcpProfiles.js';
import { showRawConfigPanel } from './rawConfig.js';
import { buildSchemaPanelRows } from './schemaRenderer.js';

export async function runHomePanel(ctx: CommandContext): Promise<void> {
  const { agent } = ctx;
  let cursor = 0;
  while (true) {
    const theme = buildTheme(readPreferences(agent.workspaceRoot).theme === 'mono' ? 'mono' : readPreferences(agent.workspaceRoot).theme === 'light' ? 'light' : 'dark');
    const rows = buildPanelRows(ctx);
    const pickerRows: PickerRow[] = rows.map((r) => ({
      id: r.key,
      label: r.label,
      value: r.current(),
      disabled: r.key === '__separator__',
    }));
    const result = await pickFromList({
      theme,
      title: '⚙️  /config',
      subtitle: `Workspace: ${agent.workspaceRoot}.  Edit a row, or pick "View raw config" to dump the scrubbed JSON.`,
      rows: pickerRows,
      initialCursor: cursor,
      footer: '↑/↓ navigate  ·  ↵ edit row  ·  esc / q close',
    });
    if (result.kind !== 'pick') return;
    const picked = rows.find((r) => r.key === result.id);
    if (!picked) return;
    cursor = rows.indexOf(picked);
    if (picked.key === '__exit') return;
    if (picked.key === '__raw') {
      await showRawConfigPanel(ctx, theme);
      continue;
    }
    try {
      await picked.edit(ctx);
    } catch (err: any) {
      console.log(chalk.red(`\n  /config "${picked.label}" failed: ${err?.message ?? err}\n`));
    }
  }
}

interface PanelRow {
  key: string;
  label: string;
  current: () => string;
  edit: (ctx: CommandContext) => Promise<boolean>;
}

function buildPanelRows(ctx: CommandContext): PanelRow[] {
  const { agent, config } = ctx;
  const prefs = () => readPreferences(agent.workspaceRoot);
  return [
    {
      key: 'llm',
      label: 'Primary provider',
      current: () => {
        const name = findDefaultProviderName(ctx);
        if (name) {
          const p = config.providers?.[name];
          return `${name} · ${p?.model ?? '(model unset)'}`;
        }
        const llm = config.llm;
        if (!llm) return '(not configured)';
        return `${llm.model} · not saved as a Provider`;
      },
      edit: editDefaultProvider,
    },
    {
      key: 'mcp',
      label: 'MCP servers',
      current: () => {
        const profiles = Object.keys(config.servers);
        if (profiles.length === 0) return '(none configured)';
        const active = config.activeServer && config.servers[config.activeServer] ? config.activeServer : profiles[0];
        const others = profiles.filter((p) => p !== active);
        const head = `★ ${active}`;
        if (others.length === 0) return head;
        const tail = others.length <= 2 ? others.join(', ') : `${others.slice(0, 2).join(', ')}, +${others.length - 2}`;
        return `${head} + ${tail}`;
      },
      edit: editMcp,
    },
    {
      key: 'providers',
      label: 'Providers',
      current: () => {
        const names = listProviderNames(config);
        return names.length === 0 ? '(none configured)' : names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')}, +${names.length - 3}`;
      },
      edit: editProviders,
    },
    {
      key: 'web-search',
      label: 'Web search',
      current: () => {
        const ws = config.cli?.webSearch ?? {};
        return `${ws.provider ?? getCliKnobs().webSearch.provider} · robots ${ws.crawler?.respectRobots === false ? 'off' : 'on'}`;
      },
      edit: editWebSearch,
    },
    {
      key: 'agent-models',
      label: 'Sub-agent models',
      current: () => {
        const roles = SUBAGENT_ROLES.filter((r) => config.agentModels?.[r]);
        if (roles.length === 0) return '(all inherit the main model)';
        return roles.map((r) => `${r}→${describeAgentModel(config, r)}`).slice(0, 2).join(' · ') + (roles.length > 2 ? ` +${roles.length - 2}` : '');
      },
      edit: editAgentModels,
    },
    ...buildSchemaPanelRows(ctx, ['modelLimits', 'notifications']),
    { key: 'theme',         label: 'Theme',            current: () => prefs().theme,                 edit: editTheme },
    { key: 'statusline',    label: 'Statusline',       current: () => prefs().statusline,            edit: editStatusline },
    { key: 'effort',        label: 'Reasoning effort', current: () => `${resolveEffort(agent.workspaceRoot).effort} (${resolveEffort(agent.workspaceRoot).source})`, edit: editEffort },
    { key: 'mode',          label: 'Execution mode',   current: () => prefs().executionMode,         edit: editExecutionMode },
    { key: 'review-policy', label: 'Review policy',    current: () => prefs().reviewPolicy,          edit: editReviewPolicy },
    { key: 'quiet',         label: 'Quiet mode',       current: () => prefs().quiet ? 'on' : 'off',  edit: toggleQuiet },
    {
      key: 'personality',
      label: 'Personality',
      current: () => {
        const current = prefs();
        return current.personalityMode === 'auto'
          ? `automatic → ${current.personality} (${current.personalitySource})`
          : current.personality;
      },
      edit: editPersonality,
    },
    { key: 'editor',        label: 'Editor mode',      current: () => prefs().editorMode,            edit: editEditorMode },
    {
      key: 'wire-format',
      label: 'Wire format (per provider)',
      current: () => {
        // Live-read so the row summary stays in sync after a sub-pick without
        // needing to re-enter the home panel.
        const overrides = getCliKnobs().providerRequestFormat ?? {};
        const entries = Object.entries(overrides);
        if (entries.length === 0) return '(all using built-in defaults)';
        const head = entries.slice(0, 3).map(([k, v]) => `${k} → ${v}`);
        return entries.length <= 3 ? head.join(' · ') : `${head.join(' · ')}, +${entries.length - 3}`;
      },
      edit: editWireFormat,
    },
    { key: '__raw',         label: 'View raw config',  current: () => 'JSON dump',                   edit: async () => false },
    { key: '__exit',        label: 'Quit (esc)',       current: () => '',                            edit: async () => false },
  ];
}
