"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SourceDocument } from "@kinqs/brainrouter-types";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
import { PremiumButton } from "../../components/PremiumButton";
import { DataTable, StatusBadge } from "../../components/Analytics";
import { getClient } from "../../lib/client";

type SourceRow = SourceDocument & { chunkCount: number };

export default function KnowledgePage(){
  const client=useMemo(()=>getClient(),[]),[sources,setSources]=useState<SourceRow[]>([]),[search,setSearch]=useState(""),[kind,setKind]=useState("internal"),[loading,setLoading]=useState(true),[error,setError]=useState("");
  useEffect(()=>{void client.getSources({limit:100}).then(result=>setSources((result.documents??[]) as SourceRow[])).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setLoading(false));},[client]);
  const rows=useMemo(()=>sources.filter(source=>kind==="all"||(kind==="internal"&&source.kind!=="transcript")||source.kind===kind).filter(source=>`${source.title??""} ${source.uri??""} ${source.kind}`.toLowerCase().includes(search.toLowerCase())),[sources,search,kind]);
  const kinds=[...new Set(sources.map(source=>source.kind))].sort();
  return <AuthGuard><div className="settings-page"><PageHeader title="Knowledge & Context" description="Internal source material available for grounded agent and review context."><Link href="/sources"><PremiumButton>Add Knowledge</PremiumButton></Link></PageHeader>
    <div className="settings-cardhead" style={{margin:"16px 0"}}><input className="settings-input" aria-label="Search knowledge" placeholder="Search knowledge" value={search} onChange={event=>setSearch(event.target.value)}/><select className="settings-select" aria-label="Knowledge type" value={kind} onChange={event=>setKind(event.target.value)}><option value="internal">Internal knowledge</option><option value="all">All sources</option>{kinds.map(value=><option value={value} key={value}>{value}</option>)}</select></div>
    {error&&<div className="settings-note settings-note--error">{error}</div>}
    {rows.length?<section className="analytics-panel"><DataTable headers={["Source","Type","Chunks","Added"]}>{rows.map(source=><tr key={source.id}><td><Link href="/sources">{source.title||source.uri||source.id}</Link></td><td><StatusBadge tone={source.kind==="transcript"?"neutral":"info"}>{source.kind}</StatusBadge></td><td>{source.chunkCount}</td><td>{source.createdAt?new Date(source.createdAt).toLocaleString():"—"}</td></tr>)}</DataTable></section>:<EmptyState title={loading?"Loading knowledge…":"No internal knowledge selected"} description="Connect a source or add a memory to provide relevant, citable context."/>}
  </div></AuthGuard>;
}
