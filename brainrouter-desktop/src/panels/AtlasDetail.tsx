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
import { atlasNodeColor, atlasNodeFacts } from "../lib/atlas/atlasView.js";
import { Icon } from "../icons.js";

export interface AtlasDetailProps {
  graph: AtlasGraph;
  nodeId: string;
  onClose: () => void;
}

export function AtlasDetail({ graph, nodeId, onClose }: AtlasDetailProps): React.ReactElement | null {
  const facts = atlasNodeFacts(graph, nodeId);
  if (!facts) return null;
  const { node, symbols, layer, importsOut, importsIn } = facts;
  const color = atlasNodeColor(node.type);

  return (
    <div className="atlas-detail">
      <div className="atlas-detail-head">
        <span className="atlas-detail-dot" style={{ background: color }} />
        <span className="atlas-detail-name" title={node.filePath ?? node.name}>{node.name}</span>
        <button className="atlas-detail-x" aria-label="Close detail" title="Close" onClick={onClose}>
          <Icon name="close" size={11} />
        </button>
      </div>

      {node.filePath ? <div className="atlas-detail-path">{node.filePath}</div> : null}

      <div className="atlas-detail-meta">
        <span className="atlas-meta-pill atlas-meta-type" style={{ borderColor: color, color }}>{node.type}</span>
        {node.language ? <span className="atlas-meta-pill">{node.language}</span> : null}
        {node.complexity ? <span className={`atlas-meta-pill cx-${node.complexity}`}>{node.complexity}</span> : null}
        {layer ? <span className="atlas-meta-pill">{layer.name}</span> : null}
      </div>

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
            {symbols.slice(0, 40).map((s) => (
              <li key={s.id}>
                <span className={`atlas-sym-kind ${s.type}`}>{s.type === "class" ? "cls" : "fn"}</span>
                <span className="atlas-sym-name">{s.name}</span>
                {s.lineRange ? <span className="atlas-sym-line">:{s.lineRange[0]}</span> : null}
              </li>
            ))}
            {symbols.length > 40 ? <li className="dim">+{symbols.length - 40} more</li> : null}
          </ul>
        </div>
      ) : null}

      {importsOut.length || importsIn.length ? (
        <div className="atlas-detail-deps">
          {importsOut.length ? <span title={importsOut.join("\n")}>imports {importsOut.length}</span> : null}
          {importsIn.length ? <span title={importsIn.join("\n")}>imported by {importsIn.length}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
