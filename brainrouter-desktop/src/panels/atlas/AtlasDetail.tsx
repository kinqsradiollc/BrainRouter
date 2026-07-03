/**
 * Atlas node detail card (ATLAS-6).
 *
 * A floating card over the graph canvas that shows everything known about the
 * selected node: type, path, language/complexity, its layer, the enrichment
 * summary + tags, the symbols it defines, and its import neighbours. Pure
 * presentation over {@link atlasNodeFacts}; opening a file at a symbol's line
 * (Monaco) lands in a later slice.
 */
import React from "react";
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { atlasNodeColor, atlasNodeFacts, atlasImpact } from "../../lib/atlas/atlasView.js";
import { Icon } from "../../icons.js";

export interface AtlasDetailProps {
  graph: AtlasGraph;
  nodeId: string;
  onClose: () => void;
  /** Open this node's file in the editor, optionally at a specific line. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Review overlay: this node's git change kind, if any. */
  changeKind?: "added" | "modified" | "untracked" | "deleted";
  /** Whether this node's blast radius is currently highlighted. */
  impactActive?: boolean;
  /** Toggle the blast-radius highlight for this node. */
  onShowImpact?: (nodeId: string) => void;
  /** ATLAS-14 — LLM assessment of this file's uncommitted change, if fetched. */
  assessment?: { summary: string; risk: "low" | "medium" | "high"; checklist: string[]; concerns: string[] };
  /** True while the assessment is being fetched. */
  assessing?: boolean;
  /** Request an LLM assessment of this change. */
  onAssess?: () => void;
  /** ATLAS-15 — true when no test covers this file. */
  untested?: boolean;
}

const CHANGE_LABEL: Record<string, string> = { added: "Added", modified: "Modified", untracked: "New (untracked)", deleted: "Deleted" };

export function AtlasDetail({ graph, nodeId, onClose, onOpenFile, changeKind, impactActive, onShowImpact, assessment, assessing, onAssess, untested }: AtlasDetailProps): React.ReactElement | null {
  const facts = atlasNodeFacts(graph, nodeId);
  if (!facts) return null;
  const { node, symbols, layer, importsOut, importsIn } = facts;
  const color = atlasNodeColor(node.type);
  const canOpen = !!(onOpenFile && node.filePath);
  const impact = node.filePath ? atlasImpact(graph, nodeId) : null;

  return (
    <div className="atlas-detail">
      <div className="atlas-detail-head">
        <span className="atlas-detail-dot" style={{ background: color }} />
        <span className="atlas-detail-name" title={node.filePath ?? node.name}>{node.name}</span>
        <button className="atlas-detail-x" aria-label="Close detail" title="Close" onClick={onClose}>
          <Icon name="close" size={11} />
        </button>
      </div>

      {node.filePath ? (
        canOpen ? (
          <button className="atlas-detail-path atlas-detail-path-open" title="Open in editor" onClick={() => onOpenFile!(node.filePath as string)}>
            <Icon name="code" size={11} />
            <span>{node.filePath}</span>
          </button>
        ) : (
          <div className="atlas-detail-path">{node.filePath}</div>
        )
      ) : null}

      <div className="atlas-detail-meta">
        <span className="atlas-meta-pill atlas-meta-type" style={{ borderColor: color, color }}>{node.type}</span>
        {node.language ? <span className="atlas-meta-pill">{node.language}</span> : null}
        {node.complexity ? <span className={`atlas-meta-pill cx-${node.complexity}`}>{node.complexity}</span> : null}
        {layer ? <span className="atlas-meta-pill">{layer.name}</span> : null}
      </div>

      {changeKind ? (
        <div className={`atlas-detail-change chg-${changeKind}`}>
          <span className="atlas-detail-change-dot" />
          {CHANGE_LABEL[changeKind] ?? changeKind} · uncommitted — review before commit
        </div>
      ) : null}

      {untested && node.filePath ? (
        <div className="atlas-detail-untested" title="No test file imports this or shares its name">
          <span className="atlas-detail-change-dot" /> No test covers this file
        </div>
      ) : null}

      {changeKind && onAssess ? (
        <div className="atlas-assess">
          {assessment ? (
            <>
              <div className="atlas-assess-head">
                <span className="atlas-assess-title">AI assessment</span>
                <span className={`atlas-assess-risk risk-${assessment.risk}`}>{assessment.risk} risk</span>
              </div>
              {assessment.summary ? <div className="atlas-assess-summary">{assessment.summary}</div> : null}
              {assessment.concerns.length ? (
                <div className="atlas-assess-block">
                  <div className="atlas-assess-label warn">Concerns</div>
                  <ul className="atlas-assess-list">{assessment.concerns.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              ) : null}
              {assessment.checklist.length ? (
                <div className="atlas-assess-block">
                  <div className="atlas-assess-label">Review checklist</div>
                  <ul className="atlas-assess-list check">{assessment.checklist.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              ) : null}
              <button className="atlas-assess-btn" disabled={assessing} onClick={onAssess}>{assessing ? "Re-assessing…" : "Re-assess"}</button>
            </>
          ) : (
            <button className="atlas-assess-btn primary" disabled={assessing} onClick={onAssess}>
              <Icon name="diff" size={11} />{assessing ? "Assessing change…" : "Assess this change"}
            </button>
          )}
        </div>
      ) : null}

      {node.summary
        ? <div className="atlas-detail-summary">{node.summary}</div>
        : <div className="atlas-detail-summary dim">No summary yet — run Enrich.</div>}

      {node.tags?.length ? (
        <div className="atlas-detail-tags">{node.tags.map((t) => <span key={t} className="atlas-tag">{t}</span>)}</div>
      ) : null}

      {symbols.length ? (
        <div className="atlas-detail-section">
          <div className="atlas-detail-label">Symbols · {symbols.length}</div>
          <ul className="atlas-detail-syms">
            {symbols.slice(0, 40).map((s) => {
              const line = s.lineRange?.[0];
              const jump = canOpen && line ? () => onOpenFile!(node.filePath as string, line) : undefined;
              return (
                <li key={s.id} className={jump ? "atlas-sym jump" : "atlas-sym"} onClick={jump} title={jump ? `Open ${node.name}:${line}` : undefined}>
                  <span className={`atlas-sym-kind ${s.type}`}>{s.type === "class" ? "cls" : "fn"}</span>
                  <span className="atlas-sym-name">{s.name}</span>
                  {line ? <span className="atlas-sym-line">:{line}</span> : null}
                </li>
              );
            })}
            {symbols.length > 40 ? <li className="dim">+{symbols.length - 40} more</li> : null}
          </ul>
        </div>
      ) : null}

      {impact ? (
        <div className="atlas-detail-impact">
          <div className="atlas-detail-deps">
            <span title={importsOut.join("\n")}>imports {importsOut.length}</span>
            <span title={importsIn.join("\n")}>used by {importsIn.length}</span>
            <span className="atlas-impact-reach" title="Files that import this directly or transitively">affects {impact.dependents.length} downstream</span>
          </div>
          {impact.dependents.length && onShowImpact ? (
            <button className={`atlas-impact-btn${impactActive ? " on" : ""}`} onClick={() => onShowImpact(nodeId)}>
              <Icon name="branch" size={11} />{impactActive ? "Hide blast radius" : "Show blast radius"}
            </button>
          ) : null}
          {impactActive && impact.byLayer.length ? (
            <div className="atlas-impact-layers">
              {impact.byLayer.slice(0, 6).map((l) => <span key={l.layer} className="atlas-impact-chip">{l.layer} · {l.count}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
