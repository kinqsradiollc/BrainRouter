"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, StatusBadge } from "../../components/Analytics";
import { EmptyState } from "../../components/EmptyState";
import { adminApi } from "../../lib/adminApi";
// Only ever render an anchor for an http(s) URL — never trust a stored value to
// be a safe scheme (a `javascript:`/`data:` href would execute on click).
const httpUrl=(u:string):string|null=>{try{const p=new URL(u);return p.protocol==="https:"||p.protocol==="http:"?p.href:null;}catch{return null;}};
export default function RepositoriesPage(){const [repos,setRepos]=useState<{fullName:string;url:string;private:boolean;defaultBranch:string}[]>([]);useEffect(()=>{void adminApi.listOrgs().then(async r=>{const org=r.orgs.find(o=>o.isDefault)??r.orgs[0];if(org){const x=await adminApi.githubRepos(org.orgId);setRepos(x.repos);}}).catch(()=>setRepos([]));},[]);return <AuthGuard><div className="settings-page"><PageHeader title="Repositories" description="Linked repositories available to review and assess."/>{repos.length?<section className="analytics-panel"><DataTable headers={["Repository","Branch","Visibility","Status"]}>{repos.map(r=><tr key={r.fullName}><td>{httpUrl(r.url)?<a href={httpUrl(r.url)!} target="_blank" rel="noopener noreferrer">{r.fullName}</a>:r.fullName}</td><td>{r.defaultBranch}</td><td>{r.private?"Private":"Public"}</td><td><StatusBadge tone="ok">Linked</StatusBadge></td></tr>)}</DataTable></section>:<EmptyState title="No repositories linked" description="Configure your code provider and grant repository access to start reviewing."><Link href="/integrations">Open integrations</Link></EmptyState>}</div></AuthGuard>;}
