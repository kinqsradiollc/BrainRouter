/**
 * Atlas service layer — the per-workspace port over the codebase knowledge-graph
 * capability, plus deterministic service-port detection.
 */
export {
  createAtlasService,
  AtlasService,
  type IAtlasService,
  type AtlasGraphStats,
} from "./service.js";
export {
  detectServicePorts,
  isServicePortPath,
  moduleForServicePath,
  type ServicePort,
  type ServicePortMap,
} from "./servicePorts.js";
