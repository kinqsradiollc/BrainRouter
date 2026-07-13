/**
 * DESK-4c — the Settings modal: left category nav + search, right scrollable
 * sections with toggle/select/input rows. Values reuse the CLI stores (global
 * prefs via `action:set-pref`; mode/review/effort session-scoped).
 *
 * This module is the composed shell/barrel: modal chrome + the section switch.
 * Section controls, the shared row/knob primitives, and the large
 * Models/Connectors panels live in cohesive siblings under `./settings/`,
 * re-exported here so the public surface is unchanged.
 */
import React, { useMemo, useState } from 'react';
import { wireBadge, type CommandsCatalog, type DeskCommand, type SettingsSection } from './lib/commands/commands.js';
import { Icon } from './icons.js';
import { ShortcutsReference } from './components/dialogs/ShortcutsReference.js';
import { Row, Toggle, Select, ChoiceControl, KnobText, KnobNumber, SetGroup } from './settings/shared/controls.js';
import { PermissionModeCards } from './settings/permissions/PermissionModeCards.js';
import { ComputerUseSettings } from './settings/permissions/ComputerUseSettings.js';
import { CliConfigEditor } from './settings/cli/CliConfigEditor.js';
import { SchemaCliFields } from './settings/cli/SchemaCliFields.js';
import { ConnectorSettings } from './settings/connectors/ConnectorSettings.js';
import { MarketplaceSettings, type MarketplaceState } from './settings/marketplace/index.js';
import { McpServersSection } from './settings/connectors/McpServersSection.js';
import { ModelsSection } from './settings/models/ModelsSection.js';
import { AccountSettings } from './settings/account/AccountSettings.js';
import { ReviewsSettings } from './settings/reviews/ReviewsSettings.js';
import { RuntimeSection } from './settings/runtime/RuntimeSection.js';
import { AutomationsSection } from './settings/automations/AutomationsSection.js';
import { UsageHeatmap } from './settings/usage/UsageHeatmap.js';
import { NAV, type ConfigSnapshot, type GithubSaveArgs, type UsageHistory } from './settings/shared/types.js';

// §public-surface — types consumed by App.tsx and the agent/composer hooks are
// re-exported so importers keep resolving them from `./settings.js` unchanged.
export type {
  ConfigSnapshot,
  GithubRepoSnapshot,
  GithubIntegrationSnapshot,
  UsageHistory,
} from './settings/shared/types.js';

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
  /** Tool enable/disable catalog (built-in + connected MCP) for the Tools section. */
  toolCatalog: { builtin: Array<{ name: string; description: string; protected: boolean }>; mcp: Array<{ server: string; name: string }> };
  /** §multi-select-models — live result of probing a DRAFT provider key in the
   *  setup dialog (the models that key unlocks), with loading + error state.
   *  probeError: '' = none, 'no-models' = the key/endpoint returned nothing. */
  probedModels: string[];
  probeLoading: boolean;
  probeError: string;
  onProbe: (args: { endpoint: string; apiKey: string; provider: string; apiVersion: string }) => void;
  onProbeReset: () => void;
  onModelSave: (model: string) => void;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  /** PLUGIN-MARKETPLACE P4-desktop — the Marketplace panel's data slice. */
  market: MarketplaceState;
  onRunCommand: (c: DeskCommand) => void;
  /** The active session's execution mode — drives the Fast-mode toggle. */
  execMode?: string;
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
  // T7 — permission-rule editor draft.
  const [ruleKind, setRuleKind] = useState<'allow' | 'deny'>('deny');
  const [ruleDraft, setRuleDraft] = useState('');
  // WS10 — usage heatmap range selector (week / month / year). Re-fetches usage-history.
  const [usageDays, setUsageDays] = useState(365);
  const refreshSnapshot = (): void => props.onAction('q-snapshot', 'config-snapshot');
  const prefs = (snapshot?.prefs ?? {}) as Record<string, unknown>;
  const ps = (key: string, dflt: string): string => String(prefs[key] ?? dflt);
  const pb = (key: string, dflt: boolean): boolean => Boolean(prefs[key] ?? dflt);
  const tier = (prefs.tier as string | null | undefined) ?? 'follow model';
  // §settings — cli.* knob helpers (per-knob writer), lifted to component scope
  // so a knob-backed control can live in its natural category, not only under
  // Advanced. Shared with the CLI; empty/clear reverts to the default.
  const knobs = (snapshot?.cliKnobs ?? {}) as Record<string, unknown>;
  const setKnob = (key: string, value: unknown): void => { props.onAction('a-knob', 'action:set-cli-knob', { key, value }); setTimeout(refreshSnapshot, 80); };
  const setSchemaKnob = (path: string, value: unknown): void => { props.onAction('a-schema-knob', 'action:set-cli-schema-knob', { path, value }); setTimeout(refreshSnapshot, 80); };
  // MC-DESK — sibling-safe nested cli.* writer (action:set-cli-path). Sets ONE
  // dotted leaf without replacing the parent object, so structured panels can
  // edit `runtime.serve` / `triggers.enabled` without clobbering neighbours or
  // write-only secrets. Pass null to revert a leaf to its default.
  const setPath = (path: string, value: unknown): void => { props.onAction('a-cfgpath', 'action:set-cli-path', { path, value }); setTimeout(refreshSnapshot, 80); };
  const ks = (key: string, dflt: string): string => String(knobs[key] ?? dflt);
  const telemetryOn = (knobs.telemetry as { enabled?: boolean } | undefined)?.enabled !== false;
  const github = snapshot?.integrations?.github ?? { repo: null, hasToken: false, tokenSource: null, repos: [], caBundle: null };
  const githubCli = (snapshot?.cli?.github && typeof snapshot.cli.github === 'object' ? snapshot.cli.github : {}) as { oauthClientId?: string };
  const githubOauthClientId = typeof githubCli.oauthClientId === 'string' ? githubCli.oauthClientId : '';
  const saveGithub = (args: GithubSaveArgs): void => { props.onAction('a-gh', 'action:set-track-github', args); setTimeout(refreshSnapshot, 100); };
  const saveGithubOauthClientId = (clientId: string | null): void => { props.onAction('a-gh-oauth-client', 'action:set-github-oauth-client-id', { clientId: clientId ?? '' }); setTimeout(refreshSnapshot, 100); };

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.commands;
    return props.commands.filter((c) => `${c.base} ${c.desc} ${c.category}`.toLowerCase().includes(q));
  }, [props.commands, search]);

  if (!props.open) return null;

  const body = (() => {
    switch (section) {
      case 'account': return <AccountSettings />;
      case 'general': return (
        <>
          <div className="set-h">General</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Model &amp; providers moved to their own <b>Models</b> section.</div>
          <SetGroup title="Agent behavior">
            <Row title="Reasoning effort" desc="low = terse, medium = default, high = step-by-step, xhigh = maximum. max / ultracode are top slider tiers (they cap to maximum on the wire). Forwarded to provider reasoning slots when the model supports it. (/effort)">
              <Select value={ps('effort', 'medium')} options={['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']} onChange={(v) => props.onPref('effort', v)} />
            </Row>
            <Row title="Personality" desc="Communication style for the agent's prose. (/personality)">
              <Select value={ps('personality', 'standard')} options={['concise', 'standard', 'detailed', 'pair-programmer']} onChange={(v) => props.onPref('personality', v)} />
            </Row>
            <Row title="Model tier pin" desc="Pin the tier ladder: flash | standard | pro. “follow model” lets <<<NEEDS_HIGH>>> self-escalation work. (/tier)">
              <Select value={tier} options={['follow model', 'flash', 'standard', 'pro']}
                onChange={(v) => props.onPref('tier', v === 'follow model' ? null : v)} />
            </Row>
          </SetGroup>
          <SetGroup title="Session">
            <Row title="Fast mode" desc="Answer directly with minimal planning for quick, low-friction turns. Independent of reasoning effort (set that above) — Fast mode changes the agent's strategy, not how hard the model thinks. (/fast)">
              <Toggle on={props.execMode === 'fast'} onChange={(v) => props.onAction('a-mode', 'action:set-session-mode', { executionMode: v ? 'fast' : 'planning' })} />
            </Row>
            <Row title="New chat" desc="Fresh session key; current transcript stays on disk. (/new)">
              <button className="btn" onClick={() => props.onAction('a-new', 'new-session')}>New chat</button>
            </Row>
            <Row title="Compact this session" desc="LLM-driven compaction of the active history — same as /compact in the CLI.">
              <button className="btn" onClick={() => props.onAction('a-compact', 'action:compact')}>Compact</button>
            </Row>
            <Row title="Clear history" desc="Drops the in-memory history for this session. (/clear)">
              <button className="btn danger" onClick={() => props.onAction('a-clear', 'action:clear')}>Clear</button>
            </Row>
          </SetGroup>
          <SetGroup title="Troubleshooting &amp; provenance">
            <Row title="Safe mode" desc="Boot WITHOUT memory briefing, skills, lifecycle hooks and custom MCP servers — a minimal harness to isolate a misbehaving briefing/skill/hook/MCP. Takes effect on the next launch. (cli.safeMode)">
              <Toggle on={knobs.safeMode === true} onChange={(v) => setPath('safeMode', v)} />
            </Row>
            <Row title="Session footer in commits/PRs" desc="Include the BrainRouter provenance/session footer in generated commit and PR bodies. Turn off for private repos / clean history. (cli.attribution.sessionUrl)">
              <Toggle on={((knobs.attribution ?? {}) as { sessionUrl?: boolean }).sessionUrl !== false} onChange={(v) => setPath('attribution.sessionUrl', v)} />
            </Row>
          </SetGroup>
        </>
      );
      case 'models': return (
        <>
          <ModelsSection
            snapshot={snapshot}
            knobs={knobs}
            setKnob={setKnob}
            setPath={setPath}
            refreshSnapshot={refreshSnapshot}
            api={{
              open: props.open,
              section,
              onAction: props.onAction,
              endpointModels: props.endpointModels,
              providerModels: props.providerModels,
              probedModels: props.probedModels,
              probeLoading: props.probeLoading,
              probeError: props.probeError,
              onProbe: props.onProbe,
              onProbeReset: props.onProbeReset,
            }}
          />
        </>
      );
      case 'permissions': return (
        <>
          <div className="set-h">Permissions</div>
          <div className="set-desc" style={{ marginBottom: 8 }}>Pick a mode — it sets the access tier, approval, sandbox, and out-of-workspace policy below in one click. Any stored combination maps back to the nearest card.</div>
          <PermissionModeCards ps={ps} ks={ks} onPref={props.onPref} onAction={props.onAction} setKnob={setKnob} />
          <SetGroup title="Session policy">
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
          </SetGroup>
          <SetGroup title="Delegation & chaining">
            <Row title="Delegation policy" desc="Whether/when the agent may spawn child agents. (/delegation-policy)">
              <Select value={ps('delegationPolicy', 'auto')} options={['auto', 'ask-before-spawn', 'ask-before-write-child', 'no-children']}
                onChange={(v) => props.onPref('delegationPolicy', v)} />
            </Row>
            <Row title="Auto-chain after workers" desc="Chain review / verify follow-ups after every worker finishes. (/auto-chain)">
              <Select value={ps('autoChain', 'off')} options={['off', 'review', 'verify', 'both']} onChange={(v) => props.onPref('autoChain', v)} />
            </Row>
          </SetGroup>
          <SetGroup title="Filesystem & sandbox">
            <Row title="Access mode (this session)" desc="read = look only · write = edit files · shell = run commands. (/permissions)">
              <Select value="—" options={['—', 'read', 'write', 'shell']} onChange={(v) => v !== '—' && props.onAction('a-access', 'action:set-access', { mode: v })} />
            </Row>
            <Row title="Sandbox" desc={<>Isolate <code>run_command</code> in a restricted sandbox (cli.sandbox). off = no isolation. Grants are managed via /sandbox in the CLI.</>}>
              <Select value={ks('sandbox', 'off')} options={['off', 'on']} onChange={(v) => setKnob('sandbox', v)} />
            </Row>
            <Row title="External-dir writes" desc="Writing files outside the workspace root (cli.externalDirWrites).">
              <Select value={ks('externalDirWrites', 'ask')} options={['ask', 'allow', 'deny']} onChange={(v) => setKnob('externalDirWrites', v)} />
            </Row>
          </SetGroup>
          <ComputerUseSettings knobs={knobs} refreshSnapshot={refreshSnapshot} />
          <SetGroup title="Permission rules (cli.permissions)">
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
          </SetGroup>
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
            <div className="set-h">Auto-planning</div>
            <div className="set-desc" style={{ marginBottom: 8 }}>
              Let agents drive the Requirement → Plan → Track → Sprint pipeline straight from the
              conversation. Every stage is <b>off by default</b> and runs only in your interactive
              session — never for background workers. (This is agent-driven planning inside your
              chat — not the <b>Automations</b> category, which is inbound webhooks → jobs.)
            </div>
            <SetGroup title="Automation">
              <Row title="Enable automation" desc="Master switch (cli.automation.enabled). Off → nothing fires, whatever the stages below say.">
                <Toggle on={master} onChange={(v) => writeAuto({ ...auto, enabled: v })} />
              </Row>
              <Row title="Shared with the CLI" desc="Persists to cli.automation in config.json — the same knobs as `/config set automation…` in the terminal." />
            </SetGroup>
            <div className={`set-group${master ? '' : ' dim'}`}>
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
          </>
        );
      }
      case 'runtime': return (
        <RuntimeSection
          knobs={knobs}
          setPath={setPath}
          runtimes={snapshot?.runtimes ?? []}
          archives={snapshot?.runtimeArchives ?? []}
          previews={snapshot?.runtimePreviewsLive ?? []}
          onAction={props.onAction}
          refreshSnapshot={refreshSnapshot}
        />
      );
      case 'automations': return (
        <AutomationsSection
          knobs={knobs}
          setPath={setPath}
          secretsSet={snapshot?.triggerSecretsSet ?? { github: false, slack: false, gitlab: false, jira: false }}
          rules={snapshot?.automationRules ?? []}
          serve={snapshot?.triggerServe}
          onAction={props.onAction}
          refreshSnapshot={refreshSnapshot}
        />
      );
      case 'reviews': return (
        <>
          <ReviewsSettings />
          <SetGroup title="What runs on every reviewed PR">
            <Row title="🛡️ Security review" desc="Vulnerability findings (injection, secrets, auth, SSRF, …), CWE-tagged." />
            <Row title="🔎 Code review" desc="Correctness, clarity, architecture, performance, and test coverage." />
            <Row title="Block on blocking findings" desc="A critical/high finding fails the check-run so branch protection can hold the merge." />
            <Row title="Re-review on every push" desc="Each new commit re-runs both lenses on the new diff." />
          </SetGroup>
          <SetGroup title="Manage">
            <Row title="Choose which repos are reviewed" desc="Open the BrainRouter dashboard → Reviews to toggle auto-review per repository and browse recent reviews + findings." />
            <Row title="Connect / configure the GitHub App" desc="Settings → Automations wires the same GitHub App (installation, webhook) this reviewer runs on." />
          </SetGroup>
        </>
      );
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
            <SetGroup title="Workspace trust">
              <Row title="Trust this workspace" desc="Workspace extensions run code from THIS repo — they only activate when the workspace is trusted. Built-in and user extensions are unaffected.">
                <Toggle on={trusted} onChange={setTrust} />
              </Row>
            </SetGroup>
            <SetGroup title="Discovered extensions">
              {items.length === 0 ? (
                <Row title="No extensions found" desc="Add one under ~/.config/brainrouter/extensions/<name>/ or <workspace>/.brainrouter/extensions/<name>/." />
              ) : items.map((e) => (
                <Row key={e.name}
                  title={`${e.name}  ·  v${e.version} · ${e.source}`}
                  desc={<>{e.description || '—'}{e.contributes.length ? <> · contributes: {e.contributes.join(', ')}</> : null}{e.blocked ? <> · <span style={{ color: 'rgb(214,156,60)' }}>blocked — workspace not trusted</span></> : null}</>}>
                  <Toggle on={e.enabled} onChange={(v) => setExtEnabled(e.name, v)} />
                </Row>
              ))}
            </SetGroup>
            <SetGroup title="Skills">
              <Row title="Keyword-triggered skills" desc="When a SKILL.md declares triggers:/keywords: in its frontmatter, a plain prompt containing one of those words injects that skill — like an explicit /skill. Additive; nothing fires unless a skill opts in. (cli.skillsKeywordTriggers)">
                <Toggle on={knobs.skillsKeywordTriggers !== false} onChange={(v) => setPath('skillsKeywordTriggers', v)} />
              </Row>
              <Row title="Max stacked /skill tokens" desc="How many leading /skill tokens one prompt may compose. Hard-capped at 5 in the resolver. Default 5. (cli.skillsStackMax)">
                <KnobNumber value={knobs.skillsStackMax} placeholder="5" onSave={(v) => setPath('skillsStackMax', v)} />
              </Row>
              <Row title="Hide bundled skills" desc="Hide skills shipped with the install, leaving only workspace-authored ones (skills/, .brainrouter/skills). (cli.skillsHideBundled)">
                <Toggle on={knobs.skillsHideBundled === true} onChange={(v) => setPath('skillsHideBundled', v)} />
              </Row>
              <Row title="Org convention-repo discovery" desc="Discover read-only `.brainrouter` convention repos for your signed-in GitHub user + orgs, and load their skills/agents. (cli.skills.orgRepoDiscovery)">
                <Toggle on={((knobs.skills ?? {}) as { orgRepoDiscovery?: boolean }).orgRepoDiscovery === true} onChange={(v) => setPath('skills.orgRepoDiscovery', v)} />
              </Row>
            </SetGroup>
          </>
        );
      }
      case 'memory': return (
        <>
          <div className="set-h">Memory</div>
          <SetGroup title="Memory &amp; recall">
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
          </SetGroup>
        </>
      );
      case 'hooks': return (
        <>
          <div className="set-h">Hooks</div>
          <div className="set-desc" style={{ marginBottom: 6 }}>Lifecycle shell hooks from <code>.brainrouter/cli/hooks.json</code> — shared with the CLI. JSON stdout decisions (<code>{'{decision, reason}'}</code>) gate tool calls.</div>
          <SetGroup title="Lifecycle hooks">
            {(snapshot?.hooks ?? []).length === 0 ? <div className="empty">No hooks configured. Add them with /hooks add in the CLI.</div> : null}
            {(snapshot?.hooks ?? []).map((h) => (
              <Row key={h.id} title={`${h.event}${h.match ? ` · ${h.match}` : ''}`} desc={<code>{h.command}</code>}>
                <Toggle on={h.enabled} onChange={(v) => props.onAction('a-hook', 'action:set-hook', { id: h.id, enabled: v })} />
              </Row>
            ))}
          </SetGroup>
        </>
      );
      case 'tools': {
        // Per-tool enable/disable (cli.toolOverrides). 'default' leaves it to the
        // agent's normal logic (incl. the local-model allowlist); 'on' force-enables
        // (the re-enable case); 'off' disables. Protected core tools can't be off.
        const overrides = (knobs.toolOverrides ?? {}) as Record<string, boolean>;
        const stateOf = (name: string): string => overrides[name] === true ? 'on' : overrides[name] === false ? 'off' : 'default';
        const setOverride = (name: string, v: string): void => {
          const next = { ...overrides };
          if (v === 'on') next[name] = true;
          else if (v === 'off') next[name] = false;
          else delete next[name];
          setKnob('toolOverrides', next);
        };
        const cat = props.toolCatalog;
        return (
          <>
            <div className="set-h">Tools</div>
            <div className="set-desc" style={{ marginBottom: 10 }}>
              Enable or disable individual agent tools. Local models hide some by default — set those to <b>On</b> to force-enable them. Core tools (read / edit / run + plan / goal) are always on.
            </div>
            <SetGroup title="Built-in tools">
              {cat.builtin.length === 0
                ? <Row title="Loading…" desc="" />
                : cat.builtin.map((t) => (
                    <Row key={t.name} title={t.name} desc={t.protected ? `${t.description}${t.description ? ' · ' : ''}core — always on` : t.description}>
                      <Select value={stateOf(t.name)} options={t.protected ? ['default', 'on'] : ['default', 'on', 'off']} onChange={(v) => setOverride(t.name, v)} />
                    </Row>
                  ))}
            </SetGroup>
            <SetGroup title="MCP tools" collapsible defaultOpen={cat.mcp.length > 0}>
              {cat.mcp.length === 0
                ? <Row title="No MCP tools" desc="Connect MCP servers under “MCP Servers” to see their tools here." />
                : cat.mcp.map((t) => (
                    <Row key={t.name} title={t.name.replace(/^mcp_/, '')} desc={`from ${t.server}`}>
                      <Select value={stateOf(t.name)} options={['default', 'on', 'off']} onChange={(v) => setOverride(t.name, v)} />
                    </Row>
                  ))}
            </SetGroup>
          </>
        );
      }
      case 'connectors': return (
        <McpServersSection snapshot={snapshot} onAction={props.onAction} refreshSnapshot={refreshSnapshot} />
      );
      case 'data-connectors': return (
        <ConnectorSettings
          connectors={snapshot?.connectors ?? { catalog: [], items: [] }}
          githubIntegration={github}
          githubOauthClientId={githubOauthClientId}
          onGithubSave={saveGithub}
          onAction={props.onAction}
          refreshSnapshot={refreshSnapshot}
        />
      );
      case 'marketplace': {
        const plugins = (knobs.plugins ?? {}) as { orgScope?: boolean; autoUpdateCheck?: boolean; altManifestNames?: string[]; publishRepo?: string; registryUrl?: string };
        return (
          <>
            <MarketplaceSettings
              market={props.market}
              onAction={props.onAction}
              refreshInstalled={() => props.onAction('q-plugin-list', 'plugin-list')}
              refreshSearch={(a) => props.onAction('q-plugin-search', 'plugin-search', a)}
            />
            <SetGroup title="Scope &amp; sources">
              <Row title="Org convention scope" desc="Surface your org's read-only `.brainrouter` convention repos as an extra plugin/skill scope. (cli.plugins.orgScope)">
                <Toggle on={plugins.orgScope === true} onChange={(v) => setPath('plugins.orgScope', v)} />
              </Row>
              <Row title="Check for plugin updates" desc="On session start, compare installed plugins against the registry and surface an 'updates available' notice. Never auto-installs. (cli.plugins.autoUpdateCheck)">
                <Toggle on={plugins.autoUpdateCheck === true} onChange={(v) => setPath('plugins.autoUpdateCheck', v)} />
              </Row>
              <Row title="Registry URL" desc="The plugin index Marketplace search fetches — an https URL or a local file path for air-gapped mirrors. Blank = the built-in community registry. (cli.plugins.registryUrl)">
                <KnobText value={plugins.registryUrl} placeholder="(built-in community registry)" onSave={(v) => setPath('plugins.registryUrl', v)} />
              </Row>
              <Row title="Alt manifest filenames" desc="Extra JSON manifest names accepted when importing external marketplaces (comma-separated). BrainRouter still writes only its canonical names. (cli.plugins.altManifestNames)">
                <KnobText value={(plugins.altManifestNames ?? []).join(', ')}
                  placeholder="e.g. marketplace.json"
                  onSave={(v) => setPath('plugins.altManifestNames', v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null)} />
              </Row>
              <Row title="Publish target repo" desc="The community registry repo `plugin publish` opens a PR against (owner/repo or git url). Blank prints gh instructions instead. (cli.plugins.publishRepo)">
                <KnobText value={plugins.publishRepo} placeholder="owner/registry-repo" onSave={(v) => setPath('plugins.publishRepo', v)} />
              </Row>
            </SetGroup>
          </>
        );
      }
      case 'advanced': {
        // §settings-completeness — the load-bearing cli.* knobs, individually
        // editable (per-knob writer). The knob helpers live at component scope.
        return (
          <>
            <div className="set-h">Advanced</div>
            <div className="set-desc" style={{ marginBottom: 6 }}>Everything else under <code>cli.*</code> in <code>~/.config/brainrouter/config.json</code> — shared with the CLI (<code>/config</code>). Leave a number blank to use its default.</div>

            <SetGroup title="Model &amp; limits" collapsible>
              <SchemaCliFields schema={snapshot?.cliSchema} section="modelLimits" cli={knobs} onChange={setSchemaKnob} />
            </SetGroup>
            <SetGroup title="Agents" collapsible defaultOpen={false}>
              <SchemaCliFields schema={snapshot?.cliSchema} section="agents" cli={knobs} onChange={setSchemaKnob} />
            </SetGroup>
            <SetGroup title="Notifications" collapsible defaultOpen={false}>
              <SchemaCliFields schema={snapshot?.cliSchema} section="notifications" cli={knobs} onChange={setSchemaKnob} />
            </SetGroup>
            <SetGroup title="GitHub">
              <Row title="OAuth client ID" desc="GitHub OAuth App client id with device flow enabled (cli.github.oauthClientId).">
                <KnobText value={githubOauthClientId} onSave={saveGithubOauthClientId} placeholder="Iv1..." />
              </Row>
            </SetGroup>
            <SetGroup title="Keyboard shortcuts" collapsible defaultOpen={false}>
              <ShortcutsReference />
            </SetGroup>

            {/* WS11 — the raw knob editor is collapsed behind a Developer
                disclosure: most users never need it, and the JSON-valued knobs
                (permissions, automation) + internal safety knobs are handled by
                their own panels and hidden from this list. */}
            <details className="set-dev-raw">
              <summary className="set-h2" style={{ cursor: 'pointer' }}>Developer — raw <code>cli.*</code> config</summary>
              <div className="set-desc" style={{ marginBottom: 8 }}>Advanced: edit any remaining <code>cli</code> knob directly. Permissions, workflow automation, models and connectors have their own panels above and aren't shown here; internal safety knobs are hidden. Only change these if you know what they do.</div>
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
          <SetGroup title="This session">
            <Row title="Tokens" desc={props.tokens ? `${props.tokens.turns} turns` : 'No turns yet.'}>
              <span className="dim">{props.tokens ? `${props.tokens.promptTokens.toLocaleString()} in · ${props.tokens.completionTokens.toLocaleString()} out` : '—'}</span>
            </Row>
          </SetGroup>
          <SetGroup
            title={`Across all sessions (${usageDays === 7 ? 'last week' : usageDays === 30 ? 'last 30 days' : 'last year'})`}
            right={<span style={{ display: 'flex', gap: 4 }}>
              {[{ label: 'Week', days: 7 }, { label: 'Month', days: 30 }, { label: 'Year', days: 365 }].map((r) => (
                <button
                  key={r.days}
                  className={`chip${usageDays === r.days ? '' : ' dim'}`}
                  aria-pressed={usageDays === r.days}
                  onClick={() => { setUsageDays(r.days); props.onAction('q-usage-hist', 'usage-history', { days: r.days }); }}
                >{r.label}</button>
              ))}
            </span>}
          >
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
          </SetGroup>
          <SetGroup title="Diagnostics">
            <Row title="Workspace" desc={<code>{snapshot?.workspaceRoot ?? '—'}</code>} />
            <Row title="Local telemetry" desc="Privacy-conscious local-only task/latency log — no network (cli.telemetry.enabled).">
              <Toggle on={telemetryOn} onChange={(v) => setKnob('telemetry', { enabled: v })} />
            </Row>
            <Row title="Deep diagnostics" desc="/doctor, /debug-config, /watch and /trace remain CLI-side (they tail local logs)." />
          </SetGroup>
        </>
      );
      case 'appearance': return (
        <>
          <div className="set-h">Appearance</div>
          <SetGroup title="Desktop">
            <Row title="Accent color" desc="Interactive accent across the app — pick anything. Empty resets to the theme default.">
              <input type="color" className="ctl color-ctl" value={props.accent || '#7aa2f7'} onChange={(e) => props.onAccent(e.target.value)} />
              {props.accent ? <button className="btn" onClick={() => props.onAccent('')}>Reset</button> : null}
            </Row>
            <Row title="Desktop theme" desc="Graphite Mono = near-black neutral with an indigo accent (the desktop default). High-contrast = pure near-black.">
              <Select value={props.theme === 'hc' ? 'High-contrast dark' : 'Graphite Mono'} options={['Graphite Mono', 'High-contrast dark']}
                onChange={(v) => props.onTheme(v === 'High-contrast dark' ? 'hc' : 'dark')} />
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
          </SetGroup>
          <SetGroup title="Terminal (CLI)">
            <Row title="Markdown theme" desc="Syntax highlighting theme the terminal CLI uses for markdown output. (/theme)">
              <Select value={ps('theme', 'dark')} options={['auto', 'light', 'dark', 'mono']} onChange={(v) => props.onPref('theme', v)} />
            </Row>
            <Row title="Raw scrollback" desc="Skip markdown rendering in the terminal REPL for copy-friendly text. (/raw)">
              <Toggle on={pb('rawScrollback', false)} onChange={(v) => props.onPref('rawScrollback', v)} />
            </Row>
            <Row title="Vi composer" desc="vi-mode keybindings for the terminal composer. (/vim)">
              <Toggle on={ps('editorMode', 'emacs') === 'vi'} onChange={(v) => props.onPref('editorMode', v ? 'vi' : 'emacs')} />
            </Row>
            <Row title="Experimental features" desc="Unlock gated experimental features across both heads. (/experimental)">
              <Toggle on={pb('experimental', false)} onChange={(v) => props.onPref('experimental', v)} />
            </Row>
          </SetGroup>
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
              <div key={cat.key} className="set-group cmd-cat">
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
        <div className="settings-content"><div className="set-body">{body}</div></div>
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
