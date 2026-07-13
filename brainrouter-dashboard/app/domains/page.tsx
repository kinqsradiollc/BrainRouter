"use client";
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type OrgSummary, type PentestTarget } from "../../lib/adminApi";

export default function DomainsPage() {
  const [orgs,setOrgs]=useState<OrgSummary[]>([]), [orgId,setOrgId]=useState(""), [targets,setTargets]=useState<PentestTarget[]>([]);
  const [kind,setKind]=useState<"domain"|"repository">("domain"), [value,setValue]=useState(""), [authorized,setAuthorized]=useState(false), [busy,setBusy]=useState(""), [error,setError]=useState("");
  const load=useCallback(async(id:string)=>{if(!id)return;try{setTargets((await adminApi.listPentestTargets(id)).targets??[]);}catch(e){setError(e instanceof Error?e.message:"Failed to load targets");}},[]);
  useEffect(()=>{void adminApi.listOrgs().then(({orgs})=>{setOrgs(orgs);const pick=orgs.find(o=>o.isDefault)??orgs[0];if(pick)setOrgId(pick.orgId);}).catch(e=>setError(e instanceof Error?e.message:"Failed to load organizations"));},[]);
  useEffect(()=>{void load(orgId);},[orgId,load]);
  async function add(){if(!value.trim()||!authorized)return;setBusy("add");setError("");try{await adminApi.createPentestTarget({kind,value:value.trim(),authorized:true},orgId);setValue("");setAuthorized(false);await load(orgId);}catch(e){setError(e instanceof Error?e.message:"Failed to add target");}finally{setBusy("");}}
  async function run(id:string){setBusy(id);setError("");try{await adminApi.startPentestRun(id,orgId);window.location.href="/pentests";}catch(e){setError(e instanceof Error?e.message:"Failed to start pentest");}finally{setBusy("");}}
  async function remove(id:string){setBusy(id);try{await adminApi.deletePentestTarget(id,orgId);await load(orgId);}catch(e){setError(e instanceof Error?e.message:"Failed to remove target");}finally{setBusy("");}}
  return <AuthGuard><div className="settings-page"><PageHeader title="Domains & APIs" description="Explicitly authorized targets for evidence-backed security assessments."><select className="settings-select" value={orgId} onChange={e=>setOrgId(e.target.value)}>{orgs.map(o=><option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select></PageHeader>
    {error?<div className="settings-error">{error}</div>:null}
    <section className="analytics-panel" style={{marginBottom:16}}><div className="settings-cardhead"><h2>Add target</h2></div><div style={{display:"grid",gridTemplateColumns:"150px 1fr auto",gap:10}}><select className="settings-select" value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="domain">Domain / API</option><option value="repository">Repository</option></select><input className="settings-input" value={value} onChange={e=>setValue(e.target.value)} placeholder={kind==="domain"?"https://app.example.com":"owner/repository"}/><PremiumButton variant="primary" disabled={!value.trim()||!authorized||busy==="add"} onClick={add}>{busy==="add"?"Adding…":"Add target"}</PremiumButton></div><label style={{display:"flex",gap:8,marginTop:12,fontSize:13}}><input type="checkbox" checked={authorized} onChange={e=>setAuthorized(e.target.checked)}/> I confirm that I own this target or have explicit permission to test it.</label></section>
    {targets.length?<section className="analytics-panel">{targets.map(t=><div className="settings-item" key={t.id}><div><strong>{t.label||t.normalizedValue}</strong><div className="set-desc">{t.kind} · authorized {new Date(t.authorizedAt).toLocaleDateString()}</div></div><div style={{display:"flex",gap:8}}><span className="analytics-badge analytics-badge--ok">Authorized</span><PremiumButton size="small" variant="primary" disabled={busy===t.id} onClick={()=>run(t.id)}>New Pentest</PremiumButton><PremiumButton size="small" variant="ghost" disabled={busy===t.id} onClick={()=>remove(t.id)}>Remove</PremiumButton></div></div>)}</section>:<EmptyState title="Add your first domain" description="Authorized targets are persisted for your active organization and can launch a bounded pentest."/>}
  </div></AuthGuard>;
}
