"use client";

/**
 * CVE intelligence (spec §8.2/§10, Task 31) — two tabs:
 *  - Catalog: the global CVE feed with search/severity/CVSS/EPSS/KEV/ecosystem
 *    filters (server-paginated, URL-addressable) + source freshness.
 *  - My exposure: this organization's exact-evidence findings (component,
 *    installed version, fixed version, file evidence) + a manual scan that
 *    accepts lockfile/manifest/SBOM contents. A catalog entry alone is never
 *    an exposure — only matches with version evidence appear here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { authFetch } from "../../lib/adminApi";

interface CatalogRow {
  cveId: string; summary: string; severity: string | null; cvssScore: number | null;
  epssScore: number | null; kev: boolean; modifiedAt: string | null; withdrawnAt: string | null;
}
interface SourceRow { id: string; displayName: string; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null }
interface FindingRow {
  id: string; repo: string; cveId: string; packageName: string; installedVersion: string;
  fixed: string | null; evidence: string; status: string; lastSeenAt: string;
}
interface ScanRow { id: string; repo: string; status: string; componentsSeen: number; matchesFound: number; startedAt: string; error: string | null }

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function severityTone(severity: string | null): string {
  if (severity === "critical") return "var(--danger, #e5484d)";
  if (severity === "high") return "#e08a38";
  if (severity === "medium") return "#d3b53d";
  return "var(--text-muted, #8b8b93)";
}

export default function VulnerabilitiesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("tab") === "exposure" ? "exposure" : "catalog";

  // --- Catalog state (filters are URL-addressable) ---
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const search = params.get("search") ?? "";
  const severity = params.get("severity") ?? "";
  const kev = params.get("kev") === "true";
  const offset = Number(params.get("offset") ?? 0) || 0;

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key); else next.set(key, value);
    if (key !== "offset") next.delete("offset");
    router.replace(`/vulnerabilities?${next.toString()}`);
  }, [params, router]);

  const loadCatalog = useCallback(async () => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    if (severity) query.set("severity", severity);
    if (kev) query.set("kev", "true");
    query.set("limit", "50");
    query.set("offset", String(offset));
    try {
      const result = await authFetch<{ items: CatalogRow[]; total: number }>(`/api/vulnerabilities?${query.toString()}`);
      setRows(result.items);
      setTotal(result.total);
    } catch { setRows([]); setTotal(0); }
    try {
      const result = await authFetch<{ sources: SourceRow[] }>("/api/vulnerabilities/sources");
      setSources(result.sources);
    } catch { setSources([]); }
  }, [search, severity, kev, offset]);

  // --- Exposure state ---
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [scanRepo, setScanRepo] = useState("");
  const [scanFileName, setScanFileName] = useState("package-lock.json");
  const [scanContent, setScanContent] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");

  const loadExposure = useCallback(async () => {
    try {
      const result = await authFetch<{ findings: FindingRow[] }>("/api/vulnerabilities/findings");
      setFindings(result.findings);
    } catch { setFindings([]); }
    try {
      const result = await authFetch<{ scans: ScanRow[] }>("/api/vulnerabilities/scans");
      setScans(result.scans);
    } catch { setScans([]); }
  }, []);

  useEffect(() => { void (tab === "catalog" ? loadCatalog() : loadExposure()); }, [tab, loadCatalog, loadExposure]);

  const runScan = useCallback(async () => {
    if (!scanRepo.trim() || !scanContent.trim()) return;
    setScanBusy(true); setScanError("");
    try {
      await authFetch("/api/vulnerabilities/scans", {
        method: "POST",
        body: { repo: scanRepo.trim(), files: [{ path: scanFileName, content: scanContent }] },
      });
      setScanContent("");
      await loadExposure();
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Scan failed");
    } finally { setScanBusy(false); }
  }, [scanRepo, scanFileName, scanContent, loadExposure]);

  const dismiss = useCallback(async (id: string, status: "open" | "dismissed") => {
    try {
      await authFetch(`/api/vulnerabilities/findings/${id}`, { method: "PATCH", body: { status, reason: status === "dismissed" ? "triaged in dashboard" : undefined } });
      await loadExposure();
    } catch { /* keep the row; a failed PATCH surfaces on refresh */ }
  }, [loadExposure]);

  const refreshSource = useCallback(async (id: string) => {
    try { await authFetch(`/api/vulnerabilities/sources/${id}/refresh`, { method: "POST" }); await loadCatalog(); } catch { /* freshness row shows the error */ }
  }, [loadCatalog]);

  const freshness = useMemo(() => sources.map((s) => (
    <span key={s.id} className="settings-hint" style={{ marginRight: 14 }}>
      {s.displayName}: {s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : "never"}
      {s.consecutiveFailures > 0 ? ` · ${s.consecutiveFailures} failures` : ""}
      <button type="button" className="settings-link" style={{ marginLeft: 6 }} onClick={() => void refreshSource(s.id)}>refresh</button>
    </span>
  )), [sources, refreshSource]);

  return (
    <AuthGuard>
      <PageHeader title="CVE intelligence" description="Defensive inventory and prioritization. A catalog entry is not proof of exposure — findings require exact package and version evidence." />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["catalog", "exposure"] as const).map((key) => (
          <button key={key} type="button" className="settings-link" aria-pressed={tab === key}
            style={{ fontWeight: tab === key ? 700 : 400 }} onClick={() => setParam("tab", key === "catalog" ? null : key)}>
            {key === "catalog" ? "Catalog" : "My exposure"}
          </button>
        ))}
      </div>

      {tab === "catalog" ? (
        <section>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input aria-label="Search CVEs" placeholder="Search CVE id or summary" defaultValue={search}
              onKeyDown={(e) => { if (e.key === "Enter") setParam("search", (e.target as HTMLInputElement).value); }} />
            <select aria-label="Severity" value={severity} onChange={(e) => setParam("severity", e.target.value || null)}>
              <option value="">Any severity</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={kev} onChange={(e) => setParam("kev", e.target.checked ? "true" : null)} /> KEV only
            </label>
          </div>
          <div style={{ marginBottom: 10 }}>{freshness}</div>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th align="left">CVE</th><th align="left">Severity</th><th align="left">CVSS</th><th align="left">EPSS</th><th align="left">KEV</th><th align="left">Summary</th><th align="left">Modified</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.cveId} style={{ opacity: row.withdrawnAt ? 0.5 : 1 }}>
                  <td style={{ whiteSpace: "nowrap", fontFamily: "monospace" }}>{row.cveId}{row.withdrawnAt ? " (withdrawn)" : ""}</td>
                  <td style={{ color: severityTone(row.severity) }}>{row.severity ?? "—"}</td>
                  <td>{row.cvssScore ?? "—"}</td>
                  <td>{row.epssScore != null ? row.epssScore.toFixed(3) : "—"}</td>
                  <td>{row.kev ? "●" : ""}</td>
                  <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.summary}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{row.modifiedAt ? row.modifiedAt.slice(0, 10) : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={7} className="settings-hint">No catalog entries. Refresh a source above to ingest.</td></tr> : null}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <button type="button" disabled={offset <= 0} onClick={() => setParam("offset", String(Math.max(offset - 50, 0)))}>Previous</button>
            <span className="settings-hint">{total === 0 ? "0" : `${offset + 1}–${Math.min(offset + 50, total)} of ${total}`}</span>
            <button type="button" disabled={offset + 50 >= total} onClick={() => setParam("offset", String(offset + 50))}>Next</button>
          </div>
        </section>
      ) : (
        <section style={{ display: "grid", gap: 18 }}>
          <div>
            <h3 style={{ margin: "0 0 8px" }}>Manual scan</h3>
            <p className="settings-hint" style={{ margin: "0 0 8px" }}>Paste a lockfile, requirements.txt, or CycloneDX SBOM — only exact pinned versions become evidence.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <input aria-label="Repository" placeholder="owner/repo" value={scanRepo} onChange={(e) => setScanRepo(e.target.value)} />
              <select aria-label="File type" value={scanFileName} onChange={(e) => setScanFileName(e.target.value)}>
                <option value="package-lock.json">package-lock.json</option>
                <option value="requirements.txt">requirements.txt</option>
                <option value="bom.json">CycloneDX bom.json</option>
              </select>
              <button type="button" disabled={scanBusy || !scanRepo.trim() || !scanContent.trim()} onClick={() => void runScan()}>
                {scanBusy ? "Scanning…" : "Run scan"}
              </button>
            </div>
            <textarea aria-label="File contents" value={scanContent} onChange={(e) => setScanContent(e.target.value)}
              placeholder="File contents" style={{ width: "100%", minHeight: 120, fontFamily: "monospace", fontSize: 12 }} />
            {scanError ? <p role="alert" style={{ color: "var(--danger, #e5484d)" }}>{scanError}</p> : null}
          </div>

          <div>
            <h3 style={{ margin: "0 0 8px" }}>Findings</h3>
            <table style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th align="left">Repository</th><th align="left">CVE</th><th align="left">Component</th><th align="left">Installed</th><th align="left">Fixed in</th><th align="left">Evidence</th><th align="left">Status</th><th /></tr></thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.id} style={{ opacity: finding.status === "dismissed" ? 0.55 : 1 }}>
                    <td>{finding.repo}</td>
                    <td style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{finding.cveId}</td>
                    <td>{finding.packageName}</td>
                    <td>{finding.installedVersion}</td>
                    <td>{finding.fixed ?? "—"}</td>
                    <td className="settings-hint">{finding.evidence}</td>
                    <td>{finding.status}</td>
                    <td>
                      {finding.status === "dismissed"
                        ? <button type="button" onClick={() => void dismiss(finding.id, "open")}>Reopen</button>
                        : <button type="button" onClick={() => void dismiss(finding.id, "dismissed")}>Dismiss</button>}
                    </td>
                  </tr>
                ))}
                {findings.length === 0 ? <tr><td colSpan={8} className="settings-hint">No findings. Run a scan above — exposure always requires exact component and version evidence.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div>
            <h3 style={{ margin: "0 0 8px" }}>Scan history</h3>
            <table style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th align="left">Repository</th><th align="left">Status</th><th align="left">Components</th><th align="left">Matches</th><th align="left">Started</th></tr></thead>
              <tbody>
                {scans.map((scan) => (
                  <tr key={scan.id}>
                    <td>{scan.repo}</td>
                    <td>{scan.status}{scan.error ? ` — ${scan.error}` : ""}</td>
                    <td>{scan.componentsSeen}</td>
                    <td>{scan.matchesFound}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(scan.startedAt).toLocaleString()}</td>
                  </tr>
                ))}
                {scans.length === 0 ? <tr><td colSpan={5} className="settings-hint">No scans yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AuthGuard>
  );
}
