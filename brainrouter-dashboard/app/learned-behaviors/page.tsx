"use client";

/**
 * ADR-032 Q4 — hosted learned-behaviour governance surface.
 *
 * Lists and reverts central-memory records and exposes a separate, explicit
 * human-correction action. The active organization is always pinned by the
 * authenticated client rather than accepted from correction form data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "../../components/Analytics";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumModal } from "../../components/PremiumModal";
import {
  learnedBehaviorsApi,
  upsertHostedLearnedBehavior,
  type HostedLearnedBehavior,
  type HostedHumanCorrectionInput,
  type LearnedBehaviorStatus,
} from "../../lib/learnedBehaviors";
import { HumanCorrectionForm } from "./HumanCorrectionForm";

const STATUS_OPTIONS: Array<{ value: "all" | LearnedBehaviorStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "demoted", label: "Demoted" },
  { value: "retired", label: "Retired" },
  { value: "reverted", label: "Reverted" },
];

function dateLabel(value: string | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function statusTone(status: LearnedBehaviorStatus): "ok" | "warn" | "danger" | "neutral" {
  if (status === "active") return "ok";
  if (status === "demoted") return "warn";
  if (status === "reverted") return "danger";
  return "neutral";
}

function Outcome({ item }: { item: HostedLearnedBehavior }) {
  const values = [
    ["Retrieved", item.outcome.retrievals],
    ["Confirmed", item.outcome.confirmations],
    ["Contradicted", item.outcome.contradictions],
  ] as const;
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px", margin: 0 }}>
      {values.map(([label, value]) => (
        <div key={label} style={{ padding: "10px", border: "1px solid var(--border-dim)", borderRadius: "8px", background: "var(--overlay-bg)" }}>
          <dt style={{ color: "var(--text-muted)", fontSize: "11px" }}>{label}</dt>
          <dd style={{ margin: "4px 0 0", color: "var(--text)", fontSize: "20px", fontWeight: 600 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LearnedCard({ item, onRevert }: { item: HostedLearnedBehavior; onRevert: (item: HostedLearnedBehavior) => void }) {
  const inactive = item.status === "reverted" || item.status === "retired";
  return (
    <PremiumCard level={2} style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
            <StatusBadge tone={statusTone(item.status)}>{item.status}</StatusBadge>
            <StatusBadge tone="info">{item.tier}</StatusBadge>
            <StatusBadge>{item.form}</StatusBadge>
            {item.provenance.sawUntrustedContent && <StatusBadge tone="warn">untrusted content present</StatusBadge>}
          </div>
          <h2 style={{ margin: 0, color: "var(--text)", fontSize: "17px", lineHeight: 1.45 }}>{item.statement}</h2>
          <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "12px" }}>
            Learned {dateLabel(item.provenance.capturedAt)} · {item.provenance.checkpoint.replace("-", " ")} · {item.origin.replace("-", " ")}
          </p>
        </div>
        <PremiumButton variant="danger" size="small" disabled={inactive} onClick={() => onRevert(item)}>
          {item.status === "reverted" ? "Reverted" : item.status === "retired" ? "Retired" : "Revert"}
        </PremiumButton>
      </div>

      <Outcome item={item} />

      <div style={{ display: "grid", gap: "10px", color: "var(--text-secondary)", fontSize: "13px" }}>
        <div><strong style={{ color: "var(--text)" }}>Expected improvement:</strong> {item.expectation || "Not recorded"}</div>
        <div><strong style={{ color: "var(--text)" }}>Wrong if:</strong> {item.falsifier || "Not recorded"}</div>
        {item.statusReason && <div><strong style={{ color: "var(--text)" }}>Current status:</strong> {item.statusReason}</div>}
        {item.skillId && <div><strong style={{ color: "var(--text)" }}>Runnable skill:</strong> <code>{item.skillId}</code></div>}
      </div>

      <details style={{ borderTop: "1px solid var(--border-dim)", paddingTop: "12px" }}>
        <summary style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: "13px" }}>Provenance and lifecycle</summary>
        <div style={{ display: "grid", gap: "9px", marginTop: "12px", color: "var(--text-muted)", fontSize: "12px", overflowWrap: "anywhere" }}>
          <div><strong style={{ color: "var(--text-secondary)" }}>Item:</strong> <code>{item.id}</code></div>
          <div><strong style={{ color: "var(--text-secondary)" }}>Session:</strong> <code>{item.provenance.sessionKey || "not recorded"}</code></div>
          <div><strong style={{ color: "var(--text-secondary)" }}>Gate:</strong> {item.provenance.gateReasoning || "not recorded"}</div>
          <div><strong style={{ color: "var(--text-secondary)" }}>Evidence:</strong> {item.provenance.evidence.length ? item.provenance.evidence.join(" · ") : "not recorded"}</div>
          <div><strong style={{ color: "var(--text-secondary)" }}>Central memory:</strong> {item.centralMemory.status}{item.centralMemory.archived ? " (archived)" : ""} · updated {dateLabel(item.centralMemory.updatedAt)}</div>
          <div><strong style={{ color: "var(--text-secondary)" }}>Lifecycle sync:</strong> {item.memoryLifecycle ? `${item.memoryLifecycle.status}, ${item.memoryLifecycle.attempts} attempt(s)` : "not reported"}</div>
          {item.memoryLifecycle?.lastError && <div style={{ color: "var(--danger)" }}><strong>Sync error:</strong> {item.memoryLifecycle.lastError}</div>}
          {item.allowedTools.length > 0 && <div><strong style={{ color: "var(--text-secondary)" }}>Allowed tools:</strong> {item.allowedTools.join(", ")}</div>}
        </div>
      </details>
    </PremiumCard>
  );
}

function LearnedBehaviorsContent() {
  const { activeOrg, activeOrgId, loading: orgLoading } = useActiveOrg();
  const [items, setItems] = useState<HostedLearnedBehavior[]>([]);
  const [filter, setFilter] = useState<"all" | LearnedBehaviorStatus>("all");
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [revertTarget, setRevertTarget] = useState<HostedLearnedBehavior | null>(null);
  const [reason, setReason] = useState("");
  const [reverting, setReverting] = useState(false);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionNotice, setCorrectionNotice] = useState("");
  const activeOrgIdRef = useRef(activeOrgId);
  const correctionRequestRef = useRef(false);
  activeOrgIdRef.current = activeOrgId;

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!activeOrgId) return;
    setLoading(true);
    setError("");
    try {
      const page = await learnedBehaviorsApi.list(activeOrgId, signal);
      if (signal?.aborted) return;
      setItems(page.items);
      setTruncated(page.truncated);
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Could not load learned behaviour");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setShowCorrection(false);
    setCorrectionError("");
    setCorrectionNotice("");
  }, [activeOrgId]);

  const visible = useMemo(
    () => filter === "all" ? items : items.filter((item) => item.status === filter),
    [filter, items],
  );
  const activeCount = useMemo(() => items.filter((item) => item.status === "active").length, [items]);

  async function confirmRevert() {
    if (!revertTarget || !activeOrgId || reason.trim().length < 3) return;
    setReverting(true);
    setError("");
    try {
      const result = await learnedBehaviorsApi.revert(activeOrgId, revertTarget.id, reason.trim());
      setItems((current) => current.map((item) => item.id === result.item.id ? result.item : item));
      setRevertTarget(null);
      setReason("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not revert learned behaviour");
    } finally {
      setReverting(false);
    }
  }

  async function recordCorrection(input: HostedHumanCorrectionInput): Promise<void> {
    if (!activeOrgId || correctionRequestRef.current) return;
    const targetOrgId = activeOrgId;
    correctionRequestRef.current = true;
    setCorrecting(true);
    setCorrectionError("");
    setCorrectionNotice("");
    try {
      const result = await learnedBehaviorsApi.correct(targetOrgId, input);
      if (activeOrgIdRef.current !== targetOrgId) return;
      setItems((current) => upsertHostedLearnedBehavior(current, result.item));
      setFilter("all");
      setShowCorrection(false);
      setCorrectionNotice(result.reinforced
        ? "The existing human correction was reinforced and moved to the top of the list."
        : "The human correction was recorded and added to the top of the list.");
    } catch (failure) {
      if (activeOrgIdRef.current === targetOrgId) {
        setCorrectionError(failure instanceof Error ? failure.message : "Could not record the human correction");
      }
    } finally {
      correctionRequestRef.current = false;
      setCorrecting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      <PageHeader
        title="Learned behavior"
        description="Inspect what BrainRouter changed about how it works, why it learned it, and whether the expected improvement held."
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="premium-button premium-button--primary premium-button--medium"
            aria-expanded={showCorrection}
            aria-controls="human-correction-form"
            disabled={!activeOrgId || orgLoading || correcting}
            onClick={() => {
              setShowCorrection((current) => !current);
              setCorrectionError("");
              setCorrectionNotice("");
            }}
          >
            {showCorrection ? "Close correction form" : "Record human correction"}
          </button>
          <select className="pill-input" aria-label="Filter learned behavior by status" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} style={{ minWidth: "160px" }}>
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </PageHeader>

      <div className="settings-note" style={{ margin: 0 }}>
        This page shows the active organization&apos;s <strong>hosted central-memory records only</strong>. It does not read a CLI or Desktop device ledger. A dashboard revert is applied centrally now; connected clients disable the matching local behavior at their next bounded learning checkpoint.
      </div>

      {showCorrection && activeOrgId && (
        <HumanCorrectionForm
          activeOrgName={activeOrg?.name || "the active organization"}
          busy={correcting}
          requestError={correctionError}
          onEdit={() => setCorrectionError("")}
          onCancel={() => { if (!correcting) { setShowCorrection(false); setCorrectionError(""); } }}
          onSubmit={recordCorrection}
        />
      )}

      {correctionNotice && <div role="status" aria-live="polite" className="settings-note" style={{ margin: 0 }}>{correctionNotice}</div>}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", color: "var(--text-muted)", fontSize: "13px" }}>
        <StatusBadge tone="ok">{activeCount} active</StatusBadge>
        <StatusBadge>{items.length} hosted total</StatusBadge>
        {truncated && <StatusBadge tone="warn">Newest 200 shown</StatusBadge>}
      </div>

      {error && <div className="settings-note settings-note--error">{error}</div>}

      {!loading && visible.length === 0 && (
        <EmptyState
          title={items.length ? "No learned behavior matches this filter" : "No hosted learned behavior yet"}
          description={items.length ? "Choose another status." : "Gated learning checkpoints will appear here after they write a tenant-scoped central memory record."}
        />
      )}
      {(loading || orgLoading) && <div className="settings-loading">Loading learned behavior…</div>}
      <div style={{ display: "grid", gap: "14px" }}>
        {visible.map((item) => <LearnedCard key={item.id} item={item} onRevert={(target) => { setRevertTarget(target); setReason(""); }} />)}
      </div>

      <PremiumModal isOpen={Boolean(revertTarget)} onClose={() => { if (!reverting) setRevertTarget(null); }} title="Revert learned behavior">
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "14px" }}>
            This archives the hosted record and tells connected clients to disable the matching local behavior. The reason is required and remains in the audit trail.
          </p>
          <label className="settings-label">
            Why is this behavior no longer valid?
            <textarea className="settings-textarea" rows={4} maxLength={400} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: the tool contract changed and this procedure now skips a required step." />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <PremiumButton variant="ghost" disabled={reverting} onClick={() => setRevertTarget(null)}>Cancel</PremiumButton>
            <PremiumButton variant="danger" disabled={reverting || reason.trim().length < 3} onClick={() => void confirmRevert()}>{reverting ? "Reverting…" : "Revert behavior"}</PremiumButton>
          </div>
        </div>
      </PremiumModal>
    </div>
  );
}

export default function LearnedBehaviorsPage() {
  return <AuthGuard><LearnedBehaviorsContent /></AuthGuard>;
}
