/**
 * Diagram — typed, validated system maps (ADR-056 Track A).
 *
 * A diagram is a typed document (five kinds) validated by strict schemas and
 * semantic checks; renderings, receipts, repository evidence, and deltas build
 * on the validated document. Consumers import `@kinqs/brainrouter-core/diagram`;
 * the file layout stays internal.
 */
export { validateDiagram, DIAGRAM_SCHEMAS, DIAGRAM_SHOWCASE_MAX_PRIMARY } from './schema.js';
export { diagramJsonSchema, diagramJsonSchemas, type DiagramJsonSchema } from './jsonSchema.js';
export { renderDiagram, deliverDiagram, type RenderOptions, type RenderResult, type DeliverOptions, type DeliverResult } from './render/render.js';
export { layoutDiagram, METRICS as DIAGRAM_METRICS, type Scene, type PlacedNode, type PlacedEdge } from './render/layout.js';
export { sceneToSvg } from './render/svg.js';
export { verifyDiagramEvidence, type EvidenceVerification, type EvidenceCounts } from './evidence.js';
export { draftDiagramFromAtlas, inferComponentType, type DraftOptions, type DiagramDraft } from './draft.js';
export {
  compareDiagrams,
  diagramDeltaMarkdown,
  renderDiagramDelta,
  readDiagramSpecAtRevision,
  diagramReviewDeltas,
  buildDiagramDeltaContext,
  type DeltaFact,
  type DeltaFactKind,
  type DiagramDeltaReceipt,
  type DiagramReviewDelta,
} from './delta.js';
export {
  diagramsDir,
  diagramPaths,
  isDiagramSlug,
  slugifyDiagramTitle,
  writeDiagramSpec,
  readDiagramSpec,
  listDiagrams,
  DIAGRAM_SLUG_RE,
  type DiagramPaths,
  type DiagramListEntry,
} from './store.js';
export {
  runDiagramChecks,
  buildReceipt,
  canonicalDiagramJson,
  DIAGRAM_CHECK_IDS,
  DIAGRAM_RENDERER_VERSION,
  type DiagramCheck,
  type DiagramCheckId,
  type DiagramReceipt,
} from './render/checks.js';
export {
  DIAGRAM_FIXTURES,
  diagramFixture,
  ARCHITECTURE_FIXTURE,
  WORKFLOW_FIXTURE,
  SEQUENCE_FIXTURE,
  DATAFLOW_FIXTURE,
  LIFECYCLE_FIXTURE,
} from './fixtures.js';
