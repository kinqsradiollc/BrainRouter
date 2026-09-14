/**
 * ADR-045 M2 — Settings → Models → Context windows. Per-model context-window
 * overrides (`cli.contextWindows`, a model id → token count map). This is the
 * desktop half of "a context window you can size": the CLI knob already exists;
 * this makes it editable without hand-editing config.json.
 *
 * A value here wins over the shipped models.json table (and the legacy
 * contextWindows.json), so a user's own setting is authoritative for their
 * backend — it drives context assembly, the auto-compact threshold, child
 * budgets, and the Composer's "Model window" ring. Model ids are matched
 * case-insensitively (exact or vendor-prefix-stripped) by core's resolver, so
 * the key is lowercased on write.
 *
 * The model field is driven by the active endpoint's GET /models (never a
 * hardcoded list). Writes are sibling-safe via setPath, and — critically — the
 * WHOLE map is written under the single `contextWindows` key so a model id
 * containing a dot (e.g. `gpt-4.1`) stays a literal object key instead of being
 * split into a nested path.
 */
import React, { useState } from 'react';
import { ComboInput } from '../shared/controls.js';
import { Icon } from '../../icons.js';
import { routerCatalogChoiceOptions } from './RoutingChainEditor.js';
import type { ConfigSnapshot } from '../shared/types.js';

export function ContextWindowsCard({ windows, endpointModels, routerCatalog, setPath }: {
  windows: Record<string, number>;
  endpointModels: string[];
  routerCatalog?: ConfigSnapshot['routerCatalog'];
  setPath: (path: string, value: unknown) => void;
}): React.ReactElement {
  const [model, setModel] = useState('');
  const [tokens, setTokens] = useState('');
  const ids = Object.keys(windows).sort();
  const modelOptions = routerCatalog ? routerCatalogChoiceOptions(routerCatalog) : endpointModels;

  const add = (): void => {
    const key = model.trim().toLowerCase();
    const n = Number(tokens.trim());
    if (!key || !Number.isFinite(n) || n <= 0) return;
    // Write the WHOLE map so the model id is a literal object KEY, never a dotted
    // path segment — an id like "gpt-4.1" (or "__proto__") stays a key instead of
    // being split into nested objects / a prototype walk.
    setPath('contextWindows', { ...windows, [key]: Math.floor(n) });
    setModel(''); setTokens('');
  };
  const remove = (id: string): void => {
    const next = { ...windows };
    delete next[id];
    setPath('contextWindows', Object.keys(next).length ? next : null);
  };

  return (
    <>
      <div className="set-h2" style={{ marginTop: 16 }}>Context windows</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>
        Per-model context-window overrides in tokens. Wins over the built-in model table for
        your backend — sizes context assembly, auto-compaction, child budgets and the model ring.
        A live <code>/models</code> value for a local model (LM&nbsp;Studio) still wins when larger.
        (cli.contextWindows)
      </div>
      {ids.length === 0 ? <div className="empty">No overrides. Models use their built-in window.</div> : ids.map((id) => (
        <div key={id} className="rule-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div className="set-desc"><code>{id}</code> · {windows[id].toLocaleString()} tokens</div>
          <button className="tab-close-btn rule-x" aria-label={`Remove override for ${id}`} title="Remove" onClick={() => remove(id)}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="rule-add" style={{ flexWrap: 'wrap', gap: 6 }}>
        <ComboInput value={model} options={modelOptions} placeholder={routerCatalog ? 'bare or provider/model' : 'model'} onChange={setModel} style={{ maxWidth: 220 }} />
        <input className="ctl" type="number" min={1} placeholder="tokens (e.g. 200000)" value={tokens} style={{ maxWidth: 170 }} onChange={(e) => setTokens(e.target.value)} />
        <button className="btn" disabled={!model.trim() || !tokens.trim()} onClick={add}>Add override</button>
      </div>
    </>
  );
}
