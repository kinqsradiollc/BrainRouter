"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { PageHeader } from "../../../components/PageHeader";
import { PremiumButton } from "../../../components/PremiumButton";
import { PremiumCard } from "../../../components/PremiumCard";
import { adminApi, type ReviewJob, type ReviewPullRequestDetail } from "../../../lib/adminApi";

function Detail() {
  const search = useSearchParams();
  const repo = search.get("repo") ?? "";
  const number = Number(search.get("number"));
  const [pr, setPr] = useState<ReviewPullRequestDetail | null>(null);
  const [canRun, setCanRun] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!repo || !Number.isInteger(number)) return;
    try { const result = await adminApi.getReviewPr(repo, number); setPr(result.pr); setCanRun(result.canRun); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load pull request"); }
  }, [repo, number]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!pr?.reviews.some((review) => review.status === "pending" || review.status === "running")) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [pr?.reviews, load]);
  const run = async (lens: "security" | "code" | "both") => {
    setBusy(true);
    try { await adminApi.runReview({ repo, prNumber: number, lens }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to queue review"); }
    finally { setBusy(false); }
  };
  if (!repo || !Number.isInteger(number)) return <div className="settings-page"><PageHeader title="Pull request" description="Choose a PR from the Reviews console." /></div>;
  return <div className="settings-page">
    <PageHeader title={pr ? `${repo} #${number}` : "Pull request"} description={pr?.title ?? "Loading pull request…"} />
    <div className="settings-hint"><Link href="/reviews" className="settings-link">← Reviews</Link>{pr?.url && <> · <a className="settings-link" href={pr.url} target="_blank">Open on GitHub ↗</a></>}</div>
    {error && <div className="settings-note settings-note--error">{error}</div>}
    {pr && <>
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}><div className="settings-cardhead"><div><h3>{pr.title}</h3><div className="settings-hint">{pr.author ?? "unknown"} · {pr.branch ?? "unknown branch"} · {pr.headSha?.slice(0, 12) ?? "no SHA"}</div></div>{canRun && <div className="settings-actions"><PremiumButton size="small" variant="ghost" disabled={busy} onClick={() => run("security")}>Run security</PremiumButton><PremiumButton size="small" variant="ghost" disabled={busy} onClick={() => run("code")}>Run code</PremiumButton><PremiumButton size="small" variant="primary" disabled={busy} onClick={() => run("both")}>{busy ? "Queuing…" : "Run both"}</PremiumButton></div>}</div></PremiumCard>
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}><div className="settings-cardhead"><div><h3>Checks</h3><div className="settings-hint">GitHub check-run state for this head commit.</div></div></div>{pr.checks.length ? pr.checks.map((check, index) => <div className="settings-item" key={check.id ?? index}><span className="settings-row__title">{check.name ?? "Check"}</span><span className="settings-badge settings-badge--muted">{check.conclusion ?? check.status ?? "pending"}</span></div>) : <div className="settings-empty-inline">No check runs yet.</div>}</PremiumCard>
      {pr.reviews.map((review) => <ReviewCard key={review.id} review={review} />)}
    </>}
  </div>;
}

function ReviewCard({ review }: { review: ReviewJob }) {
  const running = review.status === "pending" || review.status === "running";
  return <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}>
    <div className="settings-cardhead"><div><h3>{review.lens === "security" ? "🛡️ Security review" : "🔎 Code review"}</h3><div className="settings-hint">{review.status}{review.error ? ` · ${review.error}` : ""}</div></div><span className="settings-badge settings-badge--muted">{review.findings ?? 0} findings</span></div>
    <div className="settings-hint" style={{ marginBottom: 8 }}>Live timeline {running ? "· updating every 2 seconds" : ""}</div>
    {review.progress?.length ? review.progress.map((event, index) => <div className="settings-item" key={`${event.ts}:${index}`}><span className="settings-row__title">{running && index === review.progress!.length - 1 ? "◌" : "✓"} {event.msg}</span><span className="settings-row__sub">{new Date(event.ts).toLocaleTimeString()}</span></div>) : <div className="settings-empty-inline">Waiting for progress events…</div>}
    <div className="settings-hint" style={{ marginTop: 14, marginBottom: 8 }}>Findings</div>
    {review.findingsDetail?.length ? review.findingsDetail.map((finding, index) => <div className="settings-item" key={`${finding.file}:${finding.line ?? 0}:${index}`}><div><span className="settings-row__title">{finding.severity.toUpperCase()} · {finding.title}</span><div className="settings-row__sub">{finding.file}{finding.line ? `:${finding.line}` : ""}{finding.cwe ? ` · ${finding.cwe}` : ""}{finding.preExisting ? " · pre-existing" : ""}</div></div></div>) : <div className="settings-empty-inline">No stored finding details.</div>}
  </PremiumCard>;
}

export default function ReviewDetailPage() { return <AuthGuard><Detail /></AuthGuard>; }
