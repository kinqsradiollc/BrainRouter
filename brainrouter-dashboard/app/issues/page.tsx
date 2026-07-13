"use client";
import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, SeverityBadge, StatusBadge } from "../../components/Analytics";
import { EmptyState } from "../../components/EmptyState";
import { adminApi, type ReviewJob } from "../../lib/adminApi";

const TABS=["all","open","in progress","snoozed","fixed","ignored"] as const;
export default function IssuesPage(){
  const [reviews,setReviews]=useState<ReviewJob[]>([]),[tab,setTab]=useState<(typeof TABS)[number]>("all"),[search,setSearch]=useState(""),[severity,setSeverity]=useState("all"),[repo,setRepo]=useState("all");
  useEffect(()=>{void adminApi.listReviewJobs(undefined,100).then(result=>setReviews(result.reviews)).catch(()=>setReviews([]));},[]);
  const findings=useMemo(()=>reviews.flatMap(review=>(review.findingsDetail??[]).map(finding=>({...finding,repo:review.repo,reviewStatus:review.status,issueStatus:finding.status??(review.status==="running"||review.status==="pending"?"in progress":"open")}))),[reviews]);
  const count=(value:string)=>findings.filter(finding=>finding.severity.toLowerCase()===value).length;
  const repos=[...new Set(findings.map(finding=>finding.repo).filter((value):value is string=>!!value))].sort();
  const filtered=findings.filter(finding=>tab==="all"||finding.issueStatus.toLowerCase()===tab).filter(finding=>severity==="all"||finding.severity.toLowerCase()===severity).filter(finding=>repo==="all"||finding.repo===repo).filter(finding=>`${finding.title??finding.summary??""} ${finding.file} ${finding.repo??""}`.toLowerCase().includes(search.toLowerCase()));
  return <AuthGuard><div className="settings-page"><PageHeader title="Issues" description="Verified findings from reviews and connected analysis workflows."/><div className="analytics-grid kpi-row">{["critical","high","medium","low"].map(value=><div className="metric-tile" key={value}><SeverityBadge severity={value}/><strong>{count(value)}</strong><span>findings</span></div>)}</div>
    <section className="analytics-panel" style={{marginTop:16}}><div className="issue-tabs" role="tablist">{TABS.map(value=><button role="tab" aria-selected={tab===value} className={tab===value?"issue-tab issue-tab--active":"issue-tab"} onClick={()=>setTab(value)} key={value}>{value}</button>)}</div><div className="issue-filters"><input className="settings-input" aria-label="Search findings" placeholder="Search issues" value={search} onChange={event=>setSearch(event.target.value)}/><select className="settings-select" aria-label="Severity filter" value={severity} onChange={event=>setSeverity(event.target.value)}><option value="all">All severities</option>{["critical","high","medium","low","info"].map(value=><option value={value} key={value}>{value}</option>)}</select><select className="settings-select" aria-label="Repository filter" value={repo} onChange={event=>setRepo(event.target.value)}><option value="all">All repositories</option>{repos.map(value=><option value={value} key={value}>{value}</option>)}</select></div>
    {filtered.length?<DataTable headers={["Severity","Finding","Repository","Status"]}>{filtered.map((finding,index)=><tr key={`${finding.file}-${finding.line??0}-${index}`}><td><SeverityBadge severity={finding.severity}/></td><td><strong>{finding.title??finding.summary??"Finding"}</strong><div className="settings-row__sub">{finding.file}{finding.line?`:${finding.line}`:""}</div></td><td>{finding.repo??"—"}</td><td><StatusBadge tone={finding.issueStatus==="fixed"?"ok":finding.issueStatus==="open"?"danger":"warn"}>{finding.issueStatus}</StatusBadge></td></tr>)}</DataTable>:<EmptyState title="No matching issues" description="Run a review or adjust the filters to see verified findings."/>}</section></div></AuthGuard>;
}
