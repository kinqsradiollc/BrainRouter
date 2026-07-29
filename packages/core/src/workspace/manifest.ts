/** Public workspace-manifest compatibility facade. */
export * from './manifest/contracts.js';
export {
  createWorkspaceManifest,
  diagnoseWorkspaceManifestCompatibility,
  normalizeWorkspaceManifest,
  serializeWorkspaceManifest,
} from './manifest/policy.js';
export {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  isWorkspaceProfileId,
} from './profiles.js';
export type {
  WorkspaceProfileId,
  WorkspaceProfilePreset,
} from './profiles.js';
export * from './manifest/store.js';
