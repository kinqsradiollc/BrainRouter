// Agent & operations routers: brain introspection, fleet snapshots, integration
// hooks, and governance/audit. Grouped under ./agent/ during the routes
// sub-structure pass; the public router exports are unchanged.
export { brainRouter } from "./brain.js";
export { fleetRouter } from "./fleet.js";
export { hooksRouter } from "./hooks.js";
export { governanceRouter } from "./governance.js";
