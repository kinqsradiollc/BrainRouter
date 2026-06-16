/**
 * DESK-4c — the Settings modal, modeled on modern coding-agent desktop
 * settings: left category nav + search, right scrollable sections with
 * toggle/select/input rows. Every value is the SAME store the CLI reads —
 * preferences via `action:set-pref`, model via `set-model --persist`, hooks
 * via `action:set-hook`, MCP via the live pool. Change it here, the CLI
 * sees it on next launch (and vice versa).
 */
import React, { useMemo, useState } from 'react';
import { wireBadge, type CommandsCatalog, type DeskCommand, type SettingsSection } from './commands.js';
import { Icon } from './icons.js';

export interface ConfigSnapshot {
  model?: string;
  provider?: string;
  fallbackModel?: string | null;
  workspaceRoot?: string;
  sandbox?: 'on' | 'off';
  prefs?: Record<string, unknown>;
  permissionRules?: { allow: string[]; deny: string[] };
  hooks?: Array<{ id: string; event: string; command: string; enabled: boolean; match?: string }>;
  servers?: Array<{ id: string; online: boolean; detail?: string }>;
}

const NAV: Array<{ section: SettingsSection; icon: string; title: string; group: 'Settings' | 'Desktop app' }> = [
  { section: 'general', icon: 'gear', title: 'General', group: 'Settings' },
  { section: 'permissions', icon: 'shield', title: 'Permissions', group: 'Settings' },
  { section: 'memory', icon: 'brain', title: 'Memory', group: 'Settings' },
  { section: 'hooks', icon: 'link', title: 'Hooks', group: 'Settings' },
  { section: 'connectors', icon: 'bolt', title: 'Connectors', group: 'Settings' },
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

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }): React.ReactElement {
  return (
    <select className="ctl" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function SettingsDialog(props: {
  open: boolean;
  section: SettingsSection;
  setSection: (s: SettingsSection) => void;
  onClose: () => void;
  snapshot: ConfigSnapshot | null;
  usageLines: string[];
  tokens: { promptTokens: number; completionTokens: number; turns: number } | null;
  commands: DeskCommand[];
  catalog: CommandsCatalog | null;
  onPref: (key: string, value: unknown) => void;
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
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [llmDraft, setLlmDraft] = useState<{ provider?: string; endpoint?: string; apiKey?: string }>({});
  const [search, setSearch] = useState('');
  // T7 — permission-rule editor draft; T6 — MCP add-server draft.
  const [ruleKind, setRuleKind] = useState<'allow' | 'deny'>('deny');
  const [ruleDraft, setRuleDraft] = useState('');
  const [mcp, setMcp] = useState<{ id: string; type: 'stdio' | 'http'; command: string; url: string }>({ id: '', type: 'stdio', command: '', url: '' });
  const prefs = (snapshot?.prefs ?? {}) as Record<string, unknown>;
  const ps = (key: string, dflt: string): string => String(prefs[key] ?? dflt);
  const pb = (key: string, dflt: boolean): boolean => Boolean(prefs[key] ?? dflt);
  const tier = (prefs.tier as string | null | undefined) ?? 'follow model';

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.commands;
    return props.commands.filter((c) => `${c.base} ${c.desc} ${c.category}`.toLowerCase().includes(q));
  }, [props.commands, search]);

  if (!props.open) return null;

  const body = (() => {
    switch (section) {
      case 'general': return (
        <>
          <div className="set-h">General</div>
          <Row title="Model" desc={<>Saved to <code>~/.config/brainrouter/config.json</code> — shared with the CLI. Current provider: <code>{snapshot?.provider ?? '—'}</code></>}>
            <input className="ctl" value={modelDraft ?? snapshot?.model ?? ''} onChange={(e) => setModelDraft(e.target.value)} placeholder="e.g. claude-opus-4-8" />
            <button className="btn primary" disabled={!(modelDraft ?? '').trim() || modelDraft === snapshot?.model}
              onClick={() => { props.onModelSave((modelDraft ?? '').trim()); setModelDraft(null); }}>Save</button>
          </Row>
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
          <Row title="Sandbox" desc={<>run_command isolation is <code>{snapshot?.sandbox ?? 'off'}</code> (cli.sandbox in config.json). Grants managed via /sandbox in the CLI.</>} />
          <div className="set-h2">Permission rules (cli.permissions)</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Glob rules evaluated at the unified execution-policy gate. Deny wins; allow downgrades ask. Shared with the CLI.</div>
          {(snapshot?.permissionRules?.deny ?? []).map((r) => (
            <div key={`d${r}`} className="rule-row"><span className="rule-kind deny">deny</span><span className="rule-text">{r}</span>
              <button className="rule-x" title="Remove rule" onClick={() => props.onAction('a-rule', 'action:rule-edit', { op: 'remove', kind: 'deny', rule: r })}>✕</button></div>
          ))}
          {(snapshot?.permissionRules?.allow ?? []).map((r) => (
            <div key={`a${r}`} className="rule-row"><span className="rule-kind allow">allow</span><span className="rule-text">{r}</span>
              <button className="rule-x" title="Remove rule" onClick={() => props.onAction('a-rule', 'action:rule-edit', { op: 'remove', kind: 'allow', rule: r })}>✕</button></div>
          ))}
          {!(snapshot?.permissionRules?.allow?.length || snapshot?.permissionRules?.deny?.length) ? <div className="empty">No rules configured.</div> : null}
          <div className="rule-add">
            <select className="ctl" value={ruleKind} onChange={(e) => setRuleKind(e.target.value as 'allow' | 'deny')}>
              <option value="deny">deny</option><option value="allow">allow</option>
            </select>
            <input className="ctl" placeholder="glob rule, e.g. rm -rf *" value={ruleDraft} onChange={(e) => setRuleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ruleDraft.trim()) { props.onAction('a-rule', 'action:rule-edit', { op: 'add', kind: ruleKind, rule: ruleDraft.trim() }); setRuleDraft(''); } }} />
            <button className="btn" disabled={!ruleDraft.trim()} onClick={() => { props.onAction('a-rule', 'action:rule-edit', { op: 'add', kind: ruleKind, rule: ruleDraft.trim() }); setRuleDraft(''); }}>Add rule</button>
          </div>
        </>
      );
      case 'memory': return (
        <>
          <div className="set-h">Memory</div>
          <Row title="Memory pipeline" desc="Run phase-1/phase-2 consolidation on session start. (/memories)">
            <Toggle on={pb('memoriesEnabled', true)} onChange={(v) => props.onPref('memoriesEnabled', v)} />
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
      case 'connectors': return (
        <>
          <div className="set-h">Provider</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>The LLM endpoint both heads use — OpenAI-compatible wire format. Saved to <code>~/.config/brainrouter/config.json</code>; your key is write-only here and never echoed back.</div>
          <Row title="Provider id" desc="Catalog label for tier-ladder lookups (openai, lmstudio, ollama, deepseek, …).">
            <input className="ctl" value={llmDraft.provider ?? snapshot?.provider ?? ''} placeholder="openai"
              onChange={(e) => setLlmDraft((d) => ({ ...d, provider: e.target.value }))} />
          </Row>
          <Row title="Endpoint" desc="OpenAI-compatible base URL. Empty = the provider's default.">
            <input className="ctl" value={llmDraft.endpoint ?? ''} placeholder="https://api.openai.com/v1"
              onChange={(e) => setLlmDraft((d) => ({ ...d, endpoint: e.target.value }))} />
          </Row>
          <Row title="API key" desc="Stored in config.json. Leave blank to keep the current key.">
            <input className="ctl" type="password" value={llmDraft.apiKey ?? ''} placeholder="•••••••• (unchanged)"
              onChange={(e) => setLlmDraft((d) => ({ ...d, apiKey: e.target.value }))} />
          </Row>
          <Row title="">
            <button className="btn primary" disabled={!Object.values(llmDraft).some((v) => (v ?? '').trim())}
              onClick={() => { props.onAction('a-llm', 'action:set-llm', llmDraft as Record<string, unknown>); setLlmDraft({}); }}>Save provider</button>
          </Row>
          <div className="set-h2">Connectors (MCP)</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Server profiles from config.json — the same pool the CLI connects. Sign in once, both heads use it.</div>
          {(snapshot?.servers ?? []).length === 0 ? <div className="empty">No MCP servers configured (offline mode — local tools only).</div> : null}
          {(snapshot?.servers ?? []).map((s) => (
            <Row key={s.id} title={s.id} desc={<><span className={`dot ${s.online ? 'on' : 'off'}`} />{s.online ? 'online' : 'offline'}{s.detail ? ` — ${s.detail}` : ''}</>}>
              <button className="btn" onClick={() => props.onAction('a-reconnect', 'action:reconnect-mcp', { id: s.id })}>Reconnect</button>
              <button className="btn" title="Remove this server" onClick={() => props.onAction('a-rmmcp', 'action:remove-mcp', { id: s.id })}>Remove</button>
            </Row>
          ))}
          <div className="mcp-add">
            <div className="mcp-add-row">
              <input className="ctl" placeholder="server id" value={mcp.id} onChange={(e) => setMcp((m) => ({ ...m, id: e.target.value }))} />
              <select className="ctl" value={mcp.type} onChange={(e) => setMcp((m) => ({ ...m, type: e.target.value as 'stdio' | 'http' }))}>
                <option value="stdio">stdio</option><option value="http">http</option>
              </select>
            </div>
            {mcp.type === 'stdio'
              ? <input className="ctl" placeholder="command + args, e.g. npx -y @modelcontextprotocol/server-filesystem ." value={mcp.command} onChange={(e) => setMcp((m) => ({ ...m, command: e.target.value }))} />
              : <input className="ctl" placeholder="https://mcp.example.com/sse" value={mcp.url} onChange={(e) => setMcp((m) => ({ ...m, url: e.target.value }))} />}
            <button className="btn primary" disabled={!mcp.id.trim() || !(mcp.type === 'stdio' ? mcp.command.trim() : mcp.url.trim())}
              onClick={() => {
                const parts = mcp.command.trim().split(/\s+/);
                props.onAction('a-addmcp', 'action:add-mcp', mcp.type === 'http'
                  ? { id: mcp.id.trim(), type: 'http', url: mcp.url.trim() }
                  : { id: mcp.id.trim(), type: 'stdio', command: parts[0] ?? '', args: parts.slice(1).join(' ') });
                setMcp({ id: '', type: 'stdio', command: '', url: '' });
              }}>Add server</button>
          </div>
        </>
      );
      case 'observability': return (
        <>
          <div className="set-h">Usage</div>
          <Row title="This session" desc={props.tokens ? `${props.tokens.turns} turns` : 'No turns yet.'}>
            <span className="dim">{props.tokens ? `${props.tokens.promptTokens.toLocaleString()} in · ${props.tokens.completionTokens.toLocaleString()} out` : '—'}</span>
          </Row>
          <div className="set-h2">Per-actor breakdown (/usage)</div>
          <pre className="usage-pre">{props.usageLines.length ? props.usageLines.join('\n') : 'Run a turn first — the breakdown shows parent vs child spend, cache hit rate, and offload savings.'}</pre>
          <Row title="Workspace" desc={<code>{snapshot?.workspaceRoot ?? '—'}</code>} />
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
          <Row title="Desktop theme" desc="Claude Dark = warm charcoal (the desktop default). High-contrast = near-black.">
            <Select value={props.theme === 'hc' ? 'High-contrast dark' : 'Claude Dark'} options={['Claude Dark', 'High-contrast dark']}
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
      <div className="settings-modal settings-wrap">
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
        <button className="icon-btn settings-close" onClick={props.onClose}><Icon name="close" size={13} /></button>
      </div>
    </div>
  );
}
