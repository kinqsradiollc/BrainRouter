/**
 * BrainRouter Diagram IR — typed, validated system maps (ADR-056 D-A1).
 *
 * A diagram is a small typed document, not a picture: five kinds (architecture,
 * workflow, sequence, dataflow, lifecycle), each a set of named elements and the
 * relationships between them, plus optional repository evidence per element
 * (`sources`) and a per-element evidence state (`authored` → `verified` once the
 * repository confirms every source at a revision). HTML/SVG/PNG are RENDERINGS of
 * this document; the document is what is stored, diffed, and reviewed.
 *
 * This is the dependency-free contract shared by the core validator/renderer,
 * the CLI `/diagram` command, the desktop viewer, and the dashboard. camelCase
 * keys, plain-`string` ids — matching the rest of this package. The strict
 * schemas (unknown fields rejected at every level) live in core's `diagram/`
 * subsystem; these types describe the accepted shape.
 */

/** Current diagram document schema version (for migrate-on-read). */
export const DIAGRAM_SCHEMA_VERSION = 1;

/** The five diagram kinds. `architecture` is the only kind that accepts repository evidence verification. */
export const DIAGRAM_KINDS = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** The fixed semantic vocabulary for components / participants / dataflow nodes. */
export const DIAGRAM_COMPONENT_TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"] as const;
export type DiagramComponentType = (typeof DIAGRAM_COMPONENT_TYPES)[number];

/** Visual variant of a component — styling only, never semantics. */
export type DiagramVariant = "default" | "emphasis" | "security" | "dashed";

/** Evidence state of an element: authored by the agent, verified against the repository, or found not to hold. */
export type DiagramEvidence = "authored" | "verified" | "unverified";

/** One repository source an element claims to reflect. `path` is repo-relative POSIX; `revision` is a full 40-hex SHA once verified. */
export interface DiagramSource {
  path: string;
  /** 1-indexed inclusive `[startLine, endLine]`. */
  lines?: [number, number];
  revision?: string;
}

/** A curated reader view: a labelled focus set of element ids (at most five per diagram). */
export interface DiagramView {
  id: string;
  label: string;
  focus: string[];
  note?: string;
}

export interface DiagramMeta {
  title: string;
  subtitle?: string;
  theme?: "auto" | "dark" | "light";
  repository?: { url?: string; revision?: string };
  /** `showcase` (default for new work) caps primary elements at 12 and treats warnings as failures. */
  qualityProfile?: "standard" | "showcase";
  views?: DiagramView[];
}

/** Fields every named element shares. */
export interface DiagramElement {
  id: string;
  label: string;
  description?: string;
  sources?: DiagramSource[];
  evidence?: DiagramEvidence;
}

/** A directed relationship between two elements. */
export interface DiagramRelation extends DiagramElement {
  from: string;
  to: string;
}

// ---- architecture -----------------------------------------------------------

export interface ArchitectureComponent extends DiagramElement {
  type: DiagramComponentType;
  variant?: DiagramVariant;
  /** Optional authored placement hints (0-based). Omitted → automatic layout. */
  column?: number;
  row?: number;
}

export interface ArchitectureBoundary {
  id: string;
  label: string;
  /** Component ids the boundary encloses. */
  wraps: string[];
  kind?: "trust" | "network" | "region" | "group";
}

export interface ArchitectureConnection extends DiagramRelation {
  style?: "sync" | "async" | "data";
  direction?: "forward" | "both";
}

export interface ArchitectureDiagram {
  schemaVersion: number;
  kind: "architecture";
  meta: DiagramMeta;
  components: ArchitectureComponent[];
  boundaries?: ArchitectureBoundary[];
  connections: ArchitectureConnection[];
  /** Ordered component ids forming the one primary path; consecutive ids must be connected. */
  mainPath?: string[];
}

// ---- workflow ---------------------------------------------------------------

export interface WorkflowLane { id: string; label: string }

export interface WorkflowNode extends DiagramElement {
  lane?: string;
  shape?: "step" | "decision" | "start" | "end" | "tool";
}

export interface WorkflowDiagram {
  schemaVersion: number;
  kind: "workflow";
  meta: DiagramMeta;
  lanes?: WorkflowLane[];
  nodes: WorkflowNode[];
  edges: DiagramRelation[];
  mainPath?: string[];
}

// ---- sequence ---------------------------------------------------------------

export interface SequenceParticipant extends DiagramElement {
  type?: DiagramComponentType;
}

export interface SequenceMessage extends DiagramRelation {
  kind?: "sync" | "async" | "return";
}

/** A participant is active from one message to another (inclusive, in message order). */
export interface SequenceActivation {
  participant: string;
  fromMessage: string;
  toMessage: string;
}

export interface SequenceDiagram {
  schemaVersion: number;
  kind: "sequence";
  meta: DiagramMeta;
  participants: SequenceParticipant[];
  /** Ordered top-to-bottom. */
  messages: SequenceMessage[];
  activations?: SequenceActivation[];
}

// ---- dataflow ---------------------------------------------------------------

export interface DataflowStage { id: string; label: string }

export interface DataflowNode extends DiagramElement {
  stage?: string;
  type?: DiagramComponentType;
}

export interface DataflowDiagram {
  schemaVersion: number;
  kind: "dataflow";
  meta: DiagramMeta;
  stages?: DataflowStage[];
  nodes: DataflowNode[];
  flows: DiagramRelation[];
}

// ---- lifecycle --------------------------------------------------------------

export interface LifecycleState extends DiagramElement {
  type?: "initial" | "active" | "waiting" | "terminal" | "failure";
}

export interface LifecycleDiagram {
  schemaVersion: number;
  kind: "lifecycle";
  meta: DiagramMeta;
  states: LifecycleState[];
  transitions: DiagramRelation[];
}

export type Diagram =
  | ArchitectureDiagram
  | WorkflowDiagram
  | SequenceDiagram
  | DataflowDiagram
  | LifecycleDiagram;

// ---- validation contract ----------------------------------------------------

/** One validation diagnostic. `path` is the JSON path of the subject (`components[2].id`), empty for document-level. */
export interface DiagramDiagnostic {
  /** Stable machine code, `diagram/<slug>`. */
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  /** Concrete repairs the author may choose from. */
  supportedFixes?: string[];
}

export interface DiagramValidation {
  ok: boolean;
  kind?: DiagramKind;
  /** Present only when `ok` — the parsed, normalised document. */
  diagram?: Diagram;
  diagnostics: DiagramDiagnostic[];
  errorCount: number;
  warningCount: number;
}

// ---- guards -----------------------------------------------------------------

export function isDiagramKind(v: unknown): v is DiagramKind {
  return typeof v === "string" && (DIAGRAM_KINDS as readonly string[]).includes(v);
}

export function isDiagramComponentType(v: unknown): v is DiagramComponentType {
  return typeof v === "string" && (DIAGRAM_COMPONENT_TYPES as readonly string[]).includes(v);
}

export function diagramKinds(): DiagramKind[] {
  return [...DIAGRAM_KINDS];
}

/** The element arrays a kind carries, in authored order — the shared vocabulary for renderers, deltas, and docs. */
export function diagramElementArrays(kind: DiagramKind): string[] {
  switch (kind) {
    case "architecture": return ["components", "boundaries", "connections"];
    case "workflow": return ["lanes", "nodes", "edges"];
    case "sequence": return ["participants", "messages", "activations"];
    case "dataflow": return ["stages", "nodes", "flows"];
    case "lifecycle": return ["states", "transitions"];
  }
}
