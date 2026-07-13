"use client";

import { useEffect, useState } from "react";
import { PremiumButton } from "../../components/PremiumButton";
import { StatusBadge } from "../../components/Analytics";
import { adminApi, type ConnectorStatus } from "../../lib/adminApi";

const GROUPS: Array<{ title: string; sources: Array<[string, string]> }> = [
  { title: "Code providers", sources: [["github", "GitHub"], ["gitlab", "GitLab"]] },
  { title: "Communication", sources: [["slack", "Slack"]] },
  { title: "Knowledge & issue tracking", sources: [["google-drive", "Google Drive"], ["gmail", "Gmail"], ["notion", "Notion"], ["linear", "Linear"]] },
];

export function ConnectorRows() {
  const [state, setState] = useState<Record<string, ConnectorStatus | null>>({});
  const [resources, setResources] = useState<Record<string, Array<{ id: string; label: string; selected: boolean; kind?: string }>>>({});
  const [expanded, setExpanded] = useState("");
  const [busy, setBusy] = useState("");
  const load = async () => { const entries = await Promise.all(GROUPS.flatMap(g => g.sources).map(async ([source]) => [source, await adminApi.connectorStatus(source).catch(() => null)] as const)); setState(Object.fromEntries(entries)); };
  useEffect(() => { void load(); }, []);
  async function connect(source: string) { setBusy(source); try { const result = await adminApi.startConnectorOAuth(source, state[source]?.connector?.id); window.location.assign(result.url); } finally { setBusy(""); } }
  async function disconnect(source: string) { setBusy(source); try { await adminApi.disconnectConnector(source); await load(); } finally { setBusy(""); } }
  async function toggleResources(source: string) {
    if (expanded === source) { setExpanded(""); return; }
    setBusy(source);
    try { const result = await adminApi.connectorResources(source); setResources((current) => ({ ...current, [source]: result.resources })); setExpanded(source); }
    finally { setBusy(""); }
  }
  async function persistResources(source: string, rows: Array<{ id: string; selected: boolean }>) {
    setBusy(source);
    try { await adminApi.setConnectorResources(source, rows.filter((row) => row.selected).map((row) => row.id)); setExpanded(""); }
    finally { setBusy(""); }
  }
  return <div className="settings-stack" style={{ marginTop: "var(--spacing-24)" }}>{GROUPS.map(group => <section className="analytics-panel" key={group.title}><h2>{group.title}</h2>{group.sources.map(([source,label]) => { const item=state[source]; const connected=!!item?.connected; const rows=resources[source]??[]; const selectable=source!=="gmail"; return <div className="connector-resource" key={source}><div className="settings-item"><div><div className="settings-row__title">{label}</div><div className="settings-row__sub">{connected ? item?.connector?.lastRunAt ? `Last sync ${new Date(item.connector.lastRunAt).toLocaleString()}` : "Connected — ready to sync" : "Connect a server-sealed account"}</div></div><div className="settings-actions"><StatusBadge tone={connected?"ok":"neutral"}>{connected?"Connected":"Not connected"}</StatusBadge>{connected&&<PremiumButton size="small" variant="text" disabled={busy===source} onClick={()=>void toggleResources(source)}>{expanded===source?"Close":source==="gmail"?"View labels":"Choose resources"}</PremiumButton>}<PremiumButton size="small" variant={connected?"danger":"ghost"} disabled={busy===source} onClick={()=>connected?void disconnect(source):void connect(source)}>{busy===source?"Working…":connected?"Disconnect":"Connect"}</PremiumButton></div></div>{expanded===source&&<div className="connector-resource__picker">{rows.length===0?<div className="settings-hint">No resources were returned by this account.</div>:rows.map((row)=><label className="settings-check" key={row.id}><input type="checkbox" disabled={!selectable} checked={row.selected} onChange={(event)=>setResources((current)=>({...current,[source]:rows.map((candidate)=>candidate.id===row.id?{...candidate,selected:event.target.checked}:candidate)}))}/><span>{row.label}</span>{row.kind&&<small>{row.kind}</small>}</label>)}{selectable&&rows.length>0&&<div className="connector-resource__actions"><PremiumButton size="small" variant="primary" disabled={busy===source} onClick={()=>void persistResources(source,rows)}>Save selection</PremiumButton></div>}</div>}</div>;})}</section>)}</div>;
}
