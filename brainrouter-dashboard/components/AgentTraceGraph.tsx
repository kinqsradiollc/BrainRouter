"use client";

import { useMemo, useState } from "react";
import type { ReviewJob } from "../lib/adminApi";
import { StatusBadge } from "./Analytics";
import { PremiumCard } from "./PremiumCard";
import { buildAgentTrace, type AgentTraceNode, type AgentTraceStatus } from "../app/reviews/agentTrace";
import styles from "./agentTraceGraph.module.css";

function tone(status: AgentTraceStatus): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "failed") return "danger";
  if (status === "running") return "info";
  if (status === "succeeded") return "ok";
  if (status === "skipped") return "warn";
  return "neutral";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function NodeButton({ node, selected, onSelect }: { node: AgentTraceNode; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.node} ${styles[node.status]} ${node.kind === "agent" ? styles.agent : ""} ${selected ? styles.selected : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={styles.statusDot} aria-hidden />
      <span><strong>{node.label}</strong><small>{node.description}</small></span>
    </button>
  );
}

export function AgentTraceGraph({ reviews, title = "Agent Trace" }: { reviews: ReviewJob[]; title?: string }) {
  const trace = useMemo(() => buildAgentTrace(reviews), [reviews]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = trace.nodes.find((node) => node.id === selectedId) ?? trace.nodes[0] ?? null;

  return (
    <PremiumCard level={2} className={styles.card}>
      <div className="settings-cardhead">
        <div><h3>{title}</h3><div className="settings-hint">Durable review phases, dependencies, and live status</div></div>
        {trace.roots.length > 0 && <span className="settings-badge settings-badge--muted">{trace.roots.length} agent{trace.roots.length === 1 ? "" : "s"}</span>}
      </div>
      {!trace.nodes.length ? <div className="settings-empty-inline">Run a review to see its agent trace.</div> : (
        <div className={styles.layout}>
          <div className={styles.graph} role="tree" aria-label="Review agent execution trace">
            {trace.roots.map((rootId) => {
              const root = trace.nodes.find((node) => node.id === rootId);
              if (!root) return null;
              const phases = trace.nodes.filter((node) => node.parentId === rootId);
              return (
                <section className={styles.branch} key={rootId} role="treeitem" aria-label={`${root.label}: ${root.status}`}>
                  <NodeButton node={root} selected={selected?.id === root.id} onSelect={() => setSelectedId(root.id)} />
                  {phases.length > 0 && <div className={styles.connector} aria-hidden />}
                  <div className={styles.phases} role="group">
                    {phases.map((phase, index) => (
                      <div className={styles.phase} key={phase.id} role="treeitem" aria-label={`${phase.label}: ${phase.status}`}>
                        {index > 0 && <span className={styles.phaseConnector} aria-hidden />}
                        <NodeButton node={phase} selected={selected?.id === phase.id} onSelect={() => setSelectedId(phase.id)} />
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          {selected && (
            <aside className={styles.details} aria-live="polite">
              <div className={styles.detailsHead}><strong>{selected.label}</strong><StatusBadge tone={tone(selected.status)}>{selected.status}</StatusBadge></div>
              <p>{selected.description}</p>
              <dl>
                <div><dt>Started</dt><dd>{formatTime(selected.startedAt)}</dd></div>
                <div><dt>Finished</dt><dd>{formatTime(selected.endedAt)}</dd></div>
                <div><dt>Duration</dt><dd>{formatDuration(selected.durationMs)}</dd></div>
                {Object.entries(selected.metrics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
              </dl>
            </aside>
          )}
        </div>
      )}
    </PremiumCard>
  );
}
