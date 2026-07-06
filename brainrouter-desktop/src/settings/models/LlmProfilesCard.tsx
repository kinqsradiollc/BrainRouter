/**
 * MC-DESK — Settings → Models → LLM profiles. Named model overlays
 * (`cli.llmProfiles` + `cli.activeLlmProfile`, MC-D3): switch the whole session
 * (model / endpoint / reasoning / fast) in one pick, and the agent's
 * `switch_model` tool chooses between the same named profiles.
 *
 * Model field is driven by the active endpoint's GET /models (never a
 * hardcoded list). Writes are sibling-safe via setPath.
 */
import React, { useState } from 'react';
import { Row, Select, Toggle } from '../shared/controls.js';
import { ComboInput } from '../shared/controls.js';
import { Icon } from '../../icons.js';
import { routerCatalogChoiceOptions } from './RoutingChainEditor.js';
import type { ConfigSnapshot } from '../shared/types.js';

type Dict = Record<string, unknown>;
type Profile = { model?: string; endpoint?: string; reasoningEffort?: string; fast?: boolean };
const EFFORTS = ['(default)', 'low', 'medium', 'high', 'xhigh'];

export function LlmProfilesCard({ profiles, active, endpointModels, routerCatalog, setPath }: {
  profiles: Record<string, Profile>;
  active: string;
  endpointModels: string[];
  routerCatalog?: ConfigSnapshot['routerCatalog'];
  setPath: (path: string, value: unknown) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('(default)');
  const [fast, setFast] = useState(false);
  const names = Object.keys(profiles).sort();
  // Rich options (model + provider detail) so the combo shows provider context —
  // ComboInput accepts ChoiceOption[] directly; don't flatten to bare values.
  const modelOptions = routerCatalog ? routerCatalogChoiceOptions(routerCatalog) : endpointModels;

  const add = (): void => {
    const n = name.trim();
    if (!n || !model.trim()) return;
    const profile: Profile = { model: model.trim() };
    if (effort !== '(default)') profile.reasoningEffort = effort;
    if (fast) profile.fast = true;
    // Write the WHOLE map so the profile name is a literal object KEY, never a
    // dotted path segment — a name like "gpt-4.1" (or "__proto__") stays a key
    // instead of being split into nested objects / a prototype walk.
    setPath('llmProfiles', { ...profiles, [n]: profile });
    setName(''); setModel(''); setEffort('(default)'); setFast(false);
  };
  const remove = (n: string): void => {
    const next = { ...profiles };
    delete next[n];
    setPath('llmProfiles', Object.keys(next).length ? next : null);
    if (active === n) setPath('activeLlmProfile', null);
  };

  return (
    <>
      <div className="set-h2" style={{ marginTop: 16 }}>LLM profiles</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Named model overlays — pick one to switch the session's model, endpoint, reasoning and
        Fast preference at once. The agent's <code>switch_model</code> tool chooses between them too.
        (cli.llmProfiles)
      </div>
      <Row title="Active profile" desc="Overlaid on the base model config at startup. (cli.activeLlmProfile)">
        <Select value={active || '(none)'} options={['(none)', ...names]} onChange={(v) => setPath('activeLlmProfile', v === '(none)' ? null : v)} />
      </Row>
      {names.length === 0 ? <div className="empty">No profiles defined.</div> : names.map((n) => {
        const p = profiles[n];
        return (
          <Row key={n} title={<>{n}{active === n ? <span className="badge native" style={{ marginLeft: 6 }}>active</span> : null}</>}
            desc={<><code>{p.model}</code>{p.reasoningEffort ? ` · ${p.reasoningEffort}` : ''}{p.fast ? ' · fast' : ''}{p.endpoint ? ` · ${p.endpoint}` : ''}</>}>
            <button className="tab-close-btn rule-x" aria-label={`Remove profile ${n}`} title="Remove" onClick={() => remove(n)}><Icon name="close" size={11} /></button>
          </Row>
        );
      })}
      <div className="rule-add" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input className="ctl" placeholder="profile name" value={name} style={{ maxWidth: 130 }} onChange={(e) => setName(e.target.value)} />
        <ComboInput value={model} options={modelOptions} placeholder={routerCatalog ? 'bare or provider/model' : 'model'} onChange={setModel} style={{ maxWidth: 220 }} />
        <Select value={effort} options={EFFORTS} onChange={setEffort} />
        <label className="set-desc" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>fast <Toggle on={fast} onChange={setFast} /></label>
        <button className="btn" disabled={!name.trim() || !model.trim()} onClick={add}>Add profile</button>
      </div>
    </>
  );
}
