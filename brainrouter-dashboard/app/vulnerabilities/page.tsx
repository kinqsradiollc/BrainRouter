"use client";

import {
  ArrowsClockwise, Bell, CheckCircle, Clock, Database, FileArrowUp,
  Funnel, MagnifyingGlass, ShieldCheck, Warning, X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { authFetch } from "../../lib/adminApi";

interface CatalogRow {
  cveId: string; summary: string; severity: string | null; cvssScore: number | null;
  epssScore: number | null; epssPercentile: number | null; kev: boolean;
  publishedAt: string | null; modifiedAt: string | null; withdrawnAt: string | null;
}
interface CatalogDetail extends CatalogRow {
  cvssVector: string | null; epssDate: string | null; kevDateAdded: string | null;
  aliases: string[]; sources: string[];
  references: Array<{ url: string; kind: string }>;
  ranges: Array<{ source_id?: string; ecosystem?: string; package_name?: string; purl?: string; introduced?: string; fixed?: string; last_affected?: string }>;
}
interface SourceRow {
  id: string; displayName: string; kind: string; lastAttemptAt: string | null;
  lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null;
  activeRun: { id: string; startedAt: string; itemsSeen: number; itemsUpserted: number } | null;
}
interface FindingRow {
  id: string; repo: string; cveId: string; ecosystem: string; packageName: string;
  installedVersion: string; purl: string; introduced: string | null; fixed: string | null;
  evidence: string; status: string; lastSeenAt: string;
}
interface ScanRow {
  id: string; repo: string; status: string; componentsSeen: number; matchesFound: number;
  truncated: boolean; startedAt: string; finishedAt: string | null; error: string | null;
}
interface WatchRow { id: string; repo: string; status: string; lastRunAt: string | null; lastError: string | null }
interface RepoRow { fullName: string }
interface ScanFile { path: string; content: string; bytes: number }

const PAGE_SIZE = 50;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const ECOSYSTEMS = ["npm", "PyPI", "Go", "Maven", "crates.io", "RubyGems"];

function percent(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function date(value: string | null, withTime = false): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return withTime ? parsed.toLocaleString() : parsed.toLocaleDateString();
}

function freshness(source: SourceRow): { state: "fresh" | "stale" | "error" | "pending" | "ondemand"; label: string } {
  if (source.activeRun) return { state: "pending", label: "Refreshing" };
  if (source.id === "osv" && !source.lastSuccessAt) return { state: "ondemand", label: "On demand" };
  if (source.consecutiveFailures > 0 && source.lastError) return { state: "error", label: "Refresh failed" };
  if (!source.lastSuccessAt) return { state: "pending", label: "Not synced" };
  const age = Date.now() - Date.parse(source.lastSuccessAt);
  const staleAfter = source.id === "first-epss" ? 36 * 3_600_000 : 48 * 3_600_000;
  return age > staleAfter ? { state: "stale", label: "Stale" } : { state: "fresh", label: "Fresh" };
}

export default function VulnerabilitiesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("tab") === "exposure" ? "exposure" : "catalog";
  const selectedCve = params.get("cve")?.toUpperCase() ?? "";
  const search = params.get("search") ?? "";
  const severity = params.get("severity") ?? "";
  const minCvss = params.get("minCvss") ?? "";
  const minEpss = params.get("minEpss") ?? "";
  const ecosystem = params.get("ecosystem") ?? "";
  const days = params.get("days") ?? "120";
  const kev = params.get("kev") === "true";
  const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);

  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [searchDraft, setSearchDraft] = useState(search);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [exposureBusy, setExposureBusy] = useState(true);
  const [scanRepo, setScanRepo] = useState("");
  const [scanFiles, setScanFiles] = useState<ScanFile[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key); else next.set(key, value);
    if (!["offset", "cve"].includes(key)) next.delete("offset");
    const query = next.toString();
    router.replace(query ? `/vulnerabilities?${query}` : "/vulnerabilities");
  }, [params, router]);

  const loadSources = useCallback(async () => {
    const result = await authFetch<{ sources: SourceRow[] }>("/api/vulnerability/sources");
    setSources(result.sources);
    return result.sources;
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogBusy(true); setCatalogError("");
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (search) query.set("search", search);
    if (severity) query.set("severity", severity);
    if (kev) query.set("kev", "true");
    if (minCvss) query.set("minCvss", minCvss);
    if (minEpss) query.set("minEpss", minEpss);
    if (ecosystem) query.set("ecosystem", ecosystem);
    if (days) query.set("modifiedSince", new Date(Date.now() - Number(days) * 86_400_000).toISOString());
    try {
      const [catalog] = await Promise.all([
        authFetch<{ items: CatalogRow[]; total: number }>(`/api/vulnerabilities?${query}`),
        loadSources().catch(() => undefined),
      ]);
      setRows(catalog.items); setTotal(catalog.total);
    } catch (error) {
      setRows([]); setTotal(0); setCatalogError(error instanceof Error ? error.message : "Catalog unavailable");
    } finally { setCatalogBusy(false); }
  }, [days, ecosystem, kev, loadSources, minCvss, minEpss, offset, search, severity]);

  const loadExposure = useCallback(async () => {
    try {
      const [findingResult, scanResult, watchResult] = await Promise.all([
        authFetch<{ findings: FindingRow[] }>("/api/vulnerability/findings"),
        authFetch<{ scans: ScanRow[] }>("/api/vulnerability/scans"),
        authFetch<{ watches: WatchRow[] }>("/api/vulnerability/watches"),
      ]);
      setFindings(findingResult.findings); setScans(scanResult.scans); setWatches(watchResult.watches);
    } finally { setExposureBusy(false); }
  }, []);

  useEffect(() => { setSearchDraft(search); }, [search]);
  useEffect(() => { if (tab === "catalog") void loadCatalog(); else void loadExposure(); }, [loadCatalog, loadExposure, tab]);
  useEffect(() => {
    if (tab !== "exposure" || !scans.some((scan) => scan.status === "running")) return;
    const timer = window.setInterval(() => void loadExposure(), 2_500);
    return () => window.clearInterval(timer);
  }, [loadExposure, scans, tab]);
  useEffect(() => {
    if (tab !== "exposure") return;
    void authFetch<{ repos?: RepoRow[] }>("/api/connectors/github/repos").then((result) => setRepos(result.repos ?? [])).catch(() => setRepos([]));
  }, [tab]);
  useEffect(() => {
    if (!selectedCve) { setDetail(null); return; }
    setDetailBusy(true);
    void authFetch<CatalogDetail>(`/api/vulnerabilities/${encodeURIComponent(selectedCve)}`)
      .then(setDetail).catch(() => setDetail(null)).finally(() => setDetailBusy(false));
  }, [selectedCve]);

  const refreshSource = useCallback(async (id: string) => {
    setRefreshing((current) => ({ ...current, [id]: true }));
    setCatalogError("");
    const before = sources.find((source) => source.id === id);
    try {
      await authFetch(`/api/vulnerability/sources/${id}/refresh`, { method: "POST" });
      let completed = false;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const current = (await loadSources()).find((source) => source.id === id);
        if (!current) continue;
        const succeeded = Boolean(current.lastSuccessAt && current.lastSuccessAt !== before?.lastSuccessAt);
        const failed = current.consecutiveFailures > (before?.consecutiveFailures ?? 0)
          || Boolean(current.lastError && current.lastError !== before?.lastError);
        if (succeeded || failed) { completed = true; break; }
      }
      // The source card remains authoritative when a long bounded feed run is
      // still active; do not turn normal background work into a red error.
      if (!completed) await loadSources();
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Refresh could not be queued");
    } finally {
      setRefreshing((current) => ({ ...current, [id]: false }));
    }
  }, [loadSources, sources]);

  const readFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const selected = [...files].slice(0, 20);
    try {
      const loaded = await Promise.all(selected.map(async (file) => {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} is larger than 8 MB`);
        return { path: file.name, content: await file.text(), bytes: file.size };
      }));
      setScanFiles(loaded); setScanError("");
    } catch (error) { setScanFiles([]); setScanError(error instanceof Error ? error.message : "Unable to read file"); }
  }, []);

  const runScan = useCallback(async () => {
    if (!scanRepo.trim() || scanFiles.length === 0) return;
    setScanBusy(true); setScanError("");
    try {
      await authFetch("/api/vulnerability/scans", { method: "POST", body: { repo: scanRepo.trim(), files: scanFiles.map(({ path, content }) => ({ path, content })) } });
      setScanFiles([]); if (fileRef.current) fileRef.current.value = "";
      await loadExposure();
    } catch (error) { setScanError(error instanceof Error ? error.message : "Scan could not be queued"); }
    finally { setScanBusy(false); }
  }, [loadExposure, scanFiles, scanRepo]);

  const toggleWatch = useCallback(async () => {
    const current = watches.find((watch) => watch.repo.toLowerCase() === scanRepo.trim().toLowerCase());
    if (!scanRepo.trim()) return;
    try {
      if (current) await authFetch(`/api/vulnerability/watches/${current.id}`, { method: "DELETE" });
      else await authFetch("/api/vulnerability/watches", { method: "POST", body: { repo: scanRepo.trim() } });
      await loadExposure();
    } catch (error) { setScanError(error instanceof Error ? error.message : "Watch could not be updated"); }
  }, [loadExposure, scanRepo, watches]);

  const dismiss = useCallback(async (id: string, status: "open" | "dismissed") => {
    await authFetch(`/api/vulnerability/findings/${id}`, { method: "PATCH", body: { status, reason: status === "dismissed" ? "triaged in dashboard" : undefined } });
    await loadExposure();
  }, [loadExposure]);

  const critical = rows.filter((row) => row.severity === "critical").length;
  const exploited = rows.filter((row) => row.kev).length;
  const highRisk = rows.filter((row) => (row.epssScore ?? 0) >= 0.5).length;
  const watched = watches.some((watch) => watch.repo.toLowerCase() === scanRepo.trim().toLowerCase());

  return (
    <AuthGuard>
      <main className="cve-page">
        <PageHeader title="CVE intelligence" description="Live vulnerability context with evidence-first repository exposure.">
          <div className="cve-live-indicator"><span /> NVD · KEV · EPSS · OSV</div>
        </PageHeader>

        <div className="cve-tabs" role="tablist" aria-label="Vulnerability views">
          <button type="button" role="tab" aria-selected={tab === "catalog"} onClick={() => setParam("tab", null)}><Database size={15} /> Catalog</button>
          <button type="button" role="tab" aria-selected={tab === "exposure"} onClick={() => setParam("tab", "exposure")}><ShieldCheck size={15} /> My exposure {findings.filter((finding) => finding.status === "open").length > 0 ? <b>{findings.filter((finding) => finding.status === "open").length}</b> : null}</button>
        </div>

        {tab === "catalog" ? (
          <>
            <section className="cve-metrics" aria-label="Catalog summary">
              <div><span>Matching CVEs</span><strong>{total.toLocaleString()}</strong><small>Last {days} days</small></div>
              <div><span>Critical on page</span><strong>{critical}</strong><small>CVSS 9.0–10.0</small></div>
              <div><span>Actively exploited</span><strong>{exploited}</strong><small>CISA KEV</small></div>
              <div><span>High exploit probability</span><strong>{highRisk}</strong><small>EPSS ≥ 50%</small></div>
            </section>

            <section className="cve-source-strip" aria-label="Source freshness">
              {sources.map((source) => {
                const state = freshness(source);
                return <div key={source.id} data-state={state.state}>
                  <span className="cve-source-dot" />
                  <div><strong>{source.displayName}</strong><small>{source.activeRun ? `${state.label} · ${source.activeRun.itemsSeen.toLocaleString()} indexed · since ${date(source.activeRun.startedAt, true)}` : `${state.label} · ${source.lastSuccessAt ? date(source.lastSuccessAt, true) : source.id === "osv" ? "queried per scan" : "waiting for first sync"}`}</small>{state.state === "error" && source.lastError ? <em title={source.lastError}>{source.lastError}</em> : null}</div>
                  {source.id !== "osv" ? <button className="cve-icon-btn" type="button" title={source.activeRun ? `${source.displayName} refresh is in progress` : `Refresh ${source.displayName}`} aria-label={`Refresh ${source.displayName}`} disabled={refreshing[source.id] || Boolean(source.activeRun)} onClick={() => void refreshSource(source.id)}><ArrowsClockwise size={15} className={refreshing[source.id] || source.activeRun ? "is-spinning" : ""} /></button> : null}
                </div>;
              })}
              {sources.length === 0 ? <div className="cve-source-empty"><Clock size={15} /> Sources initialize automatically after startup</div> : null}
            </section>

            <section className="cve-panel">
              <div className="cve-toolbar">
                <form className="cve-search" onSubmit={(event) => { event.preventDefault(); setParam("search", searchDraft.trim() || null); }}>
                  <MagnifyingGlass size={15} /><input aria-label="Search CVEs" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="CVE ID, package, or summary" /><button type="submit">Search</button>
                </form>
                <div className="cve-filter-label"><Funnel size={14} /> Filters</div>
                <select aria-label="Severity" value={severity} onChange={(event) => setParam("severity", event.target.value || null)}><option value="">Any severity</option>{SEVERITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
                <select aria-label="Minimum CVSS" value={minCvss} onChange={(event) => setParam("minCvss", event.target.value || null)}><option value="">Any CVSS</option><option value="9">9.0+</option><option value="7">7.0+</option><option value="4">4.0+</option></select>
                <select aria-label="Minimum EPSS" value={minEpss} onChange={(event) => setParam("minEpss", event.target.value || null)}><option value="">Any EPSS</option><option value="0.5">50%+</option><option value="0.1">10%+</option><option value="0.01">1%+</option></select>
                <select aria-label="Ecosystem" value={ecosystem} onChange={(event) => setParam("ecosystem", event.target.value || null)}><option value="">Any ecosystem</option>{ECOSYSTEMS.map((value) => <option key={value} value={value}>{value}</option>)}</select>
                <select aria-label="Modified window" value={days} onChange={(event) => setParam("days", event.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="120">120 days</option><option value="365">1 year</option><option value="3650">All indexed</option></select>
                <label className="cve-check"><input type="checkbox" checked={kev} onChange={(event) => setParam("kev", event.target.checked ? "true" : null)} /> KEV only</label>
              </div>
              {catalogError ? <div className="cve-alert" role="alert"><Warning size={16} /> {catalogError}</div> : null}
              <div className="cve-table-wrap">
                <table className="cve-table">
                  <thead><tr><th>CVE</th><th>Severity</th><th>CVSS</th><th>EPSS</th><th>Exploited</th><th>Summary</th><th>Modified</th></tr></thead>
                  <tbody>
                    {rows.map((row) => <tr key={row.cveId} data-withdrawn={Boolean(row.withdrawnAt)} onClick={() => setParam("cve", row.cveId)}>
                      <td><button className="cve-link" type="button">{row.cveId}</button>{row.withdrawnAt ? <small>withdrawn</small> : null}</td>
                      <td><span className="cve-severity" data-severity={row.severity ?? "none"}>{row.severity ?? "unrated"}</span></td>
                      <td className="cve-mono">{row.cvssScore?.toFixed(1) ?? "—"}</td>
                      <td className="cve-mono">{percent(row.epssScore)}</td>
                      <td>{row.kev ? <span className="cve-kev"><Warning weight="fill" size={12} /> KEV</span> : <span className="cve-muted">—</span>}</td>
                      <td><span className="cve-summary">{row.summary || "No description available"}</span></td>
                      <td className="cve-nowrap">{date(row.modifiedAt)}</td>
                    </tr>)}
                    {!catalogBusy && rows.length === 0 ? <tr><td colSpan={7}><div className="cve-empty"><Database size={21} /> No CVEs match these filters.</div></td></tr> : null}
                    {catalogBusy ? <tr><td colSpan={7}><div className="cve-empty"><ArrowsClockwise className="is-spinning" size={20} /> Loading current catalog…</div></td></tr> : null}
                  </tbody>
                </table>
              </div>
              <footer className="cve-pagination"><span>{total === 0 ? "0 results" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total.toLocaleString()}`}</span><div><button type="button" disabled={offset === 0} onClick={() => setParam("offset", String(Math.max(0, offset - PAGE_SIZE)))}>Previous</button><button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => setParam("offset", String(offset + PAGE_SIZE))}>Next</button></div></footer>
            </section>
          </>
        ) : (
          <div className="cve-exposure-grid">
            <section className="cve-panel cve-scan-card">
              <header><div><span className="cve-eyebrow">Repository inventory</span><h2>Scan exact dependency versions</h2><p>Upload a supported lockfile or CycloneDX SBOM. BrainRouter verifies current repository access before OSV matching.</p></div><FileArrowUp size={26} /></header>
              <label>Repository<input list="cve-repositories" value={scanRepo} onChange={(event) => setScanRepo(event.target.value)} placeholder="owner/repository" /></label>
              <datalist id="cve-repositories">{repos.map((repo) => <option key={repo.fullName} value={repo.fullName} />)}</datalist>
              <button className="cve-dropzone" type="button" onClick={() => fileRef.current?.click()}><FileArrowUp size={20} /><strong>{scanFiles.length > 0 ? `${scanFiles.length} file${scanFiles.length === 1 ? "" : "s"} selected` : "Choose lockfiles or an SBOM"}</strong><span>npm · Python · Go · Rust · Ruby · PHP · Gradle · CycloneDX · 8 MB each</span></button>
              <input ref={fileRef} className="cve-file-input" type="file" multiple accept=".json,.txt,.lock,.sum,.yaml,.yml" onChange={(event) => void readFiles(event.target.files)} />
              {scanFiles.length > 0 ? <div className="cve-file-list">{scanFiles.map((file) => <span key={file.path}>{file.path}<small>{Math.max(1, Math.round(file.bytes / 1024))} KB</small></span>)}</div> : null}
              {scanError ? <div className="cve-alert" role="alert"><Warning size={16} /> {scanError}</div> : null}
              <div className="cve-scan-actions"><button className="premium-button premium-button--primary" type="button" disabled={scanBusy || !scanRepo.trim() || scanFiles.length === 0} onClick={() => void runScan()}>{scanBusy ? <ArrowsClockwise className="is-spinning" size={15} /> : <ShieldCheck size={15} />} {scanBusy ? "Queueing…" : "Scan repository"}</button><button className="premium-button premium-button--ghost" type="button" disabled={!scanRepo.trim()} onClick={() => void toggleWatch()}><Bell size={15} /> {watched ? "Stop watching" : "Watch for future CVEs"}</button></div>
            </section>

            <section className="cve-exposure-stats">
              <div><span>Open findings</span><strong>{findings.filter((finding) => finding.status === "open").length}</strong></div>
              <div><span>Watched repositories</span><strong>{watches.length}</strong></div>
              <div><span>Scans running</span><strong>{scans.filter((scan) => scan.status === "running").length}</strong></div>
            </section>

            <section className="cve-panel cve-exposure-findings">
              <header className="cve-panel-head"><div><span className="cve-eyebrow">Exact evidence</span><h2>Repository findings</h2></div><button className="cve-icon-btn" type="button" title="Refresh findings" aria-label="Refresh findings" onClick={() => void loadExposure()}><ArrowsClockwise size={15} /></button></header>
              <div className="cve-table-wrap"><table className="cve-table"><thead><tr><th>Repository</th><th>CVE</th><th>Exact component</th><th>Affected range</th><th>Evidence</th><th>Status</th><th /></tr></thead><tbody>
                {findings.map((finding) => <tr key={finding.id} data-withdrawn={finding.status === "dismissed"}>
                  <td>{finding.repo}</td><td><button className="cve-link" type="button" onClick={() => setParam("cve", finding.cveId)}>{finding.cveId}</button></td>
                  <td><strong>{finding.ecosystem}/{finding.packageName}@{finding.installedVersion}</strong><small className="cve-cell-detail">{finding.purl}</small></td>
                  <td>{finding.fixed ? <><span>before {finding.fixed}</span><small className="cve-cell-detail">Fix available</small></> : <span className="cve-muted">No fixed version reported</span>}</td>
                  <td><span>{finding.evidence}</span></td><td><span className="cve-status" data-state={finding.status}>{finding.status}</span></td>
                  <td><button className="cve-row-action" type="button" onClick={() => void dismiss(finding.id, finding.status === "dismissed" ? "open" : "dismissed")}>{finding.status === "dismissed" ? "Reopen" : "Dismiss"}</button></td>
                </tr>)}
                {!exposureBusy && findings.length === 0 ? <tr><td colSpan={7}><div className="cve-empty"><CheckCircle size={21} /> No exact repository exposures recorded. This is not a guarantee of absence.</div></td></tr> : null}
              </tbody></table></div>
            </section>

            <section className="cve-panel cve-scan-history">
              <header className="cve-panel-head"><div><span className="cve-eyebrow">Activity</span><h2>Scan history</h2></div></header>
              <div className="cve-scan-list">{scans.map((scan) => <div key={scan.id}><span className="cve-scan-icon" data-state={scan.status}>{scan.status === "succeeded" ? <CheckCircle size={16} /> : scan.status === "failed" ? <Warning size={16} /> : <ArrowsClockwise className="is-spinning" size={16} />}</span><div><strong>{scan.repo}</strong><small>{date(scan.startedAt, true)} · {scan.componentsSeen} components · {scan.matchesFound} matches{scan.truncated ? " · partial" : ""}</small>{scan.error ? <em>{scan.error}</em> : null}</div><span className="cve-status" data-state={scan.status}>{scan.status}</span></div>)}{!exposureBusy && scans.length === 0 ? <div className="cve-empty"><Clock size={20} /> No scans yet.</div> : null}</div>
            </section>
          </div>
        )}

        {selectedCve ? <div className="cve-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setParam("cve", null); }}><aside className="cve-drawer" aria-label={`${selectedCve} details`}><header><div><span className="cve-eyebrow">Vulnerability detail</span><h2>{selectedCve}</h2></div><button className="cve-icon-btn" type="button" aria-label="Close details" onClick={() => setParam("cve", null)}><X size={16} /></button></header>{detailBusy ? <div className="cve-empty"><ArrowsClockwise className="is-spinning" size={20} /> Loading provenance…</div> : detail ? <div className="cve-drawer-body"><div className="cve-detail-badges"><span className="cve-severity" data-severity={detail.severity ?? "none"}>{detail.severity ?? "unrated"}</span>{detail.kev ? <span className="cve-kev"><Warning weight="fill" size={12} /> Known exploited</span> : null}{detail.withdrawnAt ? <span className="cve-status" data-state="withdrawn">withdrawn</span> : null}</div><p className="cve-detail-summary">{detail.summary || "No description available."}</p><dl className="cve-detail-metrics"><div><dt>CVSS</dt><dd>{detail.cvssScore?.toFixed(1) ?? "—"}</dd><small>{detail.cvssVector ?? "No vector"}</small></div><div><dt>EPSS</dt><dd>{percent(detail.epssScore)}</dd><small>{detail.epssPercentile == null ? "No percentile" : `${percent(detail.epssPercentile)} percentile`}</small></div><div><dt>Published</dt><dd>{date(detail.publishedAt)}</dd><small>Modified {date(detail.modifiedAt)}</small></div></dl><section><h3>Provenance</h3><div className="cve-source-tags">{detail.sources.map((source) => <span key={source}>{source}</span>)}</div></section><section><h3>Affected packages and fixed versions</h3>{detail.ranges.length > 0 ? <div className="cve-range-list">{detail.ranges.map((range, index) => <div key={`${range.source_id}-${range.ecosystem}-${range.package_name}-${index}`}><strong>{range.ecosystem}/{range.package_name}</strong><span>{range.introduced ? `Introduced ${range.introduced}` : "Introduced unknown"}{range.fixed ? ` · Fixed ${range.fixed}` : range.last_affected ? ` · Last affected ${range.last_affected}` : " · No fix reported"}</span><small>{range.source_id}{range.purl ? ` · ${range.purl}` : ""}</small></div>)}</div> : <p className="cve-muted">No exact package ranges are stored for this catalog entry. Do not infer repository exposure from its name.</p>}</section><section><h3>References</h3><div className="cve-reference-list">{detail.references.slice(0, 12).map((reference) => <a key={reference.url} href={reference.url} target="_blank" rel="noreferrer">{reference.kind || "reference"}<span>{reference.url}</span></a>)}</div></section></div> : <div className="cve-empty"><Warning size={20} /> CVE detail is unavailable.</div>}</aside></div> : null}
      </main>
    </AuthGuard>
  );
}
