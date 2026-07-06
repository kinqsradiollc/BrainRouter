/**
 * MC-DESK — Settings → Automations. Structured UI for the inbound trigger
 * ingress (`cli.triggers`): the opt-in webhook listener that turns signed
 * GitHub / Slack / GitLab / Jira deliveries into automated agent jobs.
 *
 * Everything is DEFAULT-DENY: nothing listens until `enabled`, it binds
 * loopback unless a host is named, an empty repo allowlist accepts nothing.
 * Signing secrets are WRITE-ONLY — the panel only learns whether each is set
 * (via snapshot.triggerSecretsSet); the value is scrubbed and never read back.
 * Writes go through `setPath` (sibling-safe), so setting `enabled` never wipes
 * a secret.
 */
import React, { useState } from 'react';
import { Row, Toggle, KnobNumber, KnobText, SetGroup } from '../shared/controls.js';
import { Icon } from '../../icons.js';

type Dict = Record<string, unknown>;
type SecretsSet = { github: boolean; slack: boolean; gitlab: boolean; jira: boolean };
type RuleRow = { id: string; name: string; on: string; when: string; do: string; enabled: boolean; sourcePath: string };
type ServeStatus = { running: boolean; host: string | null; port: number | null; startedAt: string | null; providers: string[]; recentEvents: string[]; lastError: string | null };

export function AutomationsSection({ knobs, setPath, secretsSet, rules = [], serve, onAction, refreshSnapshot }: {
  knobs: Dict;
  setPath: (path: string, value: unknown) => void;
  secretsSet: SecretsSet;
  rules?: RuleRow[];
  serve?: ServeStatus;
  onAction?: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSnapshot?: () => void;
}): React.ReactElement {
  const setRuleEnabled = (id: string, enabled: boolean): void => { onAction?.('a-rule', 'action:automation-rule-enabled', { id, enabled }); setTimeout(() => refreshSnapshot?.(), 150); };
  const serveAction = (name: string): void => { onAction?.('a-serve', name, {}); setTimeout(() => refreshSnapshot?.(), 250); };
  const triggers = (knobs.triggers ?? {}) as Dict;
  const enabled = triggers.enabled === true;
  const allowedRepos = (Array.isArray(triggers.allowedRepos) ? triggers.allowedRepos : []).filter((r): r is string => typeof r === 'string');

  return (
    <>
      <div className="set-h">Automations</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Inbound triggers turn signed webhooks into agent jobs — a label or <code>@mention</code>
        on a GitHub issue/PR, a Slack message, a failing CI run. Everything is
        <b> default-deny</b>: nothing listens until enabled, it binds loopback, and only
        allow-listed repos are processed. (cli.triggers)
      </div>

      <SetGroup title="Trigger ingress">
        <Row title="Enable trigger ingress" desc="Master switch for the webhook listener. Off = nothing listens, whatever else is set. (cli.triggers.enabled)">
          <Toggle on={enabled} onChange={(v) => setPath('triggers.enabled', v)} />
        </Row>
      </SetGroup>

      <SetGroup title="Listener daemon">
        <Row
          title={<>Webhook listener {serve?.running
            ? <span className="badge native" style={{ marginLeft: 6 }}>running</span>
            : <span className="badge cli" style={{ marginLeft: 6 }}>stopped</span>}</>}
          desc={serve?.running
            ? <>Listening on <code>http://{serve.host}:{serve.port}</code> · providers: {serve.providers.join(', ')} · since {serve.startedAt ? new Date(serve.startedAt).toLocaleTimeString() : '—'}. Runs while the desktop app is open; `brainrouter serve --triggers` does the same from a terminal.</>
            : <>Start the inbound webhook listener in this app (same gates as `brainrouter serve --triggers`).{serve?.lastError ? <> · <span style={{ color: 'rgb(214,156,60)' }}>{serve.lastError}</span></> : null}</>}>
          {serve?.running
            ? <button className="btn danger" onClick={() => serveAction('action:triggers-serve-stop')}>Stop</button>
            : <button className="btn" disabled={!enabled} title={enabled ? undefined : 'Turn on "Enable trigger ingress" first'} onClick={() => serveAction('action:triggers-serve-start')}>Start</button>}
        </Row>
        {serve?.running && serve.recentEvents.length ? (
          <Row title="Recent activity" desc={<span style={{ whiteSpace: 'pre-wrap' }}>{serve.recentEvents.slice(0, 5).join('\n')}</span>} />
        ) : null}
      </SetGroup>

      <div style={{ opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? 'auto' : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SetGroup title="Listener">
          <Row title="Bind host" desc="Interface the ingress binds. Default loopback — exposing it beyond localhost is your explicit choice. (cli.triggers.host)">
            <KnobText value={triggers.host} placeholder="127.0.0.1" onSave={(v) => setPath('triggers.host', v)} />
          </Row>
          <Row title="Port" desc="TCP port the ingress binds. Default 8787. (cli.triggers.port)">
            <KnobNumber value={triggers.port} placeholder="8787" onSave={(v) => setPath('triggers.port', v)} />
          </Row>
        </SetGroup>

        <SetGroup title="Signing secrets">
          <div className="set-desc" style={{ marginBottom: 8 }}>
            Per-provider webhook verification. A provider with no secret rejects every delivery (401) — never "let through".
            Secrets are write-only: type to set or replace; they're never shown back. If blank, the matching connector's
            <code> webhookSecret</code> is used.
          </div>
          <SecretRow label="GitHub" desc="Verifies X-Hub-Signature-256." isSet={secretsSet.github} onSave={(v) => setPath('triggers.githubSecret', v)} onClear={() => setPath('triggers.githubSecret', null)} />
          <SecretRow label="Slack" desc="Verifies X-Slack-Signature." isSet={secretsSet.slack} onSave={(v) => setPath('triggers.slackSigningSecret', v)} onClear={() => setPath('triggers.slackSigningSecret', null)} />
          <SecretRow label="GitLab" desc="Verifies X-Gitlab-Token." isSet={secretsSet.gitlab} onSave={(v) => setPath('triggers.gitlabSecret', v)} onClear={() => setPath('triggers.gitlabSecret', null)} />
          <SecretRow label="Jira" desc="Verifies the Jira webhook HMAC." isSet={secretsSet.jira} onSave={(v) => setPath('triggers.jiraSecret', v)} onClear={() => setPath('triggers.jiraSecret', null)} />
        </SetGroup>

        <ReposEditor repos={allowedRepos} onChange={(next) => setPath('triggers.allowedRepos', next)} />

        <SetGroup title="Behavior">
          <Row title="Mention handle" desc="The @handle the GitHub resolver reacts to in issue/PR/review comments. Default 'brainrouter'. (cli.triggers.mentionHandle)">
            <KnobText value={triggers.mentionHandle} placeholder="brainrouter" onSave={(v) => setPath('triggers.mentionHandle', v)} />
          </Row>
          <Row title="CI-failure nudge" desc="Post ONE offer-to-fix comment when a failed CI run lands on an open, allow-listed PR (idempotent). (cli.triggers.ciNudge)">
            <Toggle on={triggers.ciNudge === true} onChange={(v) => setPath('triggers.ciNudge', v)} />
          </Row>
        </SetGroup>
      </div>

      <SetGroup title="Automation rules">
        <div className="set-desc" style={{ marginBottom: 8 }}>
          Markdown rules under <code>.brainrouter/automations/*.md</code> match trigger events to actions
          (build / fix-ci / review). Toggle to enable/disable a rule (rewrites its frontmatter). Suggested
          tasks from your repos surface in the <b>Tasks</b> panel.
        </div>
        {rules.length === 0 ? (
          <div className="empty">No automation rules. Add one under .brainrouter/automations/&lt;name&gt;.md.</div>
        ) : rules.map((r) => (
          <Row key={r.id}
            title={<>{r.name} <span className="badge cli" style={{ marginLeft: 6 }}>{r.do}</span></>}
            desc={<>on <code>{r.on}</code>{r.when ? <> · when <code>{r.when}</code></> : ''} · <span className="dim">{r.sourcePath.split('/').pop()}</span></>}>
            <Toggle on={r.enabled} onChange={(v) => setRuleEnabled(r.id, v)} />
          </Row>
        ))}
      </SetGroup>
    </>
  );
}

/** Write-only secret input: shows a "configured / not set" chip, never the value. */
function SecretRow({ label, desc, isSet, onSave, onClear }: {
  label: string; desc: string; isSet: boolean; onSave: (v: string | null) => void; onClear: () => void;
}): React.ReactElement {
  return (
    <Row title={<>{label} <span className={`badge ${isSet ? 'native' : 'cli'}`} style={{ marginLeft: 6 }}>{isSet ? 'configured' : 'not set'}</span></>} desc={desc}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <KnobText value="" placeholder={isSet ? 'type to replace' : 'paste secret'} onSave={(v) => { if (v && v.trim()) onSave(v.trim()); }} />
        {isSet ? <button className="btn danger" onClick={onClear}>Clear</button> : null}
      </div>
    </Row>
  );
}

/** owner/name repo allowlist editor. */
function ReposEditor({ repos, onChange }: { repos: string[]; onChange: (next: string[]) => void }): React.ReactElement {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const r = draft.trim();
    if (!r || repos.includes(r)) { setDraft(''); return; }
    onChange([...repos, r]); setDraft('');
  };
  return (
    <SetGroup title="Allowed repos">
      <div className="set-desc" style={{ marginBottom: 8 }}>Glob allowlist of <code>owner/name</code> repos whose events are processed. Empty = nothing is allowed. (cli.triggers.allowedRepos)</div>
      {repos.length === 0 ? <div className="empty">No repos allow-listed — all events verify then drop.</div> : repos.map((r) => (
        <div key={r} className="rule-row">
          <span className="rule-kind allow">repo</span>
          <span className="rule-text">{r}</span>
          <button className="tab-close-btn rule-x" aria-label={`Remove ${r}`} title="Remove" onClick={() => onChange(repos.filter((x) => x !== r))}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="rule-add">
        <input className="ctl" placeholder="owner/name or owner/*" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" disabled={!draft.trim()} onClick={add}>Allow repo</button>
      </div>
    </SetGroup>
  );
}
