import React from 'react';
import { ProviderIcon } from '../../components/model/ProviderIcon.js';
import { Row, ChoiceControl } from '../shared/controls.js';
import type { ChoiceOption, ConfigSnapshot } from '../shared/types.js';

type ProviderSnapshot = NonNullable<ConfigSnapshot['providers']>[number];
type RouterCatalog = NonNullable<ConfigSnapshot['routerCatalog']>;
type RouterStatus = NonNullable<ConfigSnapshot['routerStatus']>;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hostOf(endpoint?: string | null): string {
  return (endpoint ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function secondsRemaining(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export function routerCatalogChoiceOptions(catalog: RouterCatalog | undefined, current?: string): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  const seen = new Set<string>();
  const push = (value: string, label: string, detail?: string): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, detail });
  };
  for (const alias of catalog?.aliases ?? []) {
    push(alias.id, alias.id, alias.target ? `alias -> ${alias.target}` : 'alias');
  }
  for (const bare of catalog?.bare ?? []) {
    push(bare.id, bare.model, bare.providers.length > 1 ? `${bare.providers.length} providers` : bare.providers[0]);
  }
  for (const entry of catalog?.canonical ?? []) {
    push(entry.id, entry.id, hostOf(entry.endpoint) || entry.provider);
  }
  if (current && !seen.has(current)) options.unshift({ value: current, label: current, detail: 'provider removed or model unavailable' });
  return options;
}

export function describeRouterRequest(catalog: RouterCatalog | undefined, request: string): string {
  const alias = catalog?.aliases.find((item) => item.id === request);
  if (alias) return alias.target ? `Alias target: ${alias.target}` : 'Alias route';
  const bare = catalog?.bare.find((item) => item.id === request);
  if (bare) return bare.providers.length > 1 ? `Router chooses among ${bare.providers.join(', ')}` : `Routed to ${bare.providers[0]}`;
  const canonical = catalog?.canonical.find((item) => item.id === request);
  if (canonical) return `${canonical.model} pinned to ${canonical.provider ?? canonical.providers[0]}${hostOf(canonical.endpoint) ? ` at ${hostOf(canonical.endpoint)}` : ''}`;
  return 'Provider removed or model unavailable; resolver skips it until edited.';
}

function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function RoutingChainEditor({
  catalog,
  status,
  providers,
  routerKnobs,
  baseModel,
  setRouterPath,
}: {
  catalog: RouterCatalog | undefined;
  status: RouterStatus | undefined;
  providers: ProviderSnapshot[];
  routerKnobs: Record<string, unknown>;
  baseModel?: string;
  setRouterPath: (path: string, value: unknown) => void;
}): React.ReactElement {
  const chain = catalog?.primaryChain ?? [];
  const strategy = typeof routerKnobs.strategy === 'string' ? routerKnobs.strategy : 'priority';
  const providerNames = providers.map((provider) => provider.name);
  const providerNameSet = new Set(providerNames);
  const choices = routerCatalogChoiceOptions(catalog);
  const ambiguousBare = (catalog?.bare ?? []).filter((item) => item.providers.length > 1);
  const ambiguousChain = chain.some((entry) => ambiguousBare.some((item) => item.id === entry));
  const configuredOrder = unique([...stringList(routerKnobs.order), ...providerNames]);
  const providerCooldowns = new Map((status?.providers ?? []).map((item) => [item.provider, item]));
  const modelCooldowns = (status?.models ?? []).filter((item) => secondsRemaining(item.until) > 0).slice(0, 3);
  const recent = (status?.recentEvents ?? []).slice(0, 5);
  const [dragChainIndex, setDragChainIndex] = React.useState<number | null>(null);
  const [dragProviderIndex, setDragProviderIndex] = React.useState<number | null>(null);
  const saveChain = (next: string[]): void => setRouterPath('chain', unique(next));
  const saveOrder = (next: string[]): void => setRouterPath('order', unique(next));
  const firstNewChoice = choices.find((choice) => !chain.includes(choice.value))?.value ?? choices[0]?.value ?? '';

  return (
    <>
      <div className="set-h2">Routing</div>
      <div className="set-desc" style={{ marginBottom: 8 }}>Every request routes through this chain — new turns, sub-agents, profiles, and gateway calls. Routing is always on; an empty chain simply falls through to the base model below.</div>
      <div className="provider-card saved" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10, padding: '11px 13px', marginBottom: 8 }}>
        <Row title="Strategy" desc="Orders providers when a chain entry resolves to more than one provider.">
          <ChoiceControl
            value={strategy}
            options={[
              { value: 'priority', label: 'priority', detail: 'provider order' },
              { value: 'round-robin', label: 'round-robin', detail: 'rotate healthy providers' },
              { value: 'free-first', label: 'free-first', detail: 'prefer free/local providers' },
            ]}
            onChange={(value) => setRouterPath('strategy', value)}
          />
        </Row>

        {providers.length === 0 ? (
          <div className="empty">No providers yet - connect one below; the base quickstart model is serving all traffic.</div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {chain.length === 0 ? (
            <div className="set-desc" style={{ margin: 0 }}>Primary chain is empty; the base config remains the visible tail route.</div>
          ) : null}
          {chain.map((entry, index) => {
            const removedProvider = entry.includes('/') && !providerNameSet.has(entry.split('/')[0]) && !entry.startsWith('base/');
            return (
              <div
                key={`${entry}-${index}`}
                draggable
                onDragStart={(event) => { setDragChainIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragChainIndex ?? Number(event.dataTransfer.getData('text/plain'));
                  saveChain(reorder(chain, from, index));
                  setDragChainIndex(null);
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '92px minmax(0, 1fr) auto',
                  gap: 8,
                  alignItems: 'center',
                  padding: '8px 9px',
                  borderRadius: 8,
                  border: `1px solid ${removedProvider ? 'var(--err)' : 'var(--border)'}`,
                  background: removedProvider ? 'rgba(245,80,80,.08)' : 'var(--input)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700 }}>
                  <span title="Drag to reorder" style={{ color: 'var(--text-faint)', cursor: 'grab' }}>::</span>
                  {index === 0 ? 'Primary' : `Fallback ${index}`}
                </span>
                <span style={{ minWidth: 0 }}>
                  <ChoiceControl
                    value={entry}
                    options={routerCatalogChoiceOptions(catalog, entry)}
                    onChange={(value) => saveChain(chain.map((item, itemIndex) => itemIndex === index ? value : item))}
                  />
                  <span className="set-desc" style={{ display: 'block', margin: '4px 0 0' }}>{describeRouterRequest(catalog, entry)}</span>
                </span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button className="btn" disabled={index === 0} title="Move up" onClick={() => saveChain(reorder(chain, index, index - 1))}>Up</button>
                  <button className="btn" disabled={index >= chain.length - 1} title="Move down" onClick={() => saveChain(reorder(chain, index, index + 1))}>Down</button>
                  <button className="btn danger" title="Remove route" onClick={() => saveChain(chain.filter((_item, itemIndex) => itemIndex !== index))}>Remove</button>
                </span>
              </div>
            );
          })}
          {baseModel ? (
            <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 8, alignItems: 'center', padding: '8px 9px', borderRadius: 8, border: '1px dashed var(--border)', color: 'var(--text-faint)' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>Tail</span>
              <span><code>Base config (quickstart)</code> - {baseModel}</span>
            </div>
          ) : null}
        </div>
        <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={!firstNewChoice} onClick={() => saveChain([...chain, firstNewChoice])}>Add fallback</button>

        {ambiguousChain && configuredOrder.length > 1 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="set-title">Provider order</div>
            <div className="set-desc">Used when a chain entry is available from multiple providers.</div>
            {configuredOrder.map((provider, index) => (
              <div
                key={provider}
                draggable
                onDragStart={(event) => { setDragProviderIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragProviderIndex ?? Number(event.dataTransfer.getData('text/plain'));
                  saveOrder(reorder(configuredOrder, from, index));
                  setDragProviderIndex(null);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--input)' }}
              >
                <span title="Drag to reorder" style={{ color: 'var(--text-faint)', cursor: 'grab' }}>::</span>
                <ProviderIcon id={providers.find((item) => item.name === provider)?.provider ?? provider} size={16} />
                <span style={{ flex: 1 }}>{provider}</span>
                <button className="btn" disabled={index === 0} onClick={() => saveOrder(reorder(configuredOrder, index, index - 1))}>Up</button>
                <button className="btn" disabled={index >= configuredOrder.length - 1} onClick={() => saveOrder(reorder(configuredOrder, index, index + 1))}>Down</button>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="set-title">Health</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {providers.length === 0 ? <span className="set-desc" style={{ margin: 0 }}>No provider health yet.</span> : null}
            {providers.map((provider) => {
              const cooldown = providerCooldowns.get(provider.name);
              const cooling = cooldown ? secondsRemaining(cooldown.until) : 0;
              const rejected = cooldown?.reason === 'auth_rejected' && cooling > 0;
              const label = rejected ? 'key rejected' : cooling > 0 ? `cooling ${cooling}s` : 'ok';
              const color = rejected ? 'var(--err)' : cooling > 0 ? 'var(--warn)' : 'var(--ok)';
              return (
                <span key={provider.name} className="pc-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: color }} />
                  {provider.name}: {label}
                </span>
              );
            })}
          </div>
          {modelCooldowns.length ? (
            <div className="set-desc" style={{ margin: 0 }}>
              Model lockouts: {modelCooldowns.map((item) => <code key={item.route} style={{ marginRight: 6 }}>{item.route} {secondsRemaining(item.until)}s</code>)}
            </div>
          ) : null}
          <div className="set-desc" style={{ margin: 0 }}>
            {recent.length ? <>Recent fallbacks: {recent.map((event) => <code key={`${event.at}-${event.to}`} style={{ marginRight: 6 }}>{event.message}</code>)}</> : <>Recent fallbacks: none</>}
          </div>
        </div>
      </div>
    </>
  );
}
