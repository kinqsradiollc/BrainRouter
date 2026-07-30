/**
 * Atlas custom React Flow nodes (ATLAS-10).
 *
 * Three node kinds make the graph read like a real codebase map:
 *  - `atlasGroup`  — a titled container that clusters a layer/directory's files
 *  - `atlasFile`   — a file pill (coloured by category), the leaf node
 *  - `atlasLayer`  — a rich Overview card (LAYER badge · complexity · file count)
 *
 * All styling lives in theme.css (.atlas-fnode / .atlas-gnode / .atlas-lcard) so
 * it tracks the active theme. Selection/dim/spotlight + change-overlay flags are
 * passed through `data`.
 */
import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface FileData {
  label: string;
  color: string;
  dim?: boolean;
  hot?: boolean;
  selected?: boolean;
  /** ATLAS-11 change overlay: 'added' | 'modified' | 'untracked' */
  change?: string;
}

export function AtlasFileNode({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as FileData;
  const cls = [
    "atlas-fnode",
    d.dim ? "dim" : "",
    d.hot ? "hot" : "",
    d.selected ? "sel" : "",
    d.change ? `chg chg-${d.change}` : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ borderColor: d.color }} title={d.label}>
      <Handle type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      {d.change ? <span className={`atlas-fnode-dot chg-${d.change}`} /> : null}
      <span className="atlas-fnode-label">{d.label}</span>
      <Handle type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

interface GroupData {
  label: string;
  count: number;
  changed?: number;
}

export function AtlasGroupNode({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as GroupData;
  return (
    <div className="atlas-gnode">
      <div className="atlas-gnode-head">
        <span className="atlas-gnode-title" title={d.label}>{d.label}</span>
        <span className="atlas-gnode-meta">
          {d.changed ? <span className="atlas-gnode-changed" title={`${d.changed} changed`}>{d.changed}●</span> : null}
          <span className="atlas-gnode-count">{d.count}</span>
        </span>
      </div>
    </div>
  );
}

interface LayerData {
  name: string;
  description?: string;
  fileCount: number;
  complexity: string;
  changed?: number;
}

export function AtlasLayerCard({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as LayerData;
  return (
    <div className="atlas-lcard">
      <Handle type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      <div className="atlas-lcard-top">
        <span className="atlas-lcard-tag">LAYER</span>
        <span className={`atlas-lcard-cx cx-${d.complexity}`}>{d.complexity}</span>
      </div>
      <div className="atlas-lcard-title">{d.name}</div>
      {d.description ? <div className="atlas-lcard-desc">{d.description}</div> : null}
      <div className="atlas-lcard-foot">
        <span>{d.fileCount} files</span>
        {d.changed ? <span className="atlas-lcard-changed">{d.changed} changed</span> : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

interface DomainData {
  name: string;
  description?: string;
  entities: string[];
  flows: number;
}

export function AtlasDomainCard({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as DomainData;
  return (
    <div className="atlas-dcard">
      <Handle type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      <div className="atlas-dcard-title">{d.name}</div>
      {d.description ? <div className="atlas-dcard-desc">{d.description}</div> : null}
      {d.entities.length ? (
        <div className="atlas-dcard-section">
          <div className="atlas-dcard-label">Entities</div>
          <div className="atlas-dcard-chips">{d.entities.map((e) => <span key={e} className="atlas-dcard-chip">{e}</span>)}</div>
        </div>
      ) : null}
      <div className="atlas-dcard-foot">{d.flows} flow{d.flows === 1 ? "" : "s"}</div>
      <Handle type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

interface ServiceData {
  module: string;
  portPath: string;
  fileCount: number;
  /** module→module import counts in/out, for the foot line. */
  dependsOn?: number;
  dependedOnBy?: number;
}

export function AtlasServiceCard({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as ServiceData;
  const portFile = d.portPath.slice(d.portPath.lastIndexOf("/") + 1);
  return (
    <div className="atlas-scard">
      <Handle type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      <div className="atlas-scard-top">
        <span className="atlas-scard-tag">SERVICE</span>
        <span className="atlas-scard-port" title={d.portPath}>{portFile}</span>
      </div>
      <div className="atlas-scard-title" title={d.module}>{d.module}</div>
      <div className="atlas-scard-foot">
        <span>{d.fileCount} file{d.fileCount === 1 ? "" : "s"}</span>
        <span className="atlas-scard-deps">
          {d.dependsOn ? <span title={`imports ${d.dependsOn} service(s)`}>→{d.dependsOn}</span> : null}
          {d.dependedOnBy ? <span title={`used by ${d.dependedOnBy} service(s)`}>←{d.dependedOnBy}</span> : null}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

// --- Screens mode (UI-TEST fusion) ---------------------------------------

interface ScreenData {
  title: string;
  route?: string | null;
  count: number;
  hidden?: number;
  selected?: boolean;
  hasFile?: boolean;
}

/** A screen CONTAINER — clusters one screen's data-testid elements. Selectable
 *  (single-click toggles it for "extract selected"); double-click opens its
 *  source file. Mirrors AtlasGroupNode's container chrome. */
export function AtlasScreenNode({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as ScreenData;
  return (
    <div className={`atlas-snode${d.selected ? " sel" : ""}`} title={d.hasFile ? "Double-click to open source" : undefined}>
      <div className="atlas-snode-head">
        <span className="atlas-snode-title" title={d.title}>{d.title}</span>
        <span className="atlas-snode-meta">
          {d.route ? <span className="atlas-snode-route" title={d.route}>{d.route}</span> : null}
          <span className="atlas-snode-count">{d.count}</span>
          {d.hidden ? <span className="atlas-snode-more" title={`${d.hidden} more not drawn — open Command Layer to see all ${d.count}`}>+{d.hidden}</span> : null}
        </span>
      </div>
    </div>
  );
}

interface ElementData {
  label: string; // testID
  action: string;
  color: string;
  selected?: boolean;
}

/** A single interactive element — a leaf pill coloured by its inferred action
 *  (tap/type/navigate/assert). Mirrors AtlasFileNode. */
export function AtlasElementNode({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as ElementData;
  return (
    <div className={`atlas-enode${d.selected ? " sel" : ""}`} style={{ borderColor: d.color }} title={`${d.label} · ${d.action} — double-click to drive in the Browser`}>
      <Handle type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      <span className="atlas-enode-label">{d.label}</span>
      <span className="atlas-enode-act" style={{ color: d.color }}>{d.action}</span>
      <Handle type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

export const ATLAS_NODE_TYPES = {
  atlasFile: AtlasFileNode,
  atlasGroup: AtlasGroupNode,
  atlasLayer: AtlasLayerCard,
  atlasDomain: AtlasDomainCard,
  atlasService: AtlasServiceCard,
  atlasScreen: AtlasScreenNode,
  atlasElement: AtlasElementNode,
};
