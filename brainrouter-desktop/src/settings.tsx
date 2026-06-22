/**
 * DESK-4c — the Settings modal, modeled on modern coding-agent desktop
 * settings: left category nav + search, right scrollable sections with
 * toggle/select/input rows. Values reuse the CLI stores: global preferences
 * still go through `action:set-pref`, while mode/review/effort are session
 * scoped through the same session-mode layer the CLI resolves.
 */
import React, { useMemo, useState } from 'react';
import { wireBadge, type CommandsCatalog, type DeskCommand, type SettingsSection } from './lib/commands/commands.js';
import { Icon } from './icons.js';

export interface ConfigSnapshot {
  model?: string;
  provider?: string;
  endpoint?: string | null;
  fallbackModel?: string | null;
  workspaceRoot?: string;
  sandbox?: 'on' | 'off';
  prefs?: Record<string, unknown>;
  workspacePrefs?: Record<string, unknown>;
  sessionMode?: Record<string, unknown>;
  modeScope?: 'session' | 'workspace';
  cli?: Record<string, unknown>;
  integrations?: { github?: { repo: string | null; hasToken: boolean; tokenSource: string | null } };
  permissionRules?: { allow: string[]; deny: string[] };
  hooks?: Array<{ id: string; event: string; command: string; enabled: boolean; match?: string }>;
  servers?: Array<{ id: string; online: boolean; identity?: string; detail?: string; type?: 'stdio' | 'http'; url?: string | null; command?: string | null; hasKey?: boolean; envCount?: number; headerCount?: number }>;
  activeServer?: string | null; // WS9 — the active BrainRouter brain (only one)
  // §multi-provider — named OpenAI-compatible providers (keys masked) + per-role routing.
  providers?: Array<{ name: string; provider: string; model: string; endpoint: string | null; hasKey: boolean }>;
  defaultProviderName?: string | null;
  agentModels?: Array<{ role: string; provider: string | null; model: string | null }>;
  // Known-provider catalog (the CLI wizard's list) so the main provider is PICKED.
  providerCatalog?: Array<{ id: string; label: string; endpoint: string; local: boolean }>;
  // §settings-completeness — the raw cli.* config block (current knob values).
  cliKnobs?: Record<string, unknown>;
  // EXTENSIONS — discovered extensions + workspace trust state.
  extensions?: {
    trusted: boolean;
    items: Array<{ name: string; version: string; source: 'builtin' | 'user' | 'workspace'; description: string; contributes: string[]; enabled: boolean; blocked: boolean }>;
  };
}

/** Sub-agent roles that can be routed to their own provider/model. */
const SUBAGENT_ROLES = ['default', 'explorer', 'architect', 'reviewer', 'worker', 'verifier'] as const;
type SubagentRole = (typeof SUBAGENT_ROLES)[number];

const SUBAGENT_ROLE_LABELS: Record<SubagentRole, string> = {
  default: 'Fallback for sub-agents',
  explorer: 'explorer',
  architect: 'architect',
  reviewer: 'reviewer',
  worker: 'worker',
  verifier: 'verifier',
};

const NAV: Array<{ section: SettingsSection; icon: string; title: string; group: 'Settings' | 'Desktop app' }> = [
  { section: 'general', icon: 'gear', title: 'General', group: 'Settings' },
  { section: 'models', icon: 'spark', title: 'Models', group: 'Settings' },
  { section: 'permissions', icon: 'shield', title: 'Permissions', group: 'Settings' },
  { section: 'memory', icon: 'brain', title: 'Memory', group: 'Settings' },
  { section: 'hooks', icon: 'link', title: 'Hooks', group: 'Settings' },
  { section: 'workflow-automation', icon: 'fork', title: 'Workflow automation', group: 'Settings' },
  { section: 'extensions', icon: 'plug', title: 'Extensions', group: 'Settings' },
  { section: 'connectors', icon: 'bolt', title: 'MCP', group: 'Settings' },
  { section: 'integrations', icon: 'branch', title: 'Integrations', group: 'Settings' },
  { section: 'advanced', icon: 'gear', title: 'Advanced', group: 'Settings' },
  { section: 'observability', icon: 'chart', title: 'Usage', group: 'Settings' },
  { section: 'appearance', icon: 'palette', title: 'Appearance', group: 'Desktop app' },
  { section: 'commands', icon: 'command', title: 'Commands', group: 'Desktop app' },
];

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="set-row">
      <div className="grow">
        <div className="set-title">{title}</div>
        {desc ? <div className="set-desc">{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />;
}

/** A typed value control for one cli knob: boolean → toggle, number → number
 *  input, object/array → per-key JSON, everything else → text. */
function KnobValue({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): React.ReactElement {
  if (typeof value === 'boolean') return <Toggle on={value} onChange={onChange} />;
  if (typeof value === 'number') {
    return <input className="ctl" type="number" style={{ width: 150 }} value={Number.isFinite(value) ? String(value) : ''}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
  }
  if (value !== null && typeof value === 'object') {
    return <input className="ctl cli-knob-json" defaultValue={JSON.stringify(value)} spellCheck={false}
      onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { /* leave prior value */ } }} />;
  }
  return <input className="ctl" style={{ minWidth: 200 }} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} />;
}

/** §control-consistency — a PROPER editor for the raw `cli.*` config block: each
 *  knob is a typed row (toggle / number / text) with add + remove, instead of a
 *  hand-edited JSON blob. Saves the whole block via the existing set-cli-json. */
// WS11 — knobs that have a dedicated structured editor elsewhere (Permissions,
// Workflow automation, Models, Integrations). Never shown as raw JSON here.
const DEDICATED_KNOBS = new Set(['permissions', 'automation', 'track', 'providers', 'agentModels']);
// WS11 — internal/safety knobs (loop & storm guards, sandbox internals, scheduler
// ticks, offload tuning): non-obvious to hand-edit and rarely needed, so hidden
// from the default list. Still settable via `/config` or the raw disclosure.
const INTERNAL_KNOBS = new Set([
  'stormWindow', 'repeatToolSequenceLimit', 'repeatSequenceExemptTools', 'repeatLoopLimit',
  'offloadMaxEntries', 'offloadRetentionMs', 'scheduleTickMs',
  'sandboxReadPaths', 'sandboxWritePaths', 'sandboxNetwork', 'sandboxUnavailable', 'sandboxEnforceWhenSilent',
]);

function CliConfigEditor({ cli, onSave }: { cli: Record<string, unknown>; onSave: (next: Record<string, unknown>) => void }): React.ReactElement {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...cli }));
  React.useEffect(() => setDraft({ ...cli }), [cli]);
  const [newKey, setNewKey] = useState('');
  // WS11 — hide dedicated-editor + internal knobs from the raw list. They stay in
  // `draft` so saving never drops them; they're just not hand-edited as raw JSON here.
  const keys = Object.keys(draft).filter((k) => !DEDICATED_KNOBS.has(k) && !INTERNAL_KNOBS.has(k)).sort();
  const dirty = JSON.stringify(draft) !== JSON.stringify(cli);
  const setVal = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));
  const remove = (k: string): void => setDraft((d) => { const n = { ...d }; delete n[k]; return n; });
  const addKey = (): void => { const k = newKey.trim(); if (!k || k in draft) return; setDraft((d) => ({ ...d, [k]: '' })); setNewKey(''); };
  return (
    <div className="cli-knobs">
      {keys.length === 0 ? <div className="set-desc cli-knob-empty">No custom <code>cli</code> knobs set — add one below or use the dedicated controls in <b>Advanced</b>.</div> : null}
      {keys.map((k) => (
        <div key={k} className="cli-knob-row">
          <code className="cli-knob-key" title={k}>{k}</code>
          <div className="cli-knob-val"><KnobValue value={draft[k]} onChange={(v) => setVal(k, v)} /></div>
          <button className="icon-btn cli-knob-x" title={`Remove ${k}`} onClick={() => remove(k)}><Icon name="x" size={13} /></button>
        </div>
      ))}
      <div className="cli-knob-add">
        <input className="ctl" placeholder="add a knob key, e.g. maxToolLoops" value={newKey}
          onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addKey(); }} />
        <button className="btn" onClick={addKey} disabled={!newKey.trim()}>Add knob</button>
      </div>
      <div className="set-actions">
        <button className="btn" disabled={!dirty} onClick={() => setDraft({ ...cli })}>Reset</button>
        <button className="btn primary" disabled={!dirty} onClick={() => onSave(draft)}>Save changes</button>
      </div>
    </div>
  );
}

/** GitHub integration for Track sync — repo + a write-only token (never read
 * back; the host only reports whether one is set). Saves to config.json
 * cli.track.* via action:set-track-github, replacing any need for a .env. */
function GithubIntegration({ gh, onSave }: { gh: { repo: string | null; hasToken: boolean; tokenSource: string | null }; onSave: (args: { repo?: string; token?: string; clearToken?: boolean }) => void }): React.ReactElement {
  const [repo, setRepo] = useState(gh.repo ?? '');
  const [token, setToken] = useState('');
  React.useEffect(() => { setRepo(gh.repo ?? ''); }, [gh.repo]);
  const repoChanged = repo.trim() !== (gh.repo ?? '');
  const dirty = repoChanged || token.trim() !== '';
  const connected = !!(gh.repo && gh.hasToken);
  return (
    <div className="gh-int">
      <div className={`gh-int-status${connected ? ' ok' : ''}`}>
        <span className="gh-int-dot" />
        {connected ? <>Connected to <b className="mono">{gh.repo}</b>{gh.tokenSource === 'env' ? ' · token via environment' : ''}</>
          : gh.repo ? <>Repository set — add a token to connect</> : <>Not configured</>}
      </div>
      <Row title="Repository" desc="owner/name — the GitHub repo this workspace's Track board syncs issues + members with.">
        <input className="ctl mono" style={{ minWidth: 220 }} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false} autoCapitalize="off" />
      </Row>
      <Row title="Access token" desc={<>A fine-grained personal access token with <b>Issues</b> read/write. Stored only in your local <code>config.json</code>; sent to GitHub and nowhere else, and never displayed again.</>}>
        <div className="gh-token-row">
          <input className="ctl mono" style={{ minWidth: 220 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false}
            placeholder={gh.hasToken ? '•••••••••••• (set)' : 'github_pat_… / ghp_…'} />
          {gh.hasToken ? <button className="gh-token-clear" onClick={() => onSave({ clearToken: true })}>Remove</button> : null}
        </div>
      </Row>
      <div className="gh-int-actions">
        <button className="gh-int-save" disabled={!dirty} onClick={() => { onSave({ repo: repo.trim(), token: token.trim() || undefined }); setToken(''); }}>Save</button>
      </div>
    </div>
  );
}

/** §settings-completeness — a number knob that commits on blur/Enter. Empty =
 * clears the knob (reverts to the default). */
function KnobNumber({ value, onSave, placeholder }: { value: unknown; onSave: (v: number | null) => void; placeholder?: string }): React.ReactElement {
  const cur = typeof value === 'number' ? String(value) : '';
  const [v, setV] = useState(cur);
  React.useEffect(() => setV(cur), [cur]);
  const commit = (): void => { const t = v.trim(); if (t === '') { onSave(null); return; } const n = Number(t); if (Number.isFinite(n)) onSave(n); };
  return <input className="ctl" type="number" style={{ width: 140 }} value={v} placeholder={placeholder ?? 'default'}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

type ChoiceOption = { value: string; label: string; detail?: string; disabled?: boolean };

function ChoiceControl({ value, options, onChange, placeholder = 'Select' }: {
  value: string;
  options: ChoiceOption[];
  onChange: (v: string) => void;
  placeholder?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <div className="choice" onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <button type="button" className={`ctl choice-btn${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span className={selected ? '' : 'choice-placeholder'}>{selected?.label ?? placeholder}</span>
        <Icon name="chev-down" size={14} />
      </button>
      {open ? (
        <div className="choice-menu">
          {options.map((o) => (
            <button key={o.value} type="button" className={`choice-option${o.value === value ? ' selected' : ''}`} disabled={o.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (!o.disabled) { onChange(o.value); setOpen(false); } }}>
              <span>{o.label}</span>
              {o.detail ? <span className="choice-detail">{o.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }): React.ReactElement {
  return <ChoiceControl value={value} options={options.map((o) => ({ value: o, label: o }))} onChange={onChange} />;
}

function ComboInput({ value, options, onChange, placeholder, disabled, style }: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const filtered = (q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, 80);
  return (
    <div className="combo" style={style} onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <input className="ctl combo-input" disabled={disabled} value={value} placeholder={placeholder}
        onFocus={() => setOpen(true)} onChange={(e) => { onChange(e.target.value); setOpen(true); }} />
      {open && !disabled && filtered.length > 0 ? (
        <div className="choice-menu combo-menu">
          {filtered.map((o) => (
            <button key={o} type="button" className={`choice-option${o === value ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(o); setOpen(false); }}>
              <span>{o}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** WS10 — cross-session usage tally for the contributions heatmap. Shape mirrors
 *  the host `usage-history` query ({ days, total }). */
export interface UsageHistory {
  days: Array<{ day: string; promptTokens: number; completionTokens: number; calls: number; turns: number }>;
  total: { promptTokens: number; completionTokens: number; calls: number; turns: number };
}

/** GitHub-contributions-style grid: one square per UTC day, columns are weeks
 *  (aligned on weekday), brightness scales with that day's token volume. Themed
 *  via the accent var + opacity so it tracks any palette. */
function UsageHeatmap({ hist }: { hist: UsageHistory }): JSX.Element {
  const days = hist.days;
  if (!days.length) return <pre className="usage-pre">No usage recorded yet.</pre>;
  const tok = (d: { promptTokens: number; completionTokens: number }) => d.promptTokens + d.completionTokens;
  const max = Math.max(1, ...days.map(tok));
  const level = (n: number) => (n <= 0 ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1);
  const weekday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0=Sun
  const cols: Array<Array<(typeof days)[number] | null>> = [];
  let cur: Array<(typeof days)[number] | null> = [];
  for (let i = 0; i < weekday(days[0].day); i++) cur.push(null); // pad first column to its weekday
  for (const d of days) {
    cur.push(d);
    if (cur.length === 7) { cols.push(cur); cur = []; }
  }
  if (cur.length) { while (cur.length < 7) cur.push(null); cols.push(cur); }
  return (
    <div className="usage-heatmap" style={{ display: 'flex', gap: 3, overflowX: 'auto', padding: '4px 0' }}>
      {cols.map((col, ci) => (
        <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {col.map((d, ri) =>
            d ? (
              <div
                key={ri}
                title={`${d.day}: ${tok(d).toLocaleString()} tokens · ${d.turns} turns · ${d.calls} req`}
                style={{ width: 11, height: 11, borderRadius: 2, background: 'var(--accent)', opacity: level(tok(d)) === 0 ? 0.07 : 0.2 + 0.2 * level(tok(d)) }}
              />
            ) : (
              <div key={ri} style={{ width: 11, height: 11 }} />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

export function SettingsDialog(props: {
  open: boolean;
  section: SettingsSection;
  setSection: (s: SettingsSection) => void;
  onClose: () => void;
  snapshot: ConfigSnapshot | null;
  usageLines: string[];
  usageHistory: UsageHistory | null; // WS10 — cross-session contributions heatmap
  tokens: { promptTokens: number; completionTokens: number; turns: number } | null;
  commands: DeskCommand[];
  catalog: CommandsCatalog | null;
  onPref: (key: string, value: unknown) => void;
  /** §endpoint-driven-models — the ACTIVE endpoint's GET /models list, and one
   * per named provider (keyed by name). Drives every model picker so we never
   * hand-write a model list. */
  endpointModels: string[];
  providerModels: Record<string, string[]>;
  onModelSave: (model: string) => void;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  onRunCommand: (c: DeskCommand) => void;
  codeFont: string;
  onCodeFont: (f: string) => void;
  theme: string;
  onTheme: (t: string) => void;
  chatWidth: string;
  onChatWidth: (w: string) => void;
  chatSize: string;
  onChatSize: (z: string) => void;
  accent: string;
  onAccent: (a: string) => void;
}): React.ReactElement | null {
  const { snapshot, section } = props;
  const [search, setSearch] = useState('');
  const [zoomed, setZoomed] = useState(false);
  // T7 — permission-rule editor draft; T6 — MCP add-server draft.
  const [ruleKind, setRuleKind] = useState<'allow' | 'deny'>('deny');
  const [ruleDraft, setRuleDraft] = useState('');
  const [mcp, setMcp] = useState<{ id: string; type: 'stdio' | 'http'; command: string; url: string; apiKey: string; headers: string; env: string }>({ id: '', type: 'stdio', command: '', url: '', apiKey: '', headers: '', env: '' });
  // §multi-provider — add-provider draft + per-role model drafts.
  const [provDraft, setProvDraft] = useState<{ name: string; provider: string; endpoint: string; apiKey: string; model: string }>({ name: '', provider: 'openai', endpoint: '', apiKey: '', model: '' });
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, { provider: string; model: string }>>({});
  // WS10 — usage heatmap range selector (week / month / year). Re-fetches usage-history.
  const [usageDays, setUsageDays] = useState(365);
  // WS12 — provider configure modal + delete confirmation.
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<string | null>(null);
  const refreshSnapshot = (): void => props.onAction('q-snapshot', 'config-snapshot');
  /** WS12 — open the configure modal: edit an existing provider, prefill from a
   *  catalog id, or a blank custom provider. */
  const openProviderModal = (init?: { name?: string; provider?: string; endpoint?: string | null; model?: string; editing?: string }): void => {
    setEditingProvider(init?.editing ?? null);
    setProvDraft({ name: init?.name ?? '', provider: init?.provider ?? 'openai', endpoint: init?.endpoint ?? '', apiKey: '', model: init?.model ?? '' });
    setProvModalOpen(true);
  };
  const prefs = (snapshot?.prefs ?? {}) as Record<string, unknown>;
  const ps = (key: string, dflt: string): string => String(prefs[key] ?? dflt);
  const pb = (key: string, dflt: boolean): boolean => Boolean(prefs[key] ?? dflt);
  const tier = (prefs.tier as string | null | undefined) ?? 'follow model';
  // §settings — cli.* knob helpers (per-knob writer), lifted to component scope
  // so a knob-backed control can live in its natural category, not only under
  // Advanced. Shared with the CLI; empty/clear reverts to the default.
  const knobs = (snapshot?.cliKnobs ?? {}) as Record<string, unknown>;
  const setKnob = (key: string, value: unknown): void => { props.onAction('a-knob', 'action:set-cli-knob', { key, value }); setTimeout(refreshSnapshot, 80); };
  const kb = (key: string): boolean => Boolean(knobs[key]);
  const ks = (key: string, dflt: string): string => String(knobs[key] ?? dflt);
  const telemetryOn = (knobs.telemetry as { enabled?: boolean } | undefined)?.enabled !== false;
  const github = (snapshot?.integrations as { github?: { repo: string | null; hasToken: boolean; tokenSource: string | null } } | undefined)?.github ?? { repo: null, hasToken: false, tokenSource: null };
  const saveGithub = (args: { repo?: string; token?: string; clearToken?: boolean }): void => { props.onAction('a-gh', 'action:set-track-github', args); setTimeout(refreshSnapshot, 100); };

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.commands;
    return props.commands.filter((c) => `${c.base} ${c.desc} ${c.category}`.toLowerCase().includes(q));
  }, [props.commands, search]);

  // §endpoint-driven-models — every OpenAI-compatible endpoint exposes GET
  // /models, so when a model-picker section opens we (re)load the active
  // endpoint's models AND each named provider's, and the pickers below render
  // them as in-app suggestions. No model name is ever hand-written.
  const providerNames = (snapshot?.providers ?? []).map((p) => p.name).join(',');
  React.useEffect(() => {
    if (!props.open || section !== 'models') return;
    props.onAction('q-models', 'list-models');
    for (const name of providerNames ? providerNames.split(',') : []) props.onAction('q-models', 'list-models', { provider: name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, section, providerNames]);
  // The /models list backing a role's picker: the active endpoint for
  // main/inherit, else the named provider's own list.
  const modelsForProvider = (provider: string): string[] =>
    (!provider || provider === '(main)' || provider === 'inherit') ? props.endpointModels : (props.providerModels[provider] ?? []);

  if (!props.open) return null;

  const body = (() => {
    switch (section) {
      case 'general': return (
        <>
          <div className="set-h">General</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Model &amp; providers moved to their own <b>Models</b> section.</div>
          <Row title="Reasoning effort" desc="low = terse, medium = default, high = step-by-step, xhigh = maximum. Forwarded to provider reasoning slots when the model supports it. (/effort)">
            <Select value={ps('effort', 'medium')} options={['low', 'medium', 'high', 'xhigh']} onChange={(v) => props.onPref('effort', v)} />
          </Row>
          <Row title="Personality" desc="Communication style for the agent's prose. (/personality)">
            <Select value={ps('personality', 'standard')} options={['concise', 'standard', 'detailed', 'pair-programmer']} onChange={(v) => props.onPref('personality', v)} />
          </Row>
          <Row title="Model tier pin" desc="Pin the tier ladder: flash | standard | pro. “follow model” lets <<<NEEDS_HIGH>>> self-escalation work. (/tier)">
            <Select value={tier} options={['follow model', 'flash', 'standard', 'pro']}
              onChange={(v) => props.onPref('tier', v === 'follow model' ? null : v)} />
          </Row>
          <div className="set-h2">Session</div>
          <Row title="New chat" desc="Fresh session key; current transcript stays on disk. (/new)">
            <button className="btn" onClick={() => props.onAction('a-new', 'new-session')}>New chat</button>
          </Row>
          <Row title="Compact this session" desc="LLM-driven compaction of the active history — same as /compact in the CLI.">
            <button className="btn" onClick={() => props.onAction('a-compact', 'action:compact')}>Compact</button>
          </Row>
          <Row title="Clear history" desc="Drops the in-memory history for this session. (/clear)">
            <button className="btn danger" onClick={() => props.onAction('a-clear', 'action:clear')}>Clear</button>
          </Row>
        </>
      );
      case 'models': {
        const providerCatalog = snapshot?.providerCatalog ?? [];
        const savedProviders = snapshot?.providers ?? [];
        const defaultProvider = snapshot?.defaultProviderName ?? '';
        const currentDefault = defaultProvider
          ? savedProviders.find((p) => p.name === defaultProvider)
          : null;
        return (
          <>
            <div className="set-h">Models</div>
            <div className="set-desc" style={{ marginBottom: 6 }}>Configure providers once, then pick which saved provider is the default. Endpoint and key fields live only inside Providers.</div>

            <div className="set-h2">Default model &amp; provider</div>
            <Row title="Provider" desc={currentDefault ? `${currentDefault.provider} · ${currentDefault.model}` : snapshot?.model ? `Current default is ${snapshot.model}. Save it as a Provider below to manage it here.` : 'Add a provider below, then select it here.'}>
              <ChoiceControl value={defaultProvider} placeholder={savedProviders.length ? 'Select provider' : 'No providers yet'}
                options={savedProviders.map((p) => ({ value: p.name, label: p.name, detail: `${p.provider} · ${p.model}` }))}
                onChange={(name) => { props.onAction('a-setdefault', 'action:set-default-provider', { name }); setTimeout(refreshSnapshot, 80); }} />
            </Row>

            <div className="set-h2">Set up a provider</div>
            <div className="set-desc" style={{ marginBottom: 8 }}>Click one — a dialog opens with the endpoint pre-filled and a live model picker; just add your key.</div>
            <div className="provider-gallery">
              {providerCatalog.length === 0 ? <div className="empty">No providers in the catalog.</div> : null}
              {providerCatalog.map((c) => {
                const configured = savedProviders.some((p) => p.provider === c.id);
                const host = c.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'custom endpoint';
                const isCustom = c.id === 'openai-compatible';
                return (
                  <button key={c.id} type="button" className="provider-card" title={`Set up ${c.label}`}
                    onClick={() => openProviderModal({ name: isCustom ? '' : c.id, provider: isCustom ? '' : c.id, endpoint: isCustom ? '' : c.endpoint })}>
                    <span className="pc-name">{c.label}{configured ? <span className="pc-tag ok" title="Already configured">✓</span> : null}</span>
                    <span className="pc-host">{host}</span>
                  </button>
                );
              })}
            </div>

            <div className="set-h2">Your providers</div>
            {savedProviders.length === 0 ? <div className="empty">None yet — pick one above, or add a custom provider.</div> : null}
            {savedProviders.length ? (
              <div className="provider-gallery">
                {[...savedProviders].sort((a, b) => (a.name === defaultProvider ? -1 : b.name === defaultProvider ? 1 : 0)).map((p) => (
                  <div key={p.name} className="provider-card saved">
                    <span className="pc-name">{p.name}{p.name === defaultProvider ? <span className="pc-tag default">Default</span> : null}</span>
                    <span className="pc-host">{p.model}</span>
                    <span className="pc-actions">
                      {p.name !== defaultProvider ? <button className="btn" title="Make this the default model" onClick={() => { props.onAction('a-setdefault', 'action:set-default-provider', { name: p.name }); setTimeout(refreshSnapshot, 80); }}>Set default</button> : null}
                      <button className="btn" onClick={() => openProviderModal({ editing: p.name, name: p.name, provider: p.provider, endpoint: p.endpoint ?? '', model: p.model })}>Configure</button>
                      <button className="btn danger" title="Remove this provider" onClick={() => setConfirmDeleteProvider(p.name)}>Remove</button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <button className="btn" style={{ marginTop: 4 }} onClick={() => openProviderModal()}>+ Add custom provider</button>

            {provModalOpen ? (
              <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setProvModalOpen(false); }}>
                <div className="dialog" style={{ width: 480 }}>
                  <div className="dialog-title">{editingProvider ? `Configure ${editingProvider}` : 'Add a provider'}</div>
                  <div className="mcp-add">
                    <div className="mcp-add-row">
                      <input className="ctl" placeholder="name (e.g. groq)" disabled={!!editingProvider} value={provDraft.name} onChange={(e) => setProvDraft((d) => ({ ...d, name: e.target.value }))} />
                      <ChoiceControl value={providerCatalog.some((c) => c.id === provDraft.provider) ? provDraft.provider : '__custom__'}
                        options={[...providerCatalog.map((c) => ({ value: c.id, label: c.label, detail: c.local ? 'local' : undefined })), { value: '__custom__', label: 'Custom...' }]}
                        onChange={(id) => {
                          if (id === '__custom__') setProvDraft((d) => ({ ...d, provider: '', endpoint: '' }));
                          else setProvDraft((d) => ({ ...d, provider: id, endpoint: providerCatalog.find((c) => c.id === id)?.endpoint ?? d.endpoint }));
                        }} />
                    </div>
                    {providerCatalog.some((c) => c.id === provDraft.provider) ? null : (
                      <input className="ctl" placeholder="provider id (openai, groq, …)" value={provDraft.provider} onChange={(e) => setProvDraft((d) => ({ ...d, provider: e.target.value }))} />
                    )}
                    <input className="ctl" placeholder="endpoint, e.g. https://api.groq.com/openai/v1"
                      value={provDraft.endpoint || providerCatalog.find((c) => c.id === provDraft.provider)?.endpoint || ''}
                      onChange={(e) => setProvDraft((d) => ({ ...d, endpoint: e.target.value }))} />
                    <div className="mcp-add-row">
                      {/* WS12 — model picker driven by the endpoint's live GET /models
                          (never a hardcoded list); free-text fallback for an offline
                          endpoint or a model the list doesn't include. */}
                      <input className="ctl" placeholder="default model" list="ws12-provider-models" value={provDraft.model} onChange={(e) => setProvDraft((d) => ({ ...d, model: e.target.value }))} />
                      <datalist id="ws12-provider-models">
                        {(editingProvider ? (props.providerModels[editingProvider] ?? []) : props.endpointModels).map((m) => <option key={m} value={m} />)}
                      </datalist>
                      <input className="ctl" type="password" placeholder={editingProvider ? 'API key (blank = keep current)' : 'API key'} value={provDraft.apiKey} onChange={(e) => setProvDraft((d) => ({ ...d, apiKey: e.target.value }))} />
                    </div>
                    <div className="set-actions">
                      <button className="btn" onClick={() => setProvModalOpen(false)}>Cancel</button>
                      <button className="btn primary" disabled={!provDraft.name.trim() || !provDraft.model.trim()}
                        onClick={() => {
                          const catalogEndpoint = providerCatalog.find((c) => c.id === provDraft.provider)?.endpoint ?? '';
                          props.onAction('a-setprov', 'action:set-provider', { name: (editingProvider ?? provDraft.name).trim(), provider: provDraft.provider.trim(), endpoint: (provDraft.endpoint || catalogEndpoint).trim(), model: provDraft.model.trim(), apiKey: provDraft.apiKey.trim() });
                          setProvModalOpen(false);
                          setEditingProvider(null);
                          setProvDraft({ name: '', provider: 'openai', endpoint: '', apiKey: '', model: '' });
                          setTimeout(refreshSnapshot, 80);
                        }}>{editingProvider ? 'Save provider' : 'Add provider'}</button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {confirmDeleteProvider ? (
              <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteProvider(null); }}>
                <div className="dialog dangerous" style={{ width: 380 }}>
                  <div className="dialog-title">Remove “{confirmDeleteProvider}”?</div>
                  <div className="set-desc" style={{ marginBottom: 12 }}>Deletes the saved provider and its stored key. Sub-agents routed to it fall back to the main default provider.</div>
                  <div className="set-actions">
                    <button className="btn" onClick={() => setConfirmDeleteProvider(null)}>Cancel</button>
                    <button className="btn primary" onClick={() => { props.onAction('a-rmprov', 'action:remove-provider', { name: confirmDeleteProvider }); setConfirmDeleteProvider(null); setTimeout(refreshSnapshot, 80); }}>Remove</button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="set-h2">Sub-agent models</div>
            <div className="set-desc" style={{ marginBottom: 6 }}>Optional routing for spawned agents. Leave roles unset to follow the main default provider. The fallback row only applies to sub-agents without a role-specific override.</div>
            {SUBAGENT_ROLES.map((role) => {
              const cur = snapshot?.agentModels?.find((a) => a.role === role);
              const fallback = role === 'default' ? null : snapshot?.agentModels?.find((a) => a.role === 'default');
              const curSel = !cur ? 'inherit' : (cur.provider ?? '(main)');
              const d = roleDraft[role] ?? { provider: curSel, model: cur?.model ?? '' };
              const providerOptions: ChoiceOption[] = [
                { value: 'inherit', label: role === 'default' ? 'follow main default' : 'inherit' },
                { value: '(main)', label: 'main provider', detail: snapshot?.model },
                ...(snapshot?.providers ?? []).map((p) => ({ value: p.name, label: p.name, detail: p.model })),
              ];
              const setD = (patch: Partial<{ provider: string; model: string }>): void => setRoleDraft((r) => ({ ...r, [role]: { ...d, ...patch } }));
              const roleModels = modelsForProvider(d.provider);
              const curText = cur ? `${cur.provider ?? '(main)'} · ${cur.model ?? 'provider default'}` : '';
              const isRedundantFallback = role === 'default' && !!cur && (
                (cur.provider === defaultProvider && (!cur.model || cur.model === currentDefault?.model)) ||
                (!cur.provider && (!cur.model || cur.model === snapshot?.model))
              );
              const desc = cur
                ? (role === 'default'
                    ? (isRedundantFallback ? `same as main default; clear it so sub-agents follow future default changes` : `fallback currently overrides unconfigured sub-agents: ${curText}`)
                    : `currently: ${curText}`)
                : (role === 'default'
                    ? 'unset; unconfigured sub-agents follow the main default provider'
                    : (fallback ? `inherits fallback: ${fallback.provider ?? '(main)'} · ${fallback.model ?? 'provider default'}` : 'inherits the main default provider'));
              return (
                <Row key={role} title={SUBAGENT_ROLE_LABELS[role]} desc={desc}>
                  <ChoiceControl value={d.provider} options={providerOptions} onChange={(v) => setD({ provider: v, model: '' })} />
                  <ComboInput style={{ width: 150 }} disabled={d.provider === 'inherit'}
                    placeholder={d.provider === 'inherit' ? '—' : (roleModels.length ? 'model (blank = default)' : '/models…')}
                    options={roleModels} value={d.model} onChange={(model) => setD({ model })} />
                  <button className="btn" onClick={() => {
                    const provider = d.provider === 'inherit' || d.provider === '(main)' ? '' : d.provider;
                    const model = d.provider === 'inherit' ? '' : d.model.trim();
                    props.onAction('a-setrole', 'action:set-agent-model', { role, provider, model });
                    setRoleDraft((r) => { const n = { ...r }; delete n[role]; return n; });
                    refreshSnapshot();
                  }}>{d.provider === 'inherit' ? 'Clear' : 'Save'}</button>
                </Row>
              );
            })}
          </>
        );
      }
      case 'permissions': return (
        <>
          <div className="set-h">Permissions</div>
          <Row title="Execution mode" desc="planning routes shell commands through per-call approval; fast skips confirmation for non-dangerous commands. (/mode)">
            <Select value={ps('executionMode', 'planning')} options={['planning', 'fast']} onChange={(v) => props.onPref('executionMode', v)} />
          </Row>
          <Row title="Review policy" desc="request = stop at multi-file approval gates; proceed = apply and report after. (/review-policy)">
            <Select value={ps('reviewPolicy', 'request')} options={['request', 'proceed']} onChange={(v) => props.onPref('reviewPolicy', v)} />
          </Row>
          <Row title="YOLO" desc="Shortcut for execution mode fast + review policy proceed. (/yolo)">
            <Toggle on={ps('executionMode', 'planning') === 'fast' && ps('reviewPolicy', 'request') === 'proceed'}
              onChange={(v) => { props.onPref('executionMode', v ? 'fast' : 'planning'); props.onPref('reviewPolicy', v ? 'proceed' : 'request'); }} />
          </Row>
          <Row title="Delegation policy" desc="Whether/when the agent may spawn child agents. (/delegation-policy)">
            <Select value={ps('delegationPolicy', 'auto')} options={['auto', 'ask-before-spawn', 'ask-before-write-child', 'no-children']}
              onChange={(v) => props.onPref('delegationPolicy', v)} />
          </Row>
          <Row title="Auto-chain after workers" desc="Chain review / verify follow-ups after every worker finishes. (/auto-chain)">
            <Select value={ps('autoChain', 'off')} options={['off', 'review', 'verify', 'both']} onChange={(v) => props.onPref('autoChain', v)} />
          </Row>
          <Row title="Access mode (this session)" desc="read = look only · write = edit files · shell = run commands. (/permissions)">
            <Select value="—" options={['—', 'read', 'write', 'shell']} onChange={(v) => v !== '—' && props.onAction('a-access', 'action:set-access', { mode: v })} />
          </Row>
          <Row title="Sandbox" desc={<>Isolate <code>run_command</code> in a restricted sandbox (cli.sandbox). off = no isolation. Grants are managed via /sandbox in the CLI.</>}>
            <Select value={ks('sandbox', 'off')} options={['off', 'on']} onChange={(v) => setKnob('sandbox', v)} />
          </Row>
          <Row title="External-dir writes" desc="Writing files outside the workspace root (cli.externalDirWrites).">
            <Select value={ks('externalDirWrites', 'ask')} options={['ask', 'allow', 'deny']} onChange={(v) => setKnob('externalDirWrites', v)} />
          </Row>
          <div className="set-h2">Permission rules (cli.permissions)</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Glob rules evaluated at the unified execution-policy gate. Deny wins; allow downgrades ask. Shared with the CLI.</div>
          {(snapshot?.permissionRules?.deny ?? []).map((r) => (
            <div key={`d${r}`} className="rule-row"><span className="rule-kind deny">deny</span><span className="rule-text">{r}</span>
              <button className="tab-close-btn rule-x" aria-label={`Remove deny rule ${r}`} title="Remove rule" onClick={() => props.onAction('a-rule', 'action:rule-edit', { op: 'remove', kind: 'deny', rule: r })}>
                <Icon name="close" size={11} />
              </button></div>
          ))}
          {(snapshot?.permissionRules?.allow ?? []).map((r) => (
            <div key={`a${r}`} className="rule-row"><span className="rule-kind allow">allow</span><span className="rule-text">{r}</span>
              <button className="tab-close-btn rule-x" aria-label={`Remove allow rule ${r}`} title="Remove rule" onClick={() => props.onAction('a-rule', 'action:rule-edit', { op: 'remove', kind: 'allow', rule: r })}>
                <Icon name="close" size={11} />
              </button></div>
          ))}
          {!(snapshot?.permissionRules?.allow?.length || snapshot?.permissionRules?.deny?.length) ? <div className="empty">No rules configured.</div> : null}
          <div className="rule-add">
            <ChoiceControl value={ruleKind} options={[{ value: 'deny', label: 'deny' }, { value: 'allow', label: 'allow' }]} onChange={(v) => setRuleKind(v as 'allow' | 'deny')} />
            <input className="ctl" placeholder="glob rule, e.g. rm -rf *" value={ruleDraft} onChange={(e) => setRuleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ruleDraft.trim()) { props.onAction('a-rule', 'action:rule-edit', { op: 'add', kind: ruleKind, rule: ruleDraft.trim() }); setRuleDraft(''); } }} />
            <button className="btn" disabled={!ruleDraft.trim()} onClick={() => { props.onAction('a-rule', 'action:rule-edit', { op: 'add', kind: ruleKind, rule: ruleDraft.trim() }); setRuleDraft(''); }}>Add rule</button>
          </div>
        </>
      );
      case 'workflow-automation': {
        const auto = (knobs.automation ?? {}) as {
          enabled?: boolean;
          requirements?: { enabled?: boolean; autopilot?: boolean };
          sync?: { enabled?: boolean };
          sprints?: { enabled?: boolean; autopilot?: boolean };
        };
        const master = !!auto.enabled;
        const writeAuto = (next: typeof auto): void => setKnob('automation', next);
        const tierOf = (s?: { enabled?: boolean; autopilot?: boolean }): string =>
          !s?.enabled ? 'off' : s.autopilot ? 'autopilot' : 'propose';
        const TIERS = ['off', 'propose', 'autopilot'];
        return (
          <>
            <div className="set-h">Workflow automation</div>
            <div className="set-desc" style={{ marginBottom: 8 }}>
              Let agents drive the Requirement → Plan → Track → Sprint pipeline straight from the
              conversation. Every stage is <b>off by default</b> and runs only in your interactive
              session — never for background workers. (Distinct from the Track <i>Automation</i> tab,
              which is trigger → action rules.)
            </div>
            <Row title="Enable automation" desc="Master switch (cli.automation.enabled). Off → nothing fires, whatever the stages below say.">
              <Toggle on={master} onChange={(v) => writeAuto({ ...auto, enabled: v })} />
            </Row>
            <div style={{ opacity: master ? 1 : 0.45, pointerEvents: master ? 'auto' : 'none' }}>
              <div className="set-h2">Stages</div>
              <Row title="Detect requirements" desc="Capture requirements the agent spots in chat. Propose = save as draft + one-click promote; Autopilot = auto-create ready and run the cascade (cli.automation.requirements).">
                <Select value={tierOf(auto.requirements)} options={TIERS}
                  onChange={(v) => writeAuto({ ...auto, requirements: { ...auto.requirements, enabled: v !== 'off', autopilot: v === 'autopilot' } })} />
              </Row>
              <Row title="Sync plan → Track" desc="Turn a ready requirement's plan into Track items and advance them from code/PR links (cli.automation.sync).">
                <Toggle on={!!auto.sync?.enabled} onChange={(v) => writeAuto({ ...auto, sync: { ...auto.sync, enabled: v } })} />
              </Row>
              <Row title="Reconcile sprints" desc="Propose = suggest sprint create/complete (you make the commitment); Autopilot = auto-create/assign/complete — never auto-starts (cli.automation.sprints).">
                <Select value={tierOf(auto.sprints)} options={TIERS}
                  onChange={(v) => writeAuto({ ...auto, sprints: { ...auto.sprints, enabled: v !== 'off', autopilot: v === 'autopilot' } })} />
              </Row>
            </div>
            <Row title="Shared with the CLI" desc="Persists to cli.automation in config.json — the same knobs as `/config set automation…` in the terminal." />
          </>
        );
      }
      case 'extensions': {
        const ext = snapshot?.extensions;
        const trusted = ext?.trusted ?? false;
        const items = ext?.items ?? [];
        const setExtEnabled = (name: string, enabled: boolean): void => { props.onAction('a-ext', 'action:ext-set-enabled', { name, enabled }); setTimeout(refreshSnapshot, 120); };
        const setTrust = (v: boolean): void => { props.onAction('a-trust', 'action:trust-workspace', { trusted: v }); setTimeout(refreshSnapshot, 120); };
        return (
          <>
            <div className="set-h">Extensions</div>
            <div className="set-desc" style={{ marginBottom: 8 }}>
              Code-level extensions register agent tools, providers, and lifecycle hooks at runtime — no fork, no republish. They live at <code>~/.config/brainrouter/extensions/</code> (user) or <code>.brainrouter/extensions/</code> (workspace), each a folder with an <code>extension.json</code> + an entry module exporting <code>activate(host)</code>.
            </div>
            <Row title="Trust this workspace" desc="Workspace extensions run code from THIS repo — they only activate when the workspace is trusted. Built-in and user extensions are unaffected.">
              <Toggle on={trusted} onChange={setTrust} />
            </Row>
            <div className="set-h2">Discovered</div>
            {items.length === 0 ? (
              <Row title="No extensions found" desc="Add one under ~/.config/brainrouter/extensions/<name>/ or <workspace>/.brainrouter/extensions/<name>/." />
            ) : items.map((e) => (
              <Row key={e.name}
                title={`${e.name}  ·  v${e.version} · ${e.source}`}
                desc={<>{e.description || '—'}{e.contributes.length ? <> · contributes: {e.contributes.join(', ')}</> : null}{e.blocked ? <> · <span style={{ color: 'rgb(214,156,60)' }}>blocked — workspace not trusted</span></> : null}</>}>
                <Toggle on={e.enabled} onChange={(v) => setExtEnabled(e.name, v)} />
              </Row>
            ))}
          </>
        );
      }
      case 'memory': return (
        <>
          <div className="set-h">Memory</div>
          <Row title="Memory pipeline" desc="Run phase-1/phase-2 consolidation on session start. (/memories)">
            <Toggle on={pb('memoriesEnabled', true)} onChange={(v) => props.onPref('memoriesEnabled', v)} />
          </Row>
          <Row title="Recall mode" desc="When BrainRouter memory recall fires (cli.recallMode).">
            <Select value={ks('recallMode', 'gated')} options={['always', 'gated', 'off']} onChange={(v) => setKnob('recallMode', v)} />
          </Row>
          <Row title="Persona anchor" desc="Pin the brain's distilled Core Identity into the cache-stable briefing prefix every turn. (/persona on|off)">
            <Toggle on={pb('personaAnchorEnabled', true)} onChange={(v) => props.onPref('personaAnchorEnabled', v)} />
          </Row>
          <Row title="Quiet mode" desc="Hide recall tables, briefings and previews — model prose only. (/quiet)">
            <Toggle on={pb('quiet', false)} onChange={(v) => props.onPref('quiet', v)} />
          </Row>
          <Row title="Search, recall & brain ops" desc="/memory, /recall, /briefing, /blackboard, /brain, /forget, /export, /import run against the MCP brain — terminal CLI for now (DESK-5 command bridge)." />
        </>
      );
      case 'hooks': return (
        <>
          <div className="set-h">Hooks</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Lifecycle shell hooks from <code>.brainrouter/cli/hooks.json</code> — shared with the CLI. JSON stdout decisions (<code>{'{decision, reason}'}</code>) gate tool calls.</div>
          {(snapshot?.hooks ?? []).length === 0 ? <div className="empty">No hooks configured. Add them with /hooks add in the CLI.</div> : null}
          {(snapshot?.hooks ?? []).map((h) => (
            <Row key={h.id} title={`${h.event}${h.match ? ` · ${h.match}` : ''}`} desc={<code>{h.command}</code>}>
              <Toggle on={h.enabled} onChange={(v) => props.onAction('a-hook', 'action:set-hook', { id: h.id, enabled: v })} />
            </Row>
          ))}
        </>
      );
      case 'connectors': {
        // WS9 — group the flat pool into Brains (BrainRouter memory servers, only
        // one active at a time) and Tools (third-party MCP) so the single-active-
        // brain model reads at a glance. One row renderer, shared by both groups.
        const allServers = snapshot?.servers ?? [];
        const brains = allServers.filter((s) => s.identity === 'brainrouter');
        const tools = allServers.filter((s) => s.identity !== 'brainrouter');
        const renderServer = (s: NonNullable<ConfigSnapshot['servers']>[number]) => {
          const isBrain = s.identity === 'brainrouter';
          const isActiveBrain = isBrain && snapshot?.activeServer === s.id;
          const meta = [
            s.type ?? 'unknown',
            s.type === 'http' ? (s.url ?? '') : (s.command ?? ''),
            s.hasKey ? 'key set' : '',
            s.headerCount ? `${s.headerCount} headers` : '',
            s.envCount ? `${s.envCount} env` : '',
          ].filter(Boolean).join(' · ');
          return (
            <Row key={s.id} title={s.id} desc={<><span className={`dot ${s.online ? 'on' : 'off'}`} />{s.online ? 'online' : 'offline'}{isActiveBrain ? ' · active brain' : ''}{meta ? ` — ${meta}` : ''}</>}>
              {isBrain && !isActiveBrain ? <button className="btn" title="Make this the active BrainRouter brain (only one is active at a time)" onClick={() => { props.onAction('a-setactive', 'action:set-active-server', { id: s.id }); setTimeout(refreshSnapshot, 120); }}>Use as active</button> : null}
              <button className="btn" onClick={() => props.onAction('a-reconnect', 'action:reconnect-mcp', { id: s.id })}>Reconnect</button>
              <button className="btn" title="Remove this server" onClick={() => props.onAction('a-rmmcp', 'action:remove-mcp', { id: s.id })}>Remove</button>
            </Row>
          );
        };
        return (
        <>
          <div className="set-h">MCP</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>MCP servers from config.json — the same pool the CLI connects. All auto-reconnect in the background.</div>
          {allServers.length === 0 ? <div className="empty">No MCP servers configured (offline mode — local tools only).</div> : null}

          {allServers.length ? (
            <div className="mcp-group brains">
              <div className="set-h2" style={{ marginTop: 0 }}><Icon name="brain" size={13} /> Brains</div>
              <div className="set-desc" style={{ marginBottom: 8 }}>BrainRouter memory servers — the identity-bearing brain. Only ONE is active at a time; others stay configured and keep reconnecting.</div>
              {brains.length ? brains.map(renderServer) : <Row title="No brain configured" desc="Add a BrainRouter MCP server below to enable memory recall." />}
            </div>
          ) : null}

          {allServers.length ? (
            <div className="mcp-group tools">
              <div className="set-h2" style={{ marginTop: 0 }}><Icon name="bolt" size={13} /> Tools</div>
              <div className="set-desc" style={{ marginBottom: 8 }}>Third-party MCP tool servers (filesystem, web, etc.) — kept separate from the brain.</div>
              {tools.length ? tools.map(renderServer) : <Row title="No tool servers" desc="Add MCP tool servers below." />}
            </div>
          ) : null}

          <div className="set-h2">Add a server</div>
          <div className="mcp-add">
            <div className="mcp-add-row">
              <input className="ctl" placeholder="name (e.g. my-tools)" value={mcp.id} onChange={(e) => setMcp((m) => ({ ...m, id: e.target.value }))} />
              <ChoiceControl value={mcp.type} options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }]} onChange={(v) => setMcp((m) => ({ ...m, type: v as 'stdio' | 'http' }))} />
            </div>
            {mcp.type === 'stdio'
              ? <>
                  <input className="ctl" placeholder="command + args, e.g. npx -y @modelcontextprotocol/server-filesystem ." value={mcp.command} onChange={(e) => setMcp((m) => ({ ...m, command: e.target.value }))} />
                  <textarea className="ctl" rows={2} placeholder="environment (optional) — one KEY=value per line" value={mcp.env} onChange={(e) => setMcp((m) => ({ ...m, env: e.target.value }))} />
                </>
              : <>
                  <input className="ctl" placeholder="https://mcp.example.com/mcp (or /sse)" value={mcp.url} onChange={(e) => setMcp((m) => ({ ...m, url: e.target.value }))} />
                  <input className="ctl" type="password" placeholder="API key / Bearer token (optional)" value={mcp.apiKey} onChange={(e) => setMcp((m) => ({ ...m, apiKey: e.target.value }))} />
                  <textarea className="ctl" rows={2} placeholder="extra headers (optional) — one Header-Name=value per line" value={mcp.headers} onChange={(e) => setMcp((m) => ({ ...m, headers: e.target.value }))} />
                </>}
            <button className="btn primary" disabled={!mcp.id.trim() || !(mcp.type === 'stdio' ? mcp.command.trim() : mcp.url.trim())}
              onClick={() => {
                const parts = mcp.command.trim().split(/\s+/);
                props.onAction('a-addmcp', 'action:add-mcp', mcp.type === 'http'
                  ? { id: mcp.id.trim(), type: 'http', url: mcp.url.trim(), apiKey: mcp.apiKey.trim(), headers: mcp.headers.trim() }
                  : { id: mcp.id.trim(), type: 'stdio', command: parts[0] ?? '', args: parts.slice(1).join(' '), env: mcp.env.trim() });
                setMcp({ id: '', type: 'stdio', command: '', url: '', apiKey: '', headers: '', env: '' });
              }}>Add server</button>
          </div>
        </>
        );
      }
      case 'integrations': return (
        <>
          <div className="set-h">Integrations</div>
          <div className="set-desc" style={{ marginBottom: 10 }}>Connect external services. Secrets are stored locally in <code>config.json</code> — no <code>.env</code> needed.</div>
          <div className="set-h2"><Icon name="branch" size={13} /> GitHub — Track sync</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Two-way sync between this workspace's Track board and a GitHub repository's issues, and pull the repo's collaborators in as members. Used by the Track <b>Sync</b> and <b>Members</b> tabs.</div>
          <GithubIntegration gh={github} onSave={saveGithub} />
        </>
      );
      case 'advanced': {
        // §settings-completeness — the load-bearing cli.* knobs, individually
        // editable (per-knob writer). The knob helpers live at component scope.
        return (
          <>
            <div className="set-h">Advanced</div>
            <div className="set-desc" style={{ marginBottom: 6 }}>Everything else under <code>cli.*</code> in <code>~/.config/brainrouter/config.json</code> — shared with the CLI (<code>/config</code>). Leave a number blank to use its default.</div>

            <div className="set-h2">Model &amp; limits</div>
            <Row title="Max output tokens" desc="Cap on completion tokens per call (cli.maxOutputTokens). Blank = the provider default; raise it (e.g. 8192) if replies get cut off mid-sentence.">
              <KnobNumber value={knobs.maxOutputTokens} onSave={(v) => setKnob('maxOutputTokens', v)} placeholder="provider default" />
            </Row>
            <Row title="Auto-compact threshold" desc="Summarize + reset context above this many prompt tokens (cli.autoCompactTokens).">
              <KnobNumber value={knobs.autoCompactTokens} onSave={(v) => setKnob('autoCompactTokens', v)} placeholder="80000" />
            </Row>
            <Row title="Max tool loops" desc="Hard cap on tool iterations per turn (cli.maxToolLoops).">
              <KnobNumber value={knobs.maxToolLoops} onSave={(v) => setKnob('maxToolLoops', v)} placeholder="60" />
            </Row>
            <Row title="LLM timeout (ms)" desc="Per-request timeout before retry/reconnect (cli.llmTimeoutMs).">
              <KnobNumber value={knobs.llmTimeoutMs} onSave={(v) => setKnob('llmTimeoutMs', v)} placeholder="120000" />
            </Row>
            <Row title="Max concurrent LLM calls" desc="Parallel in-flight requests across the agent + children (cli.llmMaxConcurrent).">
              <KnobNumber value={knobs.llmMaxConcurrent} onSave={(v) => setKnob('llmMaxConcurrent', v)} placeholder="4" />
            </Row>
            <Row title="Context compaction" desc="Auto-summarize old history when the window fills (cli.contextCompaction).">
              <Toggle on={knobs.contextCompaction !== false} onChange={(v) => setKnob('contextCompaction', v)} />
            </Row>

            <div className="set-h2">Agents</div>
            <Row title="Next-action planner" desc="Plan the next step before acting (cli.nextActionPlanner).">
              <Toggle on={ks('nextActionPlanner', 'on') !== 'off'} onChange={(v) => setKnob('nextActionPlanner', v ? 'on' : 'off')} />
            </Row>
            <Row title="Max concurrent children" desc="Parallel sub-agents (cli.maxConcurrentChildren).">
              <KnobNumber value={knobs.maxConcurrentChildren} onSave={(v) => setKnob('maxConcurrentChildren', v)} placeholder="8" />
            </Row>
            <Row title="Max spawn depth" desc="How deep sub-agents may spawn sub-agents (cli.maxSpawnDepth).">
              <KnobNumber value={knobs.maxSpawnDepth} onSave={(v) => setKnob('maxSpawnDepth', v)} placeholder="3" />
            </Row>
            <Row title="Build loop" desc="Auto build/verify after edits (cli.buildLoop).">
              <Select value={ks('buildLoop', 'escalate')} options={['off', 'escalate', 'always']} onChange={(v) => setKnob('buildLoop', v)} />
            </Row>

            <div className="set-h2">Notifications</div>
            <Row title="Notify bell" desc="Ring the terminal bell on an idle background completion (cli.notifyBell).">
              <Toggle on={kb('notifyBell')} onChange={(v) => setKnob('notifyBell', v)} />
            </Row>
            <Row title="Update check" desc="Check for new BrainRouter versions on launch (cli.updateCheck).">
              <Toggle on={ks('updateCheck', 'true') !== 'false' && knobs.updateCheck !== false} onChange={(v) => setKnob('updateCheck', v)} />
            </Row>

            {/* WS11 — the raw knob editor is collapsed behind a Developer
                disclosure: most users never need it, and the JSON-valued knobs
                (permissions, automation) + internal safety knobs are handled by
                their own panels and hidden from this list. */}
            <details className="set-dev-raw">
              <summary className="set-h2" style={{ cursor: 'pointer' }}>Developer — raw <code>cli.*</code> config</summary>
              <div className="set-desc" style={{ marginBottom: 8 }}>Advanced: edit any remaining <code>cli</code> knob directly. Permissions, workflow automation, models and integrations have their own panels above and aren't shown here; internal safety knobs are hidden. Only change these if you know what they do.</div>
              <CliConfigEditor
                cli={(snapshot?.cli ?? {}) as Record<string, unknown>}
                onSave={(next) => { props.onAction('a-cli-json', 'action:set-cli-json', { json: JSON.stringify(next) }); setTimeout(refreshSnapshot, 80); }}
              />
            </details>
          </>
        );
      }
      case 'observability': return (
        <>
          <div className="set-h">Usage</div>
          <Row title="This session" desc={props.tokens ? `${props.tokens.turns} turns` : 'No turns yet.'}>
            <span className="dim">{props.tokens ? `${props.tokens.promptTokens.toLocaleString()} in · ${props.tokens.completionTokens.toLocaleString()} out` : '—'}</span>
          </Row>
          <div className="set-h2" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Across all sessions ({usageDays === 7 ? 'last week' : usageDays === 30 ? 'last 30 days' : 'last year'})</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {[{ label: 'Week', days: 7 }, { label: 'Month', days: 30 }, { label: 'Year', days: 365 }].map((r) => (
                <button
                  key={r.days}
                  className={`chip${usageDays === r.days ? '' : ' dim'}`}
                  aria-pressed={usageDays === r.days}
                  onClick={() => { setUsageDays(r.days); props.onAction('q-usage-hist', 'usage-history', { days: r.days }); }}
                >{r.label}</button>
              ))}
            </span>
          </div>
          {props.usageHistory ? (
            <>
              <Row
                title="Activity in range"
                desc={`${props.usageHistory.total.turns.toLocaleString()} turns · ${props.usageHistory.total.calls.toLocaleString()} requests · ${(props.usageHistory.total.promptTokens + props.usageHistory.total.completionTokens).toLocaleString()} tokens`}
              />
              <UsageHeatmap hist={props.usageHistory} />
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>Each square is a UTC day; brighter = more tokens. This tally is durable and survives session delete.</div>
            </>
          ) : (
            <pre className="usage-pre">Loading cross-session usage…</pre>
          )}
          <Row title="Workspace" desc={<code>{snapshot?.workspaceRoot ?? '—'}</code>} />
          <Row title="Local telemetry" desc="Privacy-conscious local-only task/latency log — no network (cli.telemetry.enabled).">
            <Toggle on={telemetryOn} onChange={(v) => setKnob('telemetry', { enabled: v })} />
          </Row>
          <Row title="Deep diagnostics" desc="/doctor, /debug-config, /watch and /trace remain CLI-side (they tail local logs)." />
        </>
      );
      case 'appearance': return (
        <>
          <div className="set-h">Appearance</div>
          <Row title="Accent color" desc="Interactive accent across the app — pick anything. Empty resets to the theme default.">
            <input type="color" className="ctl color-ctl" value={props.accent || '#7aa2f7'} onChange={(e) => props.onAccent(e.target.value)} />
            {props.accent ? <button className="btn" onClick={() => props.onAccent('')}>Reset</button> : null}
          </Row>
          <Row title="Desktop theme" desc="Graphite Mono = near-black neutral with an indigo accent (the desktop default). High-contrast = pure near-black.">
            <Select value={props.theme === 'hc' ? 'High-contrast dark' : 'Graphite Mono'} options={['Graphite Mono', 'High-contrast dark']}
              onChange={(v) => props.onTheme(v === 'High-contrast dark' ? 'hc' : 'dark')} />
          </Row>
          <Row title="Markdown theme (CLI)" desc="Syntax highlighting theme the terminal CLI uses for markdown output. (/theme)">
            <Select value={ps('theme', 'dark')} options={['auto', 'light', 'dark', 'mono']} onChange={(v) => props.onPref('theme', v)} />
          </Row>
          <Row title="Code font" desc="Monospace font for code, diffs and the terminal panel (desktop only).">
            <input className="ctl" value={props.codeFont} placeholder="e.g. JetBrains Mono" onChange={(e) => props.onCodeFont(e.target.value)} />
          </Row>
          <Row title="Transcript width" desc="Maximum width of the transcript and composer columns.">
            <div className="seg">
              {['narrow', 'medium', 'wide'].map((w) => (
                <button key={w} className={props.chatWidth === w ? 'active' : ''} onClick={() => props.onChatWidth(w)}>{w[0].toUpperCase() + w.slice(1)}</button>
              ))}
            </div>
          </Row>
          <Row title="Transcript text size" desc="Size of the conversation transcript text.">
            <div className="seg">
              {['small', 'medium', 'large'].map((z) => (
                <button key={z} className={props.chatSize === z ? 'active' : ''} onClick={() => props.onChatSize(z)}>{z[0].toUpperCase() + z.slice(1)}</button>
              ))}
            </div>
          </Row>
          <Row title="Raw scrollback (CLI)" desc="Skip markdown rendering in the terminal REPL for copy-friendly text. (/raw)">
            <Toggle on={pb('rawScrollback', false)} onChange={(v) => props.onPref('rawScrollback', v)} />
          </Row>
          <Row title="Vi composer (CLI)" desc="vi-mode keybindings for the terminal composer. (/vim)">
            <Toggle on={ps('editorMode', 'emacs') === 'vi'} onChange={(v) => props.onPref('editorMode', v ? 'vi' : 'emacs')} />
          </Row>
          <Row title="Experimental features" desc="Unlock gated experimental features across both heads. (/experimental)">
            <Toggle on={pb('experimental', false)} onChange={(v) => props.onPref('experimental', v)} />
          </Row>
        </>
      );
      case 'commands': return (
        <>
          <div className="set-h">Commands</div>
          <div className="set-desc" style={{ marginBottom: 4 }}>
            Every CLI slash command, live from the CLI's own catalog ({props.commands.length} commands).
          </div>
          <div className="legend-row">
            <span><span className="badge native">native</span> runs here</span>
            <span><span className="badge panel">panel</span> opens a column</span>
            <span><span className="badge settings">settings</span> deep-links</span>
            <span><span className="badge cli">cli</span> terminal-only until DESK-5</span>
          </div>
          {(props.catalog?.categories ?? []).map((cat) => {
            const rows = filteredCommands.filter((c) => c.category === cat.title);
            if (!rows.length) return null;
            return (
              <div key={cat.key} className="cmd-cat">
                <div className="set-h2">{cat.title}</div>
                {rows.map((c) => (
                  <div key={c.base + c.cmd} className="cmd-row">
                    <span className="cmd-name">{c.cmd}</span>
                    <span className="cmd-desc">{c.desc}</span>
                    <span className={`badge ${wireBadge(c.wire)}`}>{wireBadge(c.wire)}</span>
                    {c.wire.kind !== 'cli' ? <button className="cmd-run" onClick={() => props.onRunCommand(c)}>Run</button> : null}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      );
    }
  })();

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className={`settings-modal settings-wrap${zoomed ? ' zoomed' : ''}`}>
        <nav className="settings-nav">
          <input className="settings-search" placeholder="Search commands…" value={search}
            onChange={(e) => { setSearch(e.target.value); if (e.target.value.trim()) props.setSection('commands'); }} />
          {(['Settings', 'Desktop app'] as const).map((group) => (
            <React.Fragment key={group}>
              <div className="nav-head">{group}</div>
              {NAV.filter((n) => n.group === group).map((n) => (
                <button key={n.section} className={`nav-item${section === n.section ? ' active' : ''}`} onClick={() => props.setSection(n.section)}>
                  <span className="nav-icon"><Icon name={n.icon} size={14} /></span>{n.title}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="settings-content">{body}</div>
        <span className="settings-actions panel-chrome-actions">
          <button className={`icon-btn${zoomed ? ' active' : ''}`} title={zoomed ? 'Restore settings' : 'Enlarge settings'}
            aria-label={zoomed ? 'Restore settings' : 'Enlarge settings'} onClick={() => setZoomed((v) => !v)}>
            <Icon name="expand" size={13} />
          </button>
          <button className="icon-btn settings-close" title="Close settings" aria-label="Close settings" onClick={props.onClose}>
            <Icon name="close" size={13} />
          </button>
        </span>
      </div>
    </div>
  );
}
